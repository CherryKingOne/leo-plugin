//! `leo-plugin-host` – loads Rust plugins as subprocesses.
//!
//! Each plugin binary speaks the newline-delimited JSON-RPC protocol defined in
//! [`leo_plugin_sdk::runtime`]. The host launches a plugin, sends `apply`, then
//! forwards `call_tool` / `emit` requests. Because plugins are separate
//! processes, a host written in any language can drive them; this binary is the
//! reference implementation and test harness.

use std::process::Stdio;

use anyhow::{anyhow, Context as _, Result};
use leo_plugin_sdk::{json, Context, Plugin, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

/// A handle to a running plugin subprocess.
pub struct PluginProcess {
    pub name: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

impl PluginProcess {
    /// Launch `program` as a plugin subprocess.
    pub async fn spawn(program: &str) -> Result<Self> {
        let mut child = Command::new(program)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("failed to spawn plugin '{program}'"))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let mut proc = Self {
            name: program.to_string(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };
        let info = proc.request("describe", json!({})).await?;
        if let Some(name) = info.get("name").and_then(Value::as_str) {
            proc.name = name.to_string();
        }
        Ok(proc)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        self.stdin
            .write_all(format!("{request}\n").as_bytes())
            .await?;
        self.stdin.flush().await?;

        let mut line = String::new();
        let read = self.stdout.read_line(&mut line).await?;
        if read == 0 {
            return Err(anyhow!("plugin '{name}' closed stdout", name = self.name));
        }
        let response: Value = serde_json::from_str(&line)?;
        if response.get("ok").and_then(Value::as_bool) == Some(false) {
            let error = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(anyhow!("plugin error: {error}"));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn apply(&mut self, config: Value) -> Result<()> {
        self.request("apply", json!({ "config": config })).await?;
        Ok(())
    }

    pub async fn list_tools(&mut self) -> Result<Vec<Value>> {
        let value = self.request("list_tools", json!({})).await?;
        Ok(value.as_array().cloned().unwrap_or_default())
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value> {
        self.request("call_tool", json!({ "name": name, "arguments": arguments }))
            .await
    }

    pub async fn dispose(mut self) -> Result<()> {
        let _ = self.request("dispose", json!({})).await;
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        Ok(())
    }
}

impl Drop for PluginProcess {
    fn drop(&mut self) {
        // Ensure the child is terminated even if the caller forgot to dispose.
        let _ = self.child.start_kill();
    }
}

/// Load a plugin binary and print its advertised tools.
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let mut args = std::env::args().skip(1);
    let program = args.next().ok_or_else(|| {
        anyhow!("usage: leo-plugin-host <plugin-binary> [--tool <name> '<json-args>']")
    })?;

    let mut proc = PluginProcess::spawn(&program).await?;
    proc.apply(Value::Null).await?;

    let tools = proc.list_tools().await?;
    if tools.is_empty() {
        println!("plugin '{}' exposes no tools", proc.name);
        return Ok(());
    }
    println!("plugin '{}' tools:", proc.name);
    for tool in &tools {
        println!("  - {}", tool.get("name").and_then(Value::as_str).unwrap_or("?"));
    }

    // Optional: invoke a single tool and print its result.
    let mut iter = args;
    if let Some(flag) = iter.next() {
        if flag == "--tool" {
            let name = iter.next().ok_or_else(|| anyhow!("--tool requires a name"))?;
            let args = iter.next().unwrap_or_else(|| "{}".into());
            let arguments: Value = serde_json::from_str(&args)?;
            let result = proc.call_tool(&name, arguments).await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            proc.dispose().await?;
            return Ok(());
        }
    }
    Ok(())
}

/// Marker so `Context` is considered used even if future refactors drop it.
#[allow(dead_code)]
fn _assert_context(_: Context, _: &dyn Plugin) {}