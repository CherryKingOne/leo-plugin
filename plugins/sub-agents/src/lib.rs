//! Rust rewrite of `leo-plugin-sub-agents`.
//!
//! Delegates a task to a child agent with its own context and aggregates the
//! result. Child tool sets are a subset of the parent's and enforced by a guard.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use leo_plugin_sdk::{
    Context, Plugin, PluginError, Result, Tool, ToolContext, ToolResult,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentsConfig {
    pub max_depth: u32,
    pub max_concurrent: u32,
    pub max_steps: u32,
    pub timeout_ms: u64,
    pub load_agent_files: bool,
    pub agents: HashMap<String, AgentProfile>,
}

impl Default for SubAgentsConfig {
    fn default() -> Self {
        Self {
            max_depth: 1,
            max_concurrent: 4,
            max_steps: 10,
            timeout_ms: 120_000,
            load_agent_files: true,
            agents: HashMap::new(),
        }
    }
}

/// A child-agent profile.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub model: Option<String>,
    /// Empty means "all parent tools".
    pub tools: Vec<String>,
    pub source: String,
}

impl Default for AgentProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            prompt: String::new(),
            model: None,
            tools: Vec::new(),
            source: "builtin".into(),
        }
    }
}

pub fn default_profiles() -> HashMap<String, AgentProfile> {
    let mut map = HashMap::new();
    map.insert(
        "general".into(),
        AgentProfile {
            id: "general".into(),
            name: "General".into(),
            description: "A general-purpose child agent with the parent's tools.".into(),
            prompt: "You are a focused sub-agent. Complete the delegated task and report concisely.".into(),
            model: None,
            tools: Vec::new(),
            source: "builtin".into(),
        },
    );
    map
}

/// Parse a minimal YAML frontmatter block (`key: value` lines).
pub fn parse_frontmatter(text: &str) -> (HashMap<String, String>, String) {
    let mut meta = HashMap::new();
    let mut body = text;
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let front = &rest[..end];
            body = &rest[end + 4..];
            for line in front.lines() {
                if let Some((key, value)) = line.split_once(':') {
                    meta.insert(key.trim().to_string(), value.trim().to_string());
                }
            }
        }
    }
    (meta, body.to_string())
}

/// Load `*.md` agent profiles from a directory.
pub fn load_agent_dir(dir: &Path) -> HashMap<String, AgentProfile> {
    let mut out = HashMap::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let (meta, body) = parse_frontmatter(&text);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("agent")
            .to_string();
        let id = meta.get("name").cloned().unwrap_or_else(|| stem.clone());
        let tools = meta
            .get("tools")
            .map(|raw| {
                raw.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        out.insert(
            id.clone(),
            AgentProfile {
                id,
                name: meta.get("name").cloned().unwrap_or(stem),
                description: meta.get("description").cloned().unwrap_or_default(),
                prompt: meta.get("prompt").cloned().unwrap_or(body),
                model: meta.get("model").cloned(),
                tools,
                source: "file".into(),
            },
        );
    }
    out
}

#[derive(Clone, Debug)]
pub struct SubAgentResult {
    pub agent: String,
    pub text: String,
    pub steps: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Clone, Debug)]
pub struct ChildAgent {
    pub agent: String,
    pub tools: Vec<String>,
}

/// The sub-agent service (`subAgents`).
#[derive(Clone)]
pub struct SubAgentService {
    config: SubAgentsConfig,
    profiles: Arc<RwLock<HashMap<String, AgentProfile>>>,
    children: Arc<RwLock<HashMap<String, ChildAgent>>>,
}

impl SubAgentService {
    pub fn new(config: SubAgentsConfig) -> Self {
        let mut profiles = default_profiles();
        for (id, profile) in &config.agents {
            profiles.insert(id.clone(), profile.clone());
        }
        Self {
            config,
            profiles: Arc::new(RwLock::new(profiles)),
            children: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn profiles(&self) -> HashMap<String, AgentProfile> {
        self.profiles.read().clone()
    }

    pub fn profile(&self, id: &str) -> Option<AgentProfile> {
        self.profiles.read().get(id).cloned()
    }

    pub fn register_child(&self, agent_id: &str, child: ChildAgent) {
        self.children.write().insert(agent_id.to_string(), child);
    }

    /// Run a delegated task (deterministic simulation; a host agent loop can
    /// replace this in a full integration).
    pub fn run(&self, agent: &str, task: &str, model: Option<&str>) -> Result<SubAgentResult> {
        let profile = self
            .profile(agent)
            .ok_or_else(|| PluginError::other(format!("unknown agent profile: {agent}")))?;
        let _ = model.or(profile.model.as_deref());
        Ok(SubAgentResult {
            agent: profile.name,
            text: format!("[sub-agent {agent}] {task}"),
            steps: 1,
            input_tokens: 0,
            output_tokens: 0,
        })
    }
}

/// The `task` tool.
pub struct TaskTool {
    service: Arc<SubAgentService>,
    max_depth: u32,
    depth: RwLock<HashMap<String, u32>>,
}

impl TaskTool {
    pub fn new(service: Arc<SubAgentService>, max_depth: u32) -> Self {
        Self {
            service,
            max_depth,
            depth: RwLock::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl Tool for TaskTool {
    fn name(&self) -> &str {
        "task"
    }

    fn description(&self) -> &str {
        "Delegate a task to a sub-agent with its own context and return its result."
    }

    fn parameters(&self) -> Value {
        let agents: Vec<Value> = self
            .service
            .profiles()
            .keys()
            .map(|id| json!(id))
            .collect();
        json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "What the sub-agent should do" },
                "agent": { "type": "string", "enum": agents, "description": "Agent profile" },
                "model": { "type": "string", "description": "Optional model override" }
            },
            "required": ["task"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, args: Value, ctx: ToolContext) -> ToolResult {
        let task = args.get("task").and_then(Value::as_str).unwrap_or_default();
        let agent = args
            .get("agent")
            .and_then(Value::as_str)
            .unwrap_or("general");
        let model = args.get("model").and_then(Value::as_str);
        let depth = {
            let mut depths = self.depth.write();
            let entry = depths.entry(ctx.agent_id.clone().unwrap_or_default()).or_insert(0);
            *entry += 1;
            *entry
        };
        if depth > self.max_depth {
            return ToolResult::error(format!(
                "max sub-agent depth ({}) exceeded",
                self.max_depth
            ));
        }
        match self.service.run(agent, task, model) {
            Ok(result) => ToolResult::ok(json!({
                "agent": result.agent,
                "text": result.text,
                "steps": result.steps,
                "usage": { "inputTokens": result.input_tokens, "outputTokens": result.output_tokens }
            })),
            Err(err) => ToolResult::error(err.to_string()),
        }
    }
}

pub fn load_config(plugin_config: &Value) -> SubAgentsConfig {
    let mut config: SubAgentsConfig =
        serde_json::from_value(plugin_config.clone()).unwrap_or_default();
    if config.load_agent_files {
        let paths = leo_plugin_sdk::LeoPaths::detect();
        let mut files = HashMap::new();
        files.extend(load_agent_dir(&paths.user_dir.join("agents")));
        if let Some(project) = &paths.project_dir {
            files.extend(load_agent_dir(&project.join("agents")));
        }
        for (id, profile) in files {
            config.agents.entry(id).or_insert(profile);
        }
    }
    config
}

#[derive(Default)]
pub struct SubAgentsPlugin;

#[async_trait]
impl Plugin for SubAgentsPlugin {
    fn name(&self) -> &str {
        "leo-plugin-sub-agents"
    }

    fn inject(&self) -> Vec<String> {
        vec!["agentLoop".into(), "tools".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec!["agents/".into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let service = Arc::new(SubAgentService::new(config.clone()));

        // Enforce child tool subsets via the unbypassable guard.
        let guard_service = service.clone();
        ctx.on("tools/guard", move |payload: Value| {
            let child_id = payload
                .get("agentId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let tool = payload
                .get("tool")
                .and_then(|t| t.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let deny = guard_service
                .children
                .read()
                .get(&child_id)
                .map(|child| !child.tools.is_empty() && !child.tools.iter().any(|t| t == &tool))
                .unwrap_or(false);
            async move {
                if deny {
                    json!({ "deny": format!("Tool \"{tool}\" is not available to sub-agent \"{child_id}\"") })
                } else {
                    Value::Null
                }
            }
        });

        let tool: Arc<dyn Tool> = Arc::new(TaskTool::new(service.clone(), config.max_depth));
        ctx.register_tool(tool).await?;
        ctx.provide("subAgents", service);
        Ok(())
    }
}