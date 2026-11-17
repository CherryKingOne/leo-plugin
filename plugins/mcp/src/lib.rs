//! Rust rewrite of `leo-plugin-mcp` (Model Context Protocol client).
//!
//! Supports stdio and Streamable HTTP transports, exposes each MCP tool as a
//! leo tool named `<prefix>__<server>__<tool>`, and provides the `mcp` service.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;

use leo_plugin_sdk::{
    load_config_file, merge_layers, Context, Plugin, PluginError, Result, Tool, ToolContext,
    ToolResult,
};

pub const SERVER_FILE_NAMES: &[&str] = &["mcp-servers.json", "mcp-server.json"];
pub const MODERN_VERSIONS: &[&str] = &["2026-07-28"];
pub const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
    pub disabled: bool,
    pub enabled: Option<bool>,
    pub protocol: String,
    pub include_tools: Option<Vec<String>>,
    pub exclude_tools: Option<Vec<String>>,
    pub auto_approve: Option<Value>,
    pub description: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            kind: None,
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            disabled: false,
            enabled: None,
            protocol: "auto".into(),
            include_tools: None,
            exclude_tools: None,
            auto_approve: None,
            description: None,
        }
    }
}

impl ServerConfig {
    pub fn is_remote(&self) -> bool {
        matches!(
            self.kind.as_deref(),
            Some("http") | Some("streamable-http") | Some("streamableHttp") | Some("sse")
        )
    }

    pub fn is_enabled(&self) -> bool {
        !self.disabled && self.enabled.unwrap_or(true)
    }

    /// Validate the server configuration.
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.kind.as_deref() == Some("stdio") && self.command.is_none() {
            return Err("type \"stdio\" requires \"command\"".into());
        }
        if self.is_remote() && self.url.is_none() {
            return Err(format!("type \"{}\" requires \"url\"", self.kind.clone().unwrap_or_default()));
        }
        if self.kind.is_none() && self.command.is_none() && self.url.is_none() {
            return Err("either \"command\" (stdio) or \"url\" (http) is required".into());
        }
        if self.kind.is_none() && self.command.is_some() && self.url.is_some() {
            return Err("both \"command\" and \"url\" given; set \"type\" to pick one".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct McpConfig {
    pub servers: HashMap<String, ServerConfig>,
    pub load_server_files: bool,
    pub tool_prefix: String,
    pub connect_timeout_ms: u64,
    pub probe_timeout_ms: u64,
    pub timeout_ms: u64,
    pub max_output_chars: usize,
    pub include_instructions: bool,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            servers: HashMap::new(),
            load_server_files: true,
            tool_prefix: "mcp".into(),
            connect_timeout_ms: 30_000,
            probe_timeout_ms: 5_000,
            timeout_ms: 120_000,
            max_output_chars: 30_000,
            include_instructions: true,
        }
    }
}

/// Compute the exposed tool name.
pub fn tool_name(prefix: &str, server: &str, tool: &str) -> String {
    if prefix.is_empty() {
        format!("{server}__{tool}")
    } else {
        format!("{prefix}__{server}__{tool}")
    }
}

/// Interpolate `${NAME}` / `$NAME` in a string using the environment.
pub fn interpolate(input: &str) -> String {
    let mut out = String::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'{' {
                if let Some(end) = input[i + 2..].find('}') {
                    let name = &input[i + 2..i + 2 + end];
                    out.push_str(&std::env::var(name).unwrap_or_default());
                    i = i + 2 + end + 1;
                    continue;
                }
            } else if i + 1 < bytes.len() && (bytes[i + 1].is_ascii_alphabetic() || bytes[i + 1] == b'_') {
                let start = i + 1;
                let mut end = start;
                while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                    end += 1;
                }
                let name = &input[start..end];
                out.push_str(&std::env::var(name).unwrap_or_default());
                i = end;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// A transport-independent JSON-RPC channel.
#[async_trait]
pub trait Transport: Send + Sync {
    async fn request(&self, method: &str, params: Value) -> Result<Value>;
    async fn close(&self) -> Result<()> {
        Ok(())
    }
}

/// Streamable HTTP transport.
pub struct HttpTransport {
    url: String,
    headers: HashMap<String, String>,
    client: reqwest::Client,
    id: AtomicU64,
}

impl HttpTransport {
    pub fn new(url: String, headers: HashMap<String, String>) -> Self {
        Self {
            url,
            headers,
            client: reqwest::Client::new(),
            id: AtomicU64::new(1),
        }
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.id.fetch_add(1, Ordering::Relaxed);
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let mut request = self.client.post(&self.url).json(&body);
        for (key, value) in &self.headers {
            request = request.header(key, interpolate(value));
        }
        let response = request
            .send()
            .await
            .map_err(|e| PluginError::other(format!("mcp http request failed: {e}")))?;
        let value: Value = response
            .json()
            .await
            .map_err(|e| PluginError::other(format!("mcp http response: {e}")))?;
        if let Some(error) = value.get("error") {
            return Err(PluginError::other(format!("mcp error: {error}")));
        }
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// stdio transport: line-delimited JSON-RPC over the child process pipes.
pub struct StdioTransport {
    child: AsyncMutex<Child>,
    stdin: AsyncMutex<ChildStdin>,
    stdout: AsyncMutex<BufReader<ChildStdout>>,
    id: AtomicU64,
}

impl StdioTransport {
    pub async fn spawn(command: &str, args: Vec<String>, env: HashMap<String, String>) -> Result<Self> {
        let mut cmd = Command::new(command);
        cmd.args(args);
        for (key, value) in env {
            cmd.env(key, interpolate(&value));
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|e| PluginError::other(format!("failed to spawn '{command}': {e}")))?;
        let stdin = child.stdin.take().ok_or_else(|| PluginError::other("no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| PluginError::other("no stdout"))?;
        Ok(Self {
            child: AsyncMutex::new(child),
            stdin: AsyncMutex::new(stdin),
            stdout: AsyncMutex::new(BufReader::new(stdout)),
            id: AtomicU64::new(1),
        })
    }
}

#[async_trait]
impl Transport for StdioTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.id.fetch_add(1, Ordering::Relaxed);
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let line = format!("{request}\n");
        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| PluginError::other(format!("mcp stdin: {e}")))?;
            stdin
                .flush()
                .await
                .map_err(|e| PluginError::other(format!("mcp flush: {e}")))?;
        }
        let mut reader = self.stdout.lock().await;
        let mut response = String::new();
        reader
            .read_line(&mut response)
            .await
            .map_err(|e| PluginError::other(format!("mcp stdout: {e}")))?;
        let value: Value = serde_json::from_str(&response)
            .map_err(|e| PluginError::other(format!("mcp invalid response: {e}")))?;
        if let Some(error) = value.get("error") {
            return Err(PluginError::other(format!("mcp error: {error}")));
        }
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn close(&self) -> Result<()> {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.kill().await;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct McpToolDef {
    pub server: String,
    pub name: String,
    pub description: String,
    pub schema: Value,
}

#[derive(Clone)]
struct Server {
    name: String,
    transport: Arc<dyn Transport>,
    tools: Vec<McpToolDef>,
    instructions: String,
}

/// The MCP manager (`mcp` service).
#[derive(Default)]
pub struct McpManager {
    servers: RwLock<Vec<Server>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a server with an externally provided transport (used by tests/embedders).
    pub fn add_server(&self, name: &str, transport: Arc<dyn Transport>) {
        self.servers
            .write()
            .push(Server { name: name.to_string(), transport, tools: Vec::new(), instructions: String::new() });
    }

    /// Connect to one transport and load its tools.
    pub async fn connect(&self, name: &str, transport: Arc<dyn Transport>) -> Result<usize> {
        let tools_result = transport.request("tools/list", json!({})).await?;
        let tools = tools_result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let defs: Vec<McpToolDef> = tools
            .iter()
            .filter_map(|tool| {
                let tool_name = tool.get("name")?.as_str()?.to_string();
                Some(McpToolDef {
                    server: name.to_string(),
                    name: tool_name.clone(),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    schema: tool.get("inputSchema").cloned().unwrap_or_else(|| json!({"type":"object"})),
                })
            })
            .collect();
        let instructions = transport
            .request("instructions/get", json!({}))
            .await
            .ok()
            .and_then(|v| v.get("instructions").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        self.servers.write().push(Server {
            name: name.to_string(),
            transport,
            tools: defs,
            instructions,
        });
        Ok(self.server_tools(name).len())
    }

    pub async fn connect_config(&self, name: &str, config: &ServerConfig) -> Result<()> {
        let transport: Arc<dyn Transport> = if let Some(url) = &config.url {
            Arc::new(HttpTransport::new(url.clone(), config.headers.clone()))
        } else if let Some(command) = &config.command {
            Arc::new(StdioTransport::spawn(command, config.args.clone(), config.env.clone()).await?)
        } else {
            return Err(PluginError::other(format!(
                "server '{name}' needs a command or url"
            )));
        };
        self.connect(name, transport).await?;
        Ok(())
    }

    pub fn server_names(&self) -> Vec<String> {
        self.servers.read().iter().map(|s| s.name.clone()).collect()
    }

    pub fn server_tools(&self, server: &str) -> Vec<McpToolDef> {
        self.servers
            .read()
            .iter()
            .find(|s| s.name == server)
            .map(|s| s.tools.clone())
            .unwrap_or_default()
    }

    pub fn tools(&self) -> Vec<McpToolDef> {
        self.servers.read().iter().flat_map(|s| s.tools.clone()).collect()
    }

    pub fn instructions(&self) -> String {
        self.servers
            .read()
            .iter()
            .map(|s| s.instructions.clone())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    pub async fn call(&self, server: &str, tool: &str, arguments: Value) -> Result<Value> {
        let transport = self
            .servers
            .read()
            .iter()
            .find(|s| s.name == server)
            .map(|s| s.transport.clone())
            .ok_or_else(|| PluginError::other(format!("unknown MCP server: {server}")))?;
        transport
            .request("tools/call", json!({"name": tool, "arguments": arguments}))
            .await
    }

    pub async fn close_all(&self) {
        let servers = self.servers.read().clone();
        for server in servers {
            let _ = server.transport.close().await;
        }
        self.servers.write().clear();
    }
}

/// A tool backed by an MCP server.
pub struct McpTool {
    manager: Arc<McpManager>,
    exposed_name: String,
    def: McpToolDef,
}

#[async_trait]
impl Tool for McpTool {
    fn name(&self) -> &str {
        &self.exposed_name
    }

    fn description(&self) -> &str {
        &self.def.description
    }

    fn parameters(&self) -> Value {
        self.def.schema.clone()
    }

    fn permissions(&self) -> Option<Value> {
        Some(json!({"kind": "mcp.call", "sideEffect": true}))
    }

    async fn execute(&self, args: Value, _ctx: ToolContext) -> ToolResult {
        match self.manager.call(&self.def.server, &self.def.name, args).await {
            Ok(value) => ToolResult::ok(value),
            Err(err) => ToolResult::error(err.to_string()),
        }
    }
}

pub fn load_config(plugin_config: &Value) -> McpConfig {
    let mut config: McpConfig = serde_json::from_value(plugin_config.clone()).unwrap_or_default();
    if config.load_server_files {
        let paths = leo_plugin_sdk::LeoPaths::detect();
        let mut servers: HashMap<String, ServerConfig> = HashMap::new();
        for name in SERVER_FILE_NAMES {
            for dir in [paths.project_dir.clone(), Some(paths.user_dir.clone())]
                .into_iter()
                .flatten()
            {
                if let Ok(Some(value)) = load_config_file(&dir, name) {
                    if let Some(map) = value.get("mcpServers").and_then(Value::as_object) {
                        for (server_name, raw) in map {
                            if let Ok(server) = serde_json::from_value::<ServerConfig>(raw.clone()) {
                                servers.insert(server_name.clone(), server);
                            }
                        }
                    }
                }
            }
        }
        for (name, server) in servers {
            config.servers.entry(name).or_insert(server);
        }
    }
    config
}

#[derive(Default)]
pub struct McpPlugin;

#[async_trait]
impl Plugin for McpPlugin {
    fn name(&self) -> &str {
        "leo-plugin-mcp"
    }

    fn inject(&self) -> Vec<String> {
        vec!["tools".into()]
    }

    fn watch(&self) -> Vec<String> {
        SERVER_FILE_NAMES.iter().map(|s| s.to_string()).collect()
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let manager = Arc::new(McpManager::new());

        let mut failures = Vec::new();
        let server_configs: Vec<(String, ServerConfig)> = config
            .servers
            .iter()
            .filter(|(_, server)| server.is_enabled())
            .map(|(name, server)| (name.clone(), server.clone()))
            .collect();
        for (name, server) in server_configs {
            if let Err(err) = server.validate() {
                failures.push(format!("{name}: {err}"));
                continue;
            }
            if let Err(err) = manager.connect_config(&name, &server).await {
                failures.push(format!("{name}: {err}"));
                let _ = ctx.emit(
                    "mcp/error",
                    json!({"server": name, "error": err.to_string()}),
                );
            }
        }

        // Register MCP tools.
        let tools: Vec<McpToolDef> = manager.tools();
        for def in tools {
            let exposed = tool_name(&config.tool_prefix, &def.server, &def.name);
            let tool: Arc<dyn Tool> = Arc::new(McpTool {
                manager: manager.clone(),
                exposed_name: exposed,
                def,
            });
            ctx.register_tool(tool).await?;
        }

        if config.include_instructions {
            if let Some(context) = ctx.context() {
                let manager_for_section = manager.clone();
                let section = leo_plugin_sdk::ContextSection {
                    id: "mcp/instructions".into(),
                    layer: "runtime".into(),
                    priority: 200,
                    render: Arc::new(move || {
                        let text = manager_for_section.instructions();
                        if text.is_empty() {
                            None
                        } else {
                            Some(format!("# Instructions from MCP servers\n{text}"))
                        }
                    }),
                };
                ctx.effect(context.register_section(section));
            }
        }

        ctx.provide("mcp", manager.clone());
        let manager_for_close = manager.clone();
        ctx.effect(Box::pin(async move {
            manager_for_close.close_all().await;
        }));

        for server in manager.server_names() {
            let _ = ctx.emit(
                "mcp/connected",
                json!({"server": server, "era": "modern", "protocolVersion": MODERN_VERSIONS[0], "tools": []}),
            );
        }
        for failure in failures {
            ctx.logger().warn(&format!("mcp: {failure}"));
        }
        Ok(())
    }
}

/// Keep `Path` referenced for the public config helpers.
#[allow(dead_code)]
fn _assert_path(_: &Path) {}