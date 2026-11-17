//! The tool protocol.
//!
//! A tool is a model-callable function with a name, description, JSON-Schema
//! parameters and an async `execute`. Tools must honour cancellation via
//! [`ToolContext::signal`] and report business failures as an error *result*
//! (`is_error = true`) instead of panicking.

use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// Per-invocation context passed to [`Tool::execute`].
#[derive(Clone, Debug, Default)]
pub struct ToolContext {
    /// Cancellation token; stop work and release resources when cancelled.
    pub signal: CancellationToken,
    /// The agent that invoked the tool, if known.
    pub agent_id: Option<String>,
    /// Tenant scope, if any.
    pub tenant: Option<String>,
}

impl ToolContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_agent(mut self, agent_id: impl Into<String>) -> Self {
        self.agent_id = Some(agent_id.into());
        self
    }

    pub fn is_cancelled(&self) -> bool {
        self.signal.is_cancelled()
    }
}

/// The result of a tool invocation.
#[derive(Clone, Debug)]
pub struct ToolResult {
    /// Structured result returned to the model.
    pub output: Value,
    /// `true` when the tool failed (reported to the model, not thrown).
    pub is_error: bool,
    /// `true` to terminate the agent loop after this tool.
    pub terminate: bool,
}

impl ToolResult {
    pub fn ok(output: impl Into<Value>) -> Self {
        Self {
            output: output.into(),
            is_error: false,
            terminate: false,
        }
    }

    pub fn text(message: impl Into<String>) -> Self {
        Self::ok(Value::String(message.into()))
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            output: Value::String(message.into()),
            is_error: true,
            terminate: false,
        }
    }

    pub fn terminate(message: impl Into<String>) -> Self {
        Self {
            output: Value::String(message.into()),
            is_error: false,
            terminate: true,
        }
    }
}

/// A model-callable tool.
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    /// Tool name: `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`, snake_case.
    fn name(&self) -> &str;
    /// Written for the model: what it does, when to use it, when not to.
    fn description(&self) -> &str;
    /// JSON Schema for the tool parameters.
    fn parameters(&self) -> Value;
    /// Optional permission/side-effect declaration (e.g. `{"kind":"fs.write"}`).
    fn permissions(&self) -> Option<Value> {
        None
    }
    /// Execute the tool.
    async fn execute(&self, args: Value, ctx: ToolContext) -> ToolResult;
}