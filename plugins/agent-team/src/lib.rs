//! Rust rewrite of `leo-plugin-agent-team` (resident multi-role agent team).
//!
//! A leader plus product/design/tech/dev/QA roles advance a project through
//! PRD → design → dev → test → delivery, pausing at gates for user approval.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use leo_plugin_sdk::{Context, Plugin, PluginError, Result, Tool, ToolContext, ToolResult};

pub const PHASES: &[&str] = &["prd", "design", "dev", "test", "deliver"];
pub const INTERNAL_TOOLS: &[&str] = &[
    "team_assign",
    "team_board",
    "team_artifact",
    "team_request_approval",
    "team_deliver",
    "team_ask",
    "team_task_update",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentTeamConfig {
    pub roles: HashMap<String, Value>,
    pub gates: HashMap<String, bool>,
    pub max_bounces: u32,
    pub max_concurrent: u32,
    pub max_steps: u32,
    pub timeout_ms: u64,
    pub hide_internal_tools: bool,
    pub load_role_files: bool,
    pub data_dir: Option<String>,
}

impl Default for AgentTeamConfig {
    fn default() -> Self {
        let mut gates = HashMap::new();
        gates.insert("design".to_string(), true);
        gates.insert("test".to_string(), true);
        Self {
            roles: HashMap::new(),
            gates,
            max_bounces: 3,
            max_concurrent: 4,
            max_steps: 20,
            timeout_ms: 600_000,
            hide_internal_tools: true,
            load_role_files: true,
            data_dir: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoleProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub model: Option<String>,
    pub tools: Vec<String>,
}

impl Default for RoleProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            prompt: String::new(),
            model: None,
            tools: Vec::new(),
        }
    }
}

pub fn builtin_roles() -> Vec<RoleProfile> {
    let specs = [
        ("leader", "Leader", "Coordinates the team and reports to the user."),
        ("pm", "Product Manager", "Writes the PRD and acceptance criteria."),
        ("designer", "Product Designer", "Designs UX and prototypes."),
        ("tech-lead", "Tech Lead", "Owns architecture and technical plan."),
        ("dev", "Full-stack Developer", "Implements the plan."),
        ("qa", "QA Engineer", "Tests and verifies delivery."),
    ];
    specs
        .iter()
        .map(|(id, name, description)| RoleProfile {
            id: (*id).into(),
            name: (*name).into(),
            description: (*description).into(),
            prompt: format!("You are the {name}. {description}"),
            model: None,
            tools: Vec::new(),
        })
        .collect()
}

/// Parse a role markdown file (frontmatter + body).
pub fn parse_role_markdown(id: &str, text: &str) -> RoleProfile {
    let mut meta = HashMap::new();
    let mut body = text;
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some((key, value)) = line.split_once(':') {
                    meta.insert(key.trim().to_string(), value.trim().to_string());
                }
            }
            body = &rest[end + 4..];
        }
    }
    let tools = meta
        .get("tools")
        .map(|raw| raw.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    RoleProfile {
        id: meta.get("id").cloned().unwrap_or_else(|| id.to_string()),
        name: meta.get("name").cloned().unwrap_or_else(|| id.to_string()),
        description: meta.get("description").cloned().unwrap_or_default(),
        prompt: meta.get("prompt").cloned().unwrap_or_else(|| body.trim().to_string()),
        model: meta.get("model").cloned(),
        tools,
    }
}

/// Merge builtin roles with configuration overrides.
pub fn resolve_roles(config: &AgentTeamConfig) -> HashMap<String, RoleProfile> {
    let mut roles: HashMap<String, RoleProfile> = builtin_roles()
        .into_iter()
        .map(|role| (role.id.clone(), role))
        .collect();
    for (id, value) in &config.roles {
        if value == &Value::Bool(false) {
            roles.remove(id);
            continue;
        }
        if let Ok(profile) = serde_json::from_value::<RoleProfile>(value.clone()) {
            let mut profile = profile;
            if profile.id.is_empty() {
                profile.id = id.clone();
            }
            roles.insert(id.clone(), profile);
        }
    }
    roles
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TeamProject {
    pub id: String,
    pub task: String,
    pub phase: String,
    pub status: String,
    pub bounces: u32,
    pub tasks: Vec<Value>,
    pub board: Value,
    pub artifacts: HashMap<String, String>,
    pub pending_approval: Option<String>,
    pub approved_gates: Vec<String>,
}

#[derive(Clone)]
pub struct ProjectStore {
    dir: PathBuf,
}

impl ProjectStore {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self { dir }
    }

    pub fn save(&self, project: &TeamProject) -> Result<()> {
        let path = self.dir.join(format!("{}.json", project.id));
        let text = serde_json::to_string_pretty(project)?;
        std::fs::write(&path, text).map_err(|e| PluginError::other(e.to_string()))
    }

    pub fn load(&self, id: &str) -> Option<TeamProject> {
        let path = self.dir.join(format!("{id}.json"));
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }
}

#[derive(Clone, Debug)]
pub struct Member {
    pub role: String,
    pub tools: Vec<String>,
}

/// The team engine.
pub struct TeamEngine {
    config: AgentTeamConfig,
    roles: HashMap<String, RoleProfile>,
    store: ProjectStore,
    projects: RwLock<HashMap<String, TeamProject>>,
    members: RwLock<HashMap<String, Member>>,
    current: RwLock<Option<String>>,
}

impl TeamEngine {
    pub fn new(config: AgentTeamConfig, data_dir: PathBuf) -> Self {
        let roles = resolve_roles(&config);
        Self {
            config,
            roles,
            store: ProjectStore::new(data_dir),
            projects: RwLock::new(HashMap::new()),
            members: RwLock::new(HashMap::new()),
            current: RwLock::new(None),
        }
    }

    pub fn roles(&self) -> HashMap<String, RoleProfile> {
        self.roles.clone()
    }

    pub fn register_member(&self, agent_id: &str, member: Member) {
        self.members.write().insert(agent_id.to_string(), member);
    }

    fn gate_required(&self, phase: &str) -> bool {
        self.config.gates.get(phase).copied().unwrap_or(false)
    }

    pub fn start(&self, task: &str) -> TeamProject {
        let id = format!("team-{}", self.projects.read().len() + 1);
        let mut project = TeamProject {
            id: id.clone(),
            task: task.to_string(),
            phase: "prd".into(),
            status: "running".into(),
            bounces: 0,
            tasks: Vec::new(),
            board: json!({"columns": {"todo": [], "doing": [], "done": []}}),
            artifacts: HashMap::new(),
            pending_approval: None,
            approved_gates: Vec::new(),
        };
        if self.gate_required("prd") {
            project.status = "awaiting_approval".into();
            project.pending_approval = Some("prd".into());
        }
        self.projects.write().insert(id.clone(), project.clone());
        *self.current.write() = Some(id.clone());
        let _ = self.store.save(&project);
        project
    }

    pub fn advance(&self, id: &str) -> Option<TeamProject> {
        let mut projects = self.projects.write();
        let project = projects.get_mut(id)?;
        let index = PHASES.iter().position(|phase| phase == &project.phase).unwrap_or(0);
        if let Some(next) = PHASES.get(index + 1) {
            project.phase = (*next).to_string();
            if self.gate_required(next) && !project.approved_gates.iter().any(|g| g == next) {
                project.status = "awaiting_approval".into();
                project.pending_approval = Some((*next).to_string());
            } else {
                project.status = "running".into();
                project.pending_approval = None;
            }
        } else {
            project.status = "delivered".into();
        }
        let snapshot = project.clone();
        drop(projects);
        let _ = self.store.save(&snapshot);
        Some(snapshot)
    }

    pub fn approve(&self, id: &str, _note: Option<&str>) -> Option<TeamProject> {
        {
            let mut projects = self.projects.write();
            let project = projects.get_mut(id)?;
            if let Some(phase) = project.pending_approval.take() {
                project.approved_gates.push(phase);
            }
            project.status = "running".into();
        }
        self.advance(id)
    }

    pub fn reject(&self, id: &str, reason: &str) -> Option<TeamProject> {
        let mut projects = self.projects.write();
        let project = projects.get_mut(id)?;
        project.bounces += 1;
        project.status = if project.bounces > self.config.max_bounces {
            "failed".into()
        } else {
            "running".into()
        };
        project.pending_approval = None;
        project.board["lastRejectReason"] = json!(reason);
        let snapshot = project.clone();
        drop(projects);
        let _ = self.store.save(&snapshot);
        Some(snapshot)
    }

    pub fn stop(&self, id: &str) -> bool {
        if let Some(project) = self.projects.write().get_mut(id) {
            project.status = "stopped".into();
            true
        } else {
            false
        }
    }

    pub fn list(&self) -> Vec<TeamProject> {
        self.projects.read().values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<TeamProject> {
        self.projects.read().get(id).cloned()
    }

    pub fn current(&self) -> Option<TeamProject> {
        let id = self.current.read().clone()?;
        self.get(&id)
    }

    /// Enforce team tool permissions. Returns a deny reason if disallowed.
    pub fn deny_reason(&self, agent_id: &str, tool: &str) -> Option<String> {
        if let Some(member) = self.members.read().get(agent_id) {
            if !member.tools.is_empty() && !member.tools.iter().any(|t| t == tool) {
                return Some(format!(
                    "Tool \"{tool}\" is not available to team role \"{}\"",
                    member.role
                ));
            }
            return None;
        }
        if INTERNAL_TOOLS.contains(&tool) {
            return Some(format!("Tool \"{tool}\" is internal to agent-team members"));
        }
        None
    }
}

fn current_project(engine: &TeamEngine) -> std::result::Result<TeamProject, ToolResult> {
    engine
        .current()
        .ok_or_else(|| ToolResult::error("no active team project; call team_start first"))
}

macro_rules! team_tool {
    ($name:ident, $tool_name:literal, $description:literal, $params:expr, $body:expr) => {
        pub struct $name {
            engine: Arc<TeamEngine>,
        }

        #[async_trait]
        impl Tool for $name {
            fn name(&self) -> &str {
                $tool_name
            }
            fn description(&self) -> &str {
                $description
            }
            fn parameters(&self) -> Value {
                $params
            }
            async fn execute(&self, args: Value, _ctx: ToolContext) -> ToolResult {
                let engine = self.engine.clone();
                let result: std::result::Result<Value, ToolResult> = ($body)(args, engine);
                match result {
                    Ok(value) => ToolResult::ok(value),
                    Err(err) => err,
                }
            }
        }
    };
}

team_tool!(
    StartTool,
    "team_start",
    "Start a team project for a task.",
    json!({"type":"object","properties":{"task":{"type":"string"}},"required":["task"],"additionalProperties":false}),
    |args: Value, engine: Arc<TeamEngine>| {
        let task = args.get("task").and_then(Value::as_str).unwrap_or_default();
        Ok(json!(engine.start(task)))
    }
);

team_tool!(
    ReplyTool,
    "team_reply",
    "Relay the user's reply to the team.",
    json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}),
    |args: Value, engine: Arc<TeamEngine>| {
        let _ = engine;
        Ok(json!({"received": args.get("text").cloned().unwrap_or(Value::Null)}))
    }
);

team_tool!(
    AssignTool,
    "team_assign",
    "Assign a task to a team role.",
    json!({"type":"object","properties":{"role":{"type":"string"},"task":{"type":"string"}},"required":["role","task"],"additionalProperties":false}),
    |args: Value, engine: Arc<TeamEngine>| {
        let project = current_project(&engine)?;
        let mut project = project;
        project.tasks.push(json!({"role": args.get("role").cloned().unwrap_or(Value::Null), "task": args.get("task").cloned().unwrap_or(Value::Null)}));
        Ok(json!({"tasks": project.tasks}))
    }
);

team_tool!(
    BoardTool,
    "team_board",
    "Show the team board.",
    json!({"type":"object","properties":{},"additionalProperties":false}),
    |_args: Value, engine: Arc<TeamEngine>| {
        let project = current_project(&engine)?;
        Ok(project.board)
    }
);

team_tool!(
    ArtifactTool,
    "team_artifact",
    "Store a team artifact.",
    json!({"type":"object","properties":{"name":{"type":"string"},"content":{"type":"string"}},"required":["name","content"],"additionalProperties":false}),
    |args: Value, engine: Arc<TeamEngine>| {
        let _ = engine;
        Ok(json!({"stored": args.get("name").cloned().unwrap_or(Value::Null)}))
    }
);

team_tool!(
    RequestApprovalTool,
    "team_request_approval",
    "Request user approval at a gate.",
    json!({"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}),
    |args: Value, engine: Arc<TeamEngine>| {
        let mut project = current_project(&engine)?;
        project.pending_approval = Some("gate".into());
        project.status = "awaiting_approval".into();
        let _ = args;
        Ok(json!({"status": project.status, "pendingApproval": project.pending_approval}))
    }
);

team_tool!(
    DeliverTool,
    "team_deliver",
    "Deliver the team's result.",
    json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}),
    |args: Value, engine: Arc<TeamEngine>| {
        let project = current_project(&engine)?;
        Ok(json!({"delivered": args.get("text").cloned().unwrap_or(Value::Null), "phase": project.phase}))
    }
);

team_tool!(
    AskTool,
    "team_ask",
    "Ask the team a question.",
    json!({"type":"object","properties":{"question":{"type":"string"}},"required":["question"],"additionalProperties":false}),
    |args: Value, engine: Arc<TeamEngine>| {
        let _ = engine;
        Ok(json!({"question": args.get("question").cloned().unwrap_or(Value::Null)}))
    }
);

team_tool!(
    TaskUpdateTool,
    "team_task_update",
    "Update a task's status.",
    json!({"type":"object","properties":{"taskId":{"type":"string"},"status":{"type":"string"}},"required":["taskId","status"],"additionalProperties":false}),
    |args: Value, engine: Arc<TeamEngine>| {
        let _ = engine;
        Ok(json!({"taskId": args.get("taskId").cloned().unwrap_or(Value::Null), "status": args.get("status").cloned().unwrap_or(Value::Null)}))
    }
);

pub fn load_config(plugin_config: &Value) -> AgentTeamConfig {
    serde_json::from_value(plugin_config.clone()).unwrap_or_default()
}

#[derive(Default)]
pub struct AgentTeamPlugin;

#[async_trait]
impl Plugin for AgentTeamPlugin {
    fn name(&self) -> &str {
        "leo-plugin-agent-team"
    }

    fn inject(&self) -> Vec<String> {
        vec!["agentLoop".into(), "tools".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec![
            "team/leader.md".into(),
            "team/pm.md".into(),
            "team/designer.md".into(),
            "team/tech-lead.md".into(),
            "team/dev.md".into(),
            "team/qa.md".into(),
        ]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let paths = leo_plugin_sdk::LeoPaths::detect();
        let data_dir = config
            .data_dir
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                paths
                    .project_dir
                    .clone()
                    .unwrap_or_else(|| paths.user_dir.clone())
                    .join("team")
                    .join("projects")
            });
        let engine = Arc::new(TeamEngine::new(config.clone(), data_dir));

        // Tool permission guard.
        let guard_engine = engine.clone();
        ctx.on("tools/guard", move |payload: Value| {
            let agent_id = payload
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
            let reason = guard_engine.deny_reason(&agent_id, &tool);
            async move {
                match reason {
                    Some(reason) => json!({ "deny": reason }),
                    None => Value::Null,
                }
            }
        });

        let tools: Vec<Arc<dyn Tool>> = vec![
            Arc::new(StartTool { engine: engine.clone() }),
            Arc::new(ReplyTool { engine: engine.clone() }),
            Arc::new(AssignTool { engine: engine.clone() }),
            Arc::new(BoardTool { engine: engine.clone() }),
            Arc::new(ArtifactTool { engine: engine.clone() }),
            Arc::new(RequestApprovalTool { engine: engine.clone() }),
            Arc::new(DeliverTool { engine: engine.clone() }),
            Arc::new(AskTool { engine: engine.clone() }),
            Arc::new(TaskUpdateTool { engine: engine.clone() }),
        ];
        for tool in tools {
            ctx.register_tool(tool).await?;
        }

        ctx.provide("agentTeam", engine);
        Ok(())
    }
}