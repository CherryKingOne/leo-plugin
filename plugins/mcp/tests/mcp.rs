use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{json, Context, NullLogger, Plugin, Result, Value};
use leo_plugin_mcp::{interpolate, tool_name, McpManager, McpPlugin, ServerConfig, Transport};

#[test]
fn tool_naming() {
    assert_eq!(tool_name("mcp", "fs", "read"), "mcp__fs__read");
    assert_eq!(tool_name("", "fs", "read"), "fs__read");
}

#[test]
fn interpolate_env() {
    std::env::set_var("LEO_TEST_TOKEN", "secret");
    assert_eq!(interpolate("Bearer ${LEO_TEST_TOKEN}"), "Bearer secret");
}

#[test]
fn server_validation() {
    let mut server = ServerConfig::default();
    assert!(server.validate().is_err());
    server.command = Some("echo".into());
    assert!(server.validate().is_ok());
}

struct MockTransport;

#[async_trait]
impl Transport for MockTransport {
    async fn request(&self, method: &str, _params: Value) -> Result<Value> {
        match method {
            "tools/list" => Ok(json!({"tools": [
                {"name": "echo", "description": "echo", "inputSchema": {"type": "object"}}
            ]})),
            _ => Ok(Value::Null),
        }
    }
}

#[tokio::test]
async fn manager_lists_and_calls_tools() {
    let manager = McpManager::new();
    let transport: Arc<dyn Transport> = Arc::new(MockTransport);
    manager.connect("mock", transport).await.unwrap();
    assert_eq!(manager.server_names(), vec!["mock".to_string()]);
    assert_eq!(manager.tools().len(), 1);
    let result = manager.call("mock", "echo", json!({"x": 1})).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn plugin_applies_without_servers_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    McpPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert!(ctx.get::<McpManager>("mcp").is_some());
    ctx.dispose().await;

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    McpPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(ctx2.get::<McpManager>("mcp").is_some());
}