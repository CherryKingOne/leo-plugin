//! Template plugin tests: load, run without config, unload revokes, reload.

use std::sync::Arc;

use leo_plugin_sdk::{json, runtime::apply_plugin, Context, NullLogger, Plugin, ToolContext};
use leo_plugin_template::TemplatePlugin;

#[tokio::test]
async fn registers_echo_tool() {
    let plugin: Arc<dyn Plugin> = Arc::new(TemplatePlugin);
    let (ctx, tools) = apply_plugin(&plugin).await.unwrap();
    assert!(tools.list().iter().any(|t| t.name == "template_echo"));

    let result = ctx
        .call_tool("template_echo", json!({ "text": "hi" }), ToolContext::new())
        .await
        .unwrap();
    assert_eq!(result.output, json!("hi"));
    assert!(!result.is_error);
}

#[tokio::test]
async fn unload_revokes_and_reload_works() {
    let plugin: Arc<dyn Plugin> = Arc::new(TemplatePlugin);
    let (ctx, tools) = apply_plugin(&plugin).await.unwrap();
    assert!(tools.list().iter().any(|t| t.name == "template_echo"));
    ctx.dispose().await;
    assert!(tools.list().is_empty());

    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    plugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert!(ctx
        .tools()
        .unwrap()
        .list()
        .iter()
        .any(|t| t.name == "template_echo"));
}

#[tokio::test]
async fn config_prefix_applies() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    TemplatePlugin
        .apply(ctx.clone(), json!({ "prefix": "echo: " }))
        .await
        .unwrap();
    let result = ctx
        .call_tool("template_echo", json!({ "text": "hi" }), ToolContext::new())
        .await
        .unwrap();
    assert_eq!(result.output, json!("echo: hi"));
}