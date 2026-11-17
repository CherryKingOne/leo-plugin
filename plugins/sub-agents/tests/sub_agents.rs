use std::io::Write;
use std::sync::Arc;

use leo_plugin_sdk::{
    json, Context, NullLogger, Plugin, Tool, ToolContext, ToolsService,
};
use leo_plugin_sub_agents::{
    default_profiles, load_agent_dir, parse_frontmatter, ChildAgent, SubAgentsConfig,
    SubAgentService, SubAgentsPlugin, TaskTool,
};

#[test]
fn defaults_and_profiles() {
    let config = SubAgentsConfig::default();
    assert_eq!(config.max_depth, 1);
    assert!(default_profiles().contains_key("general"));
}

#[test]
fn frontmatter_parsing() {
    let text = "---\nname: explorer\ndescription: read only\ntools: read_file, grep\n---\nBody here";
    let (meta, body) = parse_frontmatter(text);
    assert_eq!(meta.get("name").unwrap(), "explorer");
    assert_eq!(meta.get("tools").unwrap(), "read_file, grep");
    assert!(body.contains("Body here"));
}

#[test]
fn load_agent_dir_reads_md() {
    let dir = std::env::temp_dir().join(format!("leo-subagents-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut file = std::fs::File::create(dir.join("explorer.md")).unwrap();
    writeln!(file, "---\nname: explorer\ntools: read_file\n---\nYou explore.").unwrap();
    let profiles = load_agent_dir(&dir);
    assert!(profiles.contains_key("explorer"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn guard_enforces_child_tools() {
    let service = Arc::new(SubAgentService::new(SubAgentsConfig::default()));
    service.register_child(
        "agent-1",
        ChildAgent { agent: "explorer".into(), tools: vec!["read_file".into()] },
    );
    let tool = TaskTool::new(service, 1);
    assert_eq!(tool.name(), "task");
    let result = tool
        .execute(json!({"task": "look around"}), ToolContext::new())
        .await;
    assert!(!result.is_error);
}

#[tokio::test]
async fn plugin_registers_task_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    SubAgentsPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    let tools = ctx.tools().unwrap();
    assert!(tools.list().iter().any(|t| t.name == "task"));
    ctx.dispose().await;
    assert!(!tools.list().iter().any(|t| t.name == "task"));

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    SubAgentsPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(ctx2.tools().unwrap().list().iter().any(|t| t.name == "task"));
}

#[test]
fn tool_trait_object() {
    fn assert_tool<T: Tool>(_: &T) {}
    let service = Arc::new(SubAgentService::new(SubAgentsConfig::default()));
    assert_tool(&TaskTool::new(service, 1));
}