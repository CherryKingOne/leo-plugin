//! Core service contracts used across plugins.
//!
//! Services are shared, revocable capabilities registered on the
//! [`Context`](crate::Context). Keeping the contracts here lets mutually
//! independent plugins exchange typed handles without importing each other's
//! source (forbidden by `PROTOCOL.md`).

use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde_json::Value;

use crate::context::Disposer;
use crate::error::Result;
use crate::tool::{Tool, ToolContext, ToolResult};

/// Static description of a registered tool, for `tools.list()` and diagnostics.
#[derive(Clone, Debug)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub permissions: Option<Value>,
}

/// A request to execute a tool by name.
#[derive(Clone, Debug)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

impl ToolCall {
    pub fn new(name: impl Into<String>, arguments: Value) -> Self {
        Self {
            name: name.into(),
            arguments,
        }
    }
}

/// The tool registry and execution pipeline (`tools` service).
#[async_trait]
pub trait ToolsService: Send + Sync {
    /// Register a tool. Returns a disposer that unregisters it.
    async fn register(&self, tool: Arc<dyn Tool>) -> Result<Disposer>;
    /// Execute a tool by name through the (approval/guard/audit) pipeline.
    async fn execute(&self, call: ToolCall, ctx: ToolContext) -> ToolResult;
    /// Execute several tools in order.
    async fn execute_batch(&self, calls: Vec<ToolCall>, ctx: ToolContext) -> Vec<ToolResult>;
    /// List registered tools.
    fn list(&self) -> Vec<ToolInfo>;
}

/// Default in-memory [`ToolsService`], used by the host and tests.
#[derive(Clone, Default)]
pub struct BasicTools {
    entries: Arc<RwLock<Vec<(String, Arc<dyn Tool>)>>>,
}

impl BasicTools {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

#[async_trait]
impl ToolsService for BasicTools {
    async fn register(&self, tool: Arc<dyn Tool>) -> Result<Disposer> {
        let name = tool.name().to_string();
        {
            let mut entries = self.entries.write();
            entries.retain(|(n, _)| n != &name);
            entries.push((name.clone(), tool));
        }
        let entries = self.entries.clone();
        Ok(Box::pin(async move {
            entries.write().retain(|(n, _)| n != &name);
        }))
    }

    async fn execute(&self, call: ToolCall, ctx: ToolContext) -> ToolResult {
        let tool = {
            let entries = self.entries.read();
            entries
                .iter()
                .find(|(n, _)| n == &call.name)
                .map(|(_, t)| t.clone())
        };
        match tool {
            Some(tool) => tool.execute(call.arguments, ctx).await,
            None => ToolResult::error(format!("tool not found: {}", call.name)),
        }
    }

    async fn execute_batch(&self, calls: Vec<ToolCall>, ctx: ToolContext) -> Vec<ToolResult> {
        let mut out = Vec::with_capacity(calls.len());
        for call in calls {
            out.push(self.execute(call, ctx.clone()).await);
        }
        out
    }

    fn list(&self) -> Vec<ToolInfo> {
        self.entries
            .read()
            .iter()
            .map(|(name, tool)| ToolInfo {
                name: name.clone(),
                description: tool.description().to_string(),
                parameters: tool.parameters(),
                permissions: tool.permissions(),
            })
            .collect()
    }
}

/// A model request.
#[derive(Clone, Debug, Default)]
pub struct LlmRequest {
    pub model: String,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub reasoning: Option<Value>,
    pub stream: bool,
}

/// A model response.
#[derive(Clone, Debug, Default)]
pub struct LlmResponse {
    pub text: String,
    pub tool_calls: Vec<Value>,
    pub usage: Value,
    pub raw: Value,
}

/// The model seam (`llm` service). Providers register drivers; the agent loop
/// calls `complete`.
#[async_trait]
pub trait LlmService: Send + Sync {
    async fn complete(&self, req: LlmRequest) -> Result<LlmResponse>;
    fn models(&self) -> Vec<Value> {
        Vec::new()
    }
}

/// A system-prompt section contributed by a plugin.
pub struct ContextSection {
    pub id: String,
    pub layer: String,
    pub priority: i32,
    /// Render the section text (or `None` to omit it).
    pub render: Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

impl std::fmt::Debug for ContextSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContextSection")
            .field("id", &self.id)
            .field("layer", &self.layer)
            .field("priority", &self.priority)
            .finish()
    }
}

/// Context construction and compression (`context` service).
pub trait ContextService: Send + Sync {
    fn register_section(&self, section: ContextSection) -> Disposer;
    fn sections(&self) -> Vec<(String, String, i32)>;
}

/// Default in-memory [`ContextService`].
#[derive(Clone, Default)]
pub struct BasicContextService {
    sections: Arc<RwLock<Vec<(String, ContextSection)>>>,
}

impl BasicContextService {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ContextService for BasicContextService {
    fn register_section(&self, section: ContextSection) -> Disposer {
        let id = section.id.clone();
        self.sections.write().push((id.clone(), section));
        let sections = self.sections.clone();
        Box::pin(async move {
            sections.write().retain(|(n, _)| n != &id);
        })
    }

    fn sections(&self) -> Vec<(String, String, i32)> {
        self.sections
            .read()
            .iter()
            .map(|(_, s)| (s.id.clone(), s.layer.clone(), s.priority))
            .collect()
    }
}

/// A human approval request.
#[derive(Clone, Debug)]
pub struct ApprovalRequest {
    pub tool: String,
    pub summary: String,
    pub agent_id: Option<String>,
    pub session_key: Option<String>,
}

/// The operator's decision on an approval request.
#[derive(Clone, Debug)]
pub enum ApprovalDecision {
    Approve,
    Deny(String),
}

/// Human-in-the-loop approval (`approval` service).
#[async_trait]
pub trait ApprovalService: Send + Sync {
    async fn request(&self, req: ApprovalRequest, ctx: ToolContext) -> Result<ApprovalDecision>;
}

/// A denied-by-default approval service (fail closed), used when none is set.
#[derive(Clone, Copy, Default)]
pub struct DenyApproval;

#[async_trait]
impl ApprovalService for DenyApproval {
    async fn request(&self, _req: ApprovalRequest, _ctx: ToolContext) -> Result<ApprovalDecision> {
        Ok(ApprovalDecision::Deny("no approval service available".into()))
    }
}

/// Append-only session log (`sessions` service).
#[async_trait]
pub trait SessionsService: Send + Sync {
    async fn append(&self, entry: Value) -> Result<()>;
}

/// Credential lookup (`credentials` service). `describe` must not leak secrets.
#[async_trait]
pub trait CredentialsService: Send + Sync {
    async fn get(&self, key: &str) -> Option<String>;
    fn describe(&self) -> Vec<String> {
        Vec::new()
    }
}