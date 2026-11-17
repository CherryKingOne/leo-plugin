//! Newline-delimited JSON-RPC runtime.
//!
//! Each plugin crate can be built as a small binary that speaks this protocol on
//! stdin/stdout. The host (`leo-plugin-host`) launches the binary, sends
//! `apply`, then forwards `call_tool` / `emit` requests. This is the Rust
//! equivalent of the original ESM loader: one process per plugin, hot-reloadable
//! by restarting the process.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::context::Context;
use crate::error::Result;
use crate::plugin::Plugin;
use crate::services::ToolCall;
use crate::tool::ToolContext;

/// Drives a [`Plugin`] over the newline-delimited JSON-RPC protocol.
pub struct PluginRuntime {
    plugin: Arc<dyn Plugin>,
    applied: AtomicBool,
}

impl PluginRuntime {
    pub fn new(plugin: Arc<dyn Plugin>) -> Self {
        Self {
            plugin,
            applied: AtomicBool::new(false),
        }
    }

    pub fn plugin(&self) -> &Arc<dyn Plugin> {
        &self.plugin
    }

    /// Handle a single request object and return a response object.
    pub async fn handle(&self, ctx: &Context, request: &Value) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(Value::Null);

        let outcome: std::result::Result<Value, String> = match method {
            "ping" => Ok(json!("pong")),
            "describe" => Ok(json!({
                "name": self.plugin.name(),
                "inject": self.plugin.inject(),
                "watch": self.plugin.watch(),
                "config_schema": self.plugin.config_schema(),
            })),
            "apply" => {
                let config = params.get("config").cloned().unwrap_or(Value::Null);
                if self.applied.swap(true, Ordering::SeqCst) {
                    Err("plugin already applied".into())
                } else {
                    self.plugin
                        .apply(ctx.clone(), config)
                        .await
                        .map(|_| json!({ "name": self.plugin.name() }))
                        .map_err(|e| e.to_string())
                }
            }
            "list_tools" => {
                let tools = ctx
                    .tools()
                    .map(|t| {
                        t.list()
                            .into_iter()
                            .map(|info| {
                                json!({
                                    "name": info.name,
                                    "description": info.description,
                                    "parameters": info.parameters,
                                    "permissions": info.permissions,
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Ok(Value::Array(tools))
            }
            "call_tool" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or(Value::Null);
                let call = ToolCall::new(name, arguments);
                match ctx.tools() {
                    Some(tools) => {
                        let result = tools.execute(call, ToolContext::new()).await;
                        Ok(json!({
                            "output": result.output,
                            "isError": result.is_error,
                            "terminate": result.terminate,
                        }))
                    }
                    None => Err("missing 'tools' service".into()),
                }
            }
            "emit" => {
                let event = params.get("event").and_then(Value::as_str).unwrap_or("");
                let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                ctx.emit(event, payload)
                    .await
                    .map_err(|e| e.to_string())
            }
            "dispose" => {
                ctx.dispose().await;
                Ok(Value::Null)
            }
            other => Err(format!("unknown method: {other}")),
        };

        match outcome {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        }
    }

    /// Run the request loop, reading requests from `reader` and writing
    /// responses to `writer`. Returns when the input stream closes.
    pub async fn run<R, W>(&self, ctx: Context, reader: R, writer: W) -> std::io::Result<()>
    where
        R: tokio::io::AsyncRead + Unpin,
        W: tokio::io::AsyncWrite + Unpin,
    {
        let mut lines = BufReader::new(reader).lines();
        let mut writer = writer;
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let request: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(err) => {
                    let response = json!({ "id": Value::Null, "ok": false, "error": format!("invalid request: {err}") });
                    writer
                        .write_all(format!("{response}\n").as_bytes())
                        .await?;
                    writer.flush().await?;
                    continue;
                }
            };
            let response = self.handle(&ctx, &request).await;
            writer
                .write_all(format!("{response}\n").as_bytes())
                .await?;
            writer.flush().await?;
        }
        Ok(())
    }
}

/// Convenience: run a plugin on stdin/stdout using a console logger.
///
/// The root context is seeded with the default `tools` and `context` services so
/// a plugin that only injects `tools` can run standalone.
pub async fn serve(plugin: Arc<dyn Plugin>) -> std::io::Result<()> {
    let ctx = Context::root(Arc::new(crate::ConsoleLogger::from_env("leo-plugin")));
    ctx.ensure_basic_tools();
    ctx.ensure_basic_context();
    let runtime = PluginRuntime::new(plugin);
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    runtime.run(ctx, stdin, stdout).await
}

/// Convenience: apply a plugin to a fresh context (used by tests and embedders).
pub async fn apply_plugin(plugin: &Arc<dyn Plugin>) -> Result<(Context, Arc<dyn crate::services::ToolsService>)> {
    let ctx = Context::root(Arc::new(crate::ConsoleLogger::from_env("leo-plugin")));
    ctx.ensure_basic_tools();
    ctx.ensure_basic_context();
    plugin.apply(ctx.clone(), Value::Null).await?;
    let tools = ctx.tools().expect("tools registered");
    Ok((ctx, tools))
}