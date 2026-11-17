use std::sync::Arc;

use leo_plugin_sdk::{json, Context, NullLogger, Plugin, ToolsService};
use leo_plugin_agent_team::{
    builtin_roles, parse_role_markdown, resolve_roles, AgentTeamConfig, AgentTeamPlugin, Member,
    TeamEngine,
};

#[test]
fn builtin_roles_resolve() {
    assert_eq!(builtin_roles().len(), 6);
    let roles = resolve_roles(&AgentTeamConfig::default());
    assert!(roles.contains_key("leader"));
    assert!(roles.contains_key("qa"));
}

#[test]
fn parse_role_markdown_overrides() {
    let role = parse_role_markdown("dev", "---\nname: Dev\ntools: read_file, bash\n---\nYou build.");
    assert_eq!(role.name, "Dev");
    assert_eq!(role.tools, vec!["read_file".to_string(), "bash".to_string()]);
    assert!(role.prompt.contains("You build."));
}

#[test]
fn engine_advances_and_gates() {
    let dir = std::env::temp_dir().join(format!("leo-team-{}", std::process::id()));
    let engine = TeamEngine::new(AgentTeamConfig::default(), dir.clone());
    let project = engine.start("build a thing");
    assert_eq!(project.phase, "prd");

    // design has a gate by default: advance to design -> awaiting approval.
    let design = engine.advance(&project.id).unwrap();
    assert_eq!(design.phase, "design");
    assert_eq!(design.status, "awaiting_approval");

    let approved = engine.approve(&project.id, Some("ok")).unwrap();
    assert_eq!(approved.phase, "dev");
    assert_eq!(approved.status, "running");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn guard_denies_internal_tools() {
    let dir = std::env::temp_dir().join(format!("leo-team-guard-{}", std::process::id()));
    let engine = TeamEngine::new(AgentTeamConfig::default(), dir.clone());
    engine.register_member(
        "agent-1",
        Member { role: "dev".into(), tools: vec!["read_file".into()] },
    );
    assert!(engine.deny_reason("agent-1", "team_board").is_some());
    assert!(engine.deny_reason("agent-1", "bash").is_some());
    assert!(engine.deny_reason("agent-1", "read_file").is_none());
    assert!(engine.deny_reason("stranger", "team_board").is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn plugin_registers_tools_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    AgentTeamPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    let names: Vec<String> = ctx.tools().unwrap().list().into_iter().map(|t| t.name).collect();
    for expected in [
        "team_start",
        "team_reply",
        "team_assign",
        "team_board",
        "team_artifact",
        "team_request_approval",
        "team_deliver",
        "team_ask",
        "team_task_update",
    ] {
        assert!(names.contains(&expected.to_string()), "missing {expected}");
    }
    ctx.dispose().await;

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    AgentTeamPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(ctx2
        .tools()
        .unwrap()
        .list()
        .iter()
        .any(|t| t.name == "team_start"));
}