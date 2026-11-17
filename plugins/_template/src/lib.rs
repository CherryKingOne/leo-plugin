//! Rust rewrite of the plugin template.
//!
//! Copy this directory, rename `template` to your plugin id, then replace the
//! example tool with your own capabilities. Rules: [`PROTOCOL.md`](../../PROTOCOL.md).

use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{json, Context, Plugin, Result, Tool, ToolContext, ToolResult, Value};

/// Example tool: return the input text unchanged (optionally prefixed).
pub struct EchoTool {
    prefix: String,
}

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "template_echo"
    }

    fn description(&self) -> &str {
        "Example tool: return the input text unchanged."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "text": { "type": "string", "description": "Text to echo" } },
            "required": ["text"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, args: Value, _ctx: ToolContext) -> ToolResult {
        let text = args.get("text").and_then(Value::as_str).unwrap_or_default();
        ToolResult::text(format!("{}{}", self.prefix, text))
    }
}

/// The plugin definition.
#[derive(Default)]
pub struct TemplatePlugin;

#[async_trait]
impl Plugin for TemplatePlugin {
    fn name(&self) -> &str {
        "leo-plugin-template"
    }

    fn inject(&self) -> Vec<String> {
        vec!["tools".into()]
    }

    fn config_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "prefix": { "type": "string", "default": "" } },
            "additionalProperties": true
        })
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let prefix = config
            .get("prefix")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let tool: Arc<dyn Tool> = Arc::new(EchoTool { prefix });
        ctx.register_tool(tool).await
    }
}