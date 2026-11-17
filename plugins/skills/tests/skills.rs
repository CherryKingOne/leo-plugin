use std::io::Write;
use std::sync::Arc;

use leo_plugin_sdk::{json, Context, NullLogger, Plugin, Tool, ToolContext, ToolsService};
use leo_plugin_skills::{
    catalog_section, service_from_roots, SkillRoot, SkillsConfig, SkillsPlugin, SkillTool,
};

fn temp_skills_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("leo-skills-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_skill(root: &std::path::Path, name: &str, body: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let mut file = std::fs::File::create(dir.join("SKILL.md")).unwrap();
    writeln!(file, "---\nname: {name}\ndescription: demo skill\n---\n{body}").unwrap();
}

#[test]
fn catalog_finds_skills() {
    let root = temp_skills_dir();
    write_skill(&root, "explorer", "Explore the repo.");
    let service = service_from_roots(
        SkillsConfig::default(),
        vec![SkillRoot { source: "user".into(), dir: root.clone() }],
    );
    let snap = service.snapshot();
    assert_eq!(snap.len(), 1);
    assert_eq!(snap[0].name, "explorer");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn disabled_filtered_from_catalog_section() {
    let root = temp_skills_dir();
    write_skill(&root, "explorer", "Explore.");
    let service = service_from_roots(
        SkillsConfig { disabled: vec!["explorer".into()], ..Default::default() },
        vec![SkillRoot { source: "user".into(), dir: root.clone() }],
    );
    assert!(catalog_section(&service.snapshot(), 500).is_none());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn skill_tool_loads_instructions() {
    let root = temp_skills_dir();
    write_skill(&root, "explorer", "Explore the repo.");
    let service = service_from_roots(
        SkillsConfig::default(),
        vec![SkillRoot { source: "user".into(), dir: root.clone() }],
    );
    let tool = SkillTool::new(service);
    let result = tool
        .execute(json!({"name": "explorer"}), ToolContext::new())
        .await;
    assert!(!result.is_error);
    let text = result.output.as_str().unwrap();
    assert!(text.contains("Explore the repo."));
    let missing = tool
        .execute(json!({"name": "nope"}), ToolContext::new())
        .await;
    assert!(missing.is_error);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn plugin_registers_skill_tool_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    ctx.ensure_basic_context();
    SkillsPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    let tools = ctx.tools().unwrap();
    assert!(tools.list().iter().any(|t| t.name == "skill"));
    ctx.dispose().await;
    assert!(!tools.list().iter().any(|t| t.name == "skill"));

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    ctx2.ensure_basic_context();
    SkillsPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(ctx2.tools().unwrap().list().iter().any(|t| t.name == "skill"));
}

#[test]
fn tool_trait_object() {
    fn assert_tool<T: Tool>(_: &T) {}
    let service = service_from_roots(SkillsConfig::default(), vec![]);
    assert_tool(&SkillTool::new(service));
}