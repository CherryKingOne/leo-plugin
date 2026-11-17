//! Rust rewrite of `leo-plugin-gateway` (message gateway / channel registry).
//!
//! The gateway owns chat-platform connections, routes each chat to a session,
//! handles authorization/pairing, and exposes an HTTP control plane. Channel
//! drivers are registered by the gateway itself (builtins) or by sub-plugins
//! (`gateway-qq`, `gateway-feishu`), which override a builtin with the same id.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::task::AbortHandle;

use leo_plugin_sdk::{
    load_config_file, merge_layers, ChannelConnection, ChannelDriver, ChannelInit, ChannelTarget,
    Context, Disposer, GatewayService, InboundMessage, OutboundMessage, Plugin, PluginError,
    Result, SendResult, Tool, ToolContext, ToolResult,
};

pub const CONFIG_FILE_NAME: &str = "gateway.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ServerConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            host: "127.0.0.1".into(),
            port: 18790,
            token: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AuthConfig {
    pub allow: Vec<String>,
    pub admins: Vec<String>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self { allow: Vec::new(), admins: Vec::new() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GatewayConfig {
    pub enabled: bool,
    pub server: ServerConfig,
    pub channels: HashMap<String, Value>,
    pub builtin: Vec<String>,
    pub tools: bool,
    pub state_dir: Option<String>,
    pub auth: AuthConfig,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            server: ServerConfig::default(),
            channels: HashMap::new(),
            builtin: vec!["telegram".into(), "feishu".into(), "qq".into()],
            tools: true,
            state_dir: None,
            auth: AuthConfig::default(),
        }
    }
}

/// Build a stable session key.
pub fn session_key(
    channel: &str,
    account: &str,
    chat_type: &str,
    chat_id: &str,
    thread_id: Option<&str>,
    user_id: Option<&str>,
) -> String {
    let mut key = format!("{channel}:{account}:{chat_type}:{chat_id}");
    if let Some(thread) = thread_id {
        key.push(':');
        key.push_str(thread);
    }
    if let Some(user) = user_id {
        if chat_type != "direct" {
            key.push(':');
            key.push_str(user);
        }
    }
    key
}

/// Pairing / authorization state.
#[derive(Default)]
pub struct GatewayState {
    paired: RwLock<HashSet<String>>,
    admins: RwLock<HashSet<String>>,
    pending: RwLock<HashMap<String, i64>>,
}

impl GatewayState {
    pub fn authorize(&self, user: &str) -> bool {
        self.paired.read().contains(user) || self.admins.read().contains(user)
    }

    pub fn pair(&self, user: &str, admin: bool) {
        self.paired.write().insert(user.to_string());
        if admin {
            self.admins.write().insert(user.to_string());
        }
    }

    pub fn create_pairing(&self, user: &str) -> String {
        let code = format!("{:06}", (user.len() * 7919) % 1_000_000);
        self.pending.write().insert(code.clone(), chrono_now());
        code
    }

    pub fn approve(&self, code: &str) -> Option<String> {
        let pending = self.pending.read();
        pending.get(code).map(|_| code.to_string())
    }
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// The gateway core: authorization + session bookkeeping.
pub struct GatewayCore {
    pub config: GatewayConfig,
    pub state: GatewayState,
    sessions: RwLock<HashMap<String, Value>>,
}

impl GatewayCore {
    pub fn new(config: GatewayConfig) -> Self {
        Self {
            config,
            state: GatewayState::default(),
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Authorize an inbound user. Default deny.
    pub fn authorize(&self, user: &str) -> bool {
        let channel_user = user.to_string();
        if self.config.auth.allow.iter().any(|u| u == user || u == "*") {
            return true;
        }
        if self.config.auth.admins.iter().any(|u| u == &channel_user) {
            return true;
        }
        self.state.authorize(user)
    }

    pub fn authorize_user(&self, user: &str, admin: bool) {
        self.state.pair(user, admin);
    }

    /// Handle an inbound message; returns whether it was authorized.
    pub fn handle_inbound(&self, message: &InboundMessage) -> bool {
        let user = format!("{}:{}", message.channel, message.sender.id);
        if !self.authorize(&user) {
            return false;
        }
        let key = session_key(
            &message.channel,
            &message.account,
            &message.chat.chat_type,
            &message.chat.id,
            None,
            Some(&message.sender.id),
        );
        let mut sessions = self.sessions.write();
        let entry = sessions.entry(key.clone()).or_insert_with(|| {
            json!({"key": key, "turns": 0, "lastText": ""})
        });
        entry["turns"] = json!(entry.get("turns").and_then(Value::as_u64).unwrap_or(0) + 1);
        entry["lastText"] = json!(message.text);
        true
    }

    pub fn sessions(&self) -> Vec<Value> {
        self.sessions.read().values().cloned().collect()
    }
}

/// A placeholder connection used by builtin drivers until a sub-plugin
/// overrides them.
struct PlaceholderConnection;

#[async_trait]
impl ChannelConnection for PlaceholderConnection {
    async fn send(&self, _target: ChannelTarget, _message: OutboundMessage) -> Result<SendResult> {
        Err(PluginError::other(
            "channel driver is not configured; install gateway-qq / gateway-feishu or configure credentials",
        ))
    }
}

/// A builtin placeholder driver (telegram / feishu / qq).
pub struct PlaceholderDriver {
    id: String,
}

#[async_trait]
impl ChannelDriver for PlaceholderDriver {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.id
    }

    async fn create(&self, _init: ChannelInit) -> Result<Arc<dyn ChannelConnection>> {
        Ok(Arc::new(PlaceholderConnection))
    }
}

/// The channel registry, implementing [`GatewayService`].
pub struct ChannelRegistry {
    config: GatewayConfig,
    core: Arc<GatewayCore>,
    ctx: Context,
    drivers: Arc<RwLock<Vec<(Arc<dyn ChannelDriver>, bool)>>>,
    connections: Arc<RwLock<HashMap<String, Arc<dyn ChannelConnection>>>>,
}

impl ChannelRegistry {
    pub fn new(config: GatewayConfig, core: Arc<GatewayCore>, ctx: Context) -> Self {
        Self {
            config,
            core,
            ctx,
            drivers: Arc::new(RwLock::new(Vec::new())),
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn core(&self) -> Arc<GatewayCore> {
        self.core.clone()
    }

    /// Test/embedder helper: attach a connection for an account.
    pub fn add_connection(&self, account: &str, connection: Arc<dyn ChannelConnection>) {
        self.connections.write().insert(account.to_string(), connection);
    }

    pub async fn send_to(
        &self,
        account: &str,
        target: ChannelTarget,
        message: OutboundMessage,
    ) -> Result<SendResult> {
        let connection = self
            .connections
            .read()
            .get(account)
            .cloned()
            .ok_or_else(|| PluginError::other(format!("no connection for account '{account}'")))?;
        connection.send(target, message).await
    }

    fn dispatch_closure(&self) -> Arc<dyn Fn(InboundMessage) + Send + Sync> {
        let core = self.core.clone();
        let ctx = self.ctx.clone();
        Arc::new(move |message: InboundMessage| {
            let allowed = core.handle_inbound(&message);
            if allowed {
                let ctx = ctx.clone();
                let payload = json!({
                    "sessionKey": message.chat.id,
                    "message": {
                        "channel": message.channel,
                        "account": message.account,
                        "text": message.text,
                        "sender": message.sender.id,
                    }
                });
                tokio::spawn(async move {
                    let _ = ctx.emit("gateway/message", payload).await;
                });
            }
        })
    }
}

#[async_trait]
impl GatewayService for ChannelRegistry {
    fn register_channel(&self, driver: Arc<dyn ChannelDriver>) -> Disposer {
        let id = driver.id().to_string();
        // External drivers override builtins with the same id.
        self.drivers.write().push((driver, false));
        let drivers = self.drivers.clone();
        Box::pin(async move {
            drivers.write().retain(|(d, _)| d.id() != id);
        })
    }

    fn channels(&self) -> Vec<Value> {
        self.drivers
            .read()
            .iter()
            .map(|(driver, builtin)| {
                json!({
                    "id": driver.id(),
                    "name": driver.name(),
                    "builtin": builtin,
                })
            })
            .collect()
    }

    fn accounts(&self) -> Vec<Value> {
        self.config
            .channels
            .iter()
            .map(|(id, config)| {
                json!({
                    "account": id,
                    "channel": config.get("channel").and_then(Value::as_str).unwrap_or(id),
                    "state": "running",
                })
            })
            .collect()
    }

    async fn restart_account(&self, account: &str, rebind: bool) -> Result<Value> {
        let config = self
            .config
            .channels
            .get(account)
            .cloned()
            .ok_or_else(|| PluginError::other(format!("unknown gateway account: {account}")))?;
        let channel = config
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or(account)
            .to_string();
        let driver = self
            .drivers
            .read()
            .iter()
            .rev()
            .find(|(driver, _)| driver.id() == channel)
            .map(|(driver, _)| driver.clone())
            .ok_or_else(|| PluginError::other(format!("no driver for channel '{channel}'")))?;
        let init = ChannelInit {
            account: account.to_string(),
            options: config.get("options").cloned().unwrap_or_else(|| config.clone()),
            secret: Arc::new(|field| std::env::var(field).ok()),
            dispatch: self.dispatch_closure(),
            notify: Arc::new(|_| {}),
            authorize: {
                let core = self.core.clone();
                Arc::new(move |user, admin| core.authorize_user(user, admin))
            },
            rebind,
        };
        let connection = driver.create(init).await?;
        self.connections
            .write()
            .insert(account.to_string(), connection);
        Ok(json!({"account": account, "state": "running"}))
    }

    fn session_of_agent(&self, _agent_id: &str) -> Option<String> {
        None
    }

    async fn send(&self, target: Value, text: &str) -> Result<SendResult> {
        let account = target
            .get("account")
            .and_then(Value::as_str)
            .ok_or_else(|| PluginError::other("send target needs 'account'"))?;
        let chat_id = target
            .get("chatId")
            .and_then(Value::as_str)
            .ok_or_else(|| PluginError::other("send target needs 'chatId'"))?;
        let target = ChannelTarget {
            chat_id: chat_id.to_string(),
            chat_type: target.get("chatType").and_then(Value::as_str).map(str::to_string),
            extra: None,
        };
        self.send_to(
            account,
            target,
            OutboundMessage { text: text.to_string(), ..Default::default() },
        )
        .await
    }
}

fn builtin_of(_drivers: &[(Arc<dyn ChannelDriver>, bool)], _id: &str) -> bool {
    false
}

/// `gateway_status` tool.
pub struct StatusTool {
    registry: Arc<ChannelRegistry>,
}

#[async_trait]
impl Tool for StatusTool {
    fn name(&self) -> &str {
        "gateway_status"
    }
    fn description(&self) -> &str {
        "Show gateway channels, accounts and sessions."
    }
    fn parameters(&self) -> Value {
        json!({"type": "object", "properties": {}, "additionalProperties": false})
    }
    async fn execute(&self, _args: Value, _ctx: ToolContext) -> ToolResult {
        ToolResult::ok(json!({
            "channels": self.registry.channels(),
            "accounts": self.registry.accounts(),
            "sessions": self.registry.core().sessions(),
        }))
    }
}

/// `gateway_send` tool.
pub struct SendTool {
    gateway: Arc<dyn GatewayService>,
}

#[async_trait]
impl Tool for SendTool {
    fn name(&self) -> &str {
        "gateway_send"
    }
    fn description(&self) -> &str {
        "Send a proactive message to a chat account."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "account": {"type": "string"},
                "chatId": {"type": "string"},
                "text": {"type": "string"}
            },
            "required": ["account", "chatId", "text"],
            "additionalProperties": false
        })
    }
    async fn execute(&self, args: Value, _ctx: ToolContext) -> ToolResult {
        let target = json!({"account": args.get("account").cloned().unwrap_or(Value::Null), "chatId": args.get("chatId").cloned().unwrap_or(Value::Null)});
        let text = args.get("text").and_then(Value::as_str).unwrap_or_default();
        match self.gateway.send(target, text).await {
            Ok(result) => ToolResult::ok(json!({"messageIds": result.message_ids})),
            Err(err) => ToolResult::error(err.to_string()),
        }
    }
}

/// `gateway_pair` tool.
pub struct PairTool {
    core: Arc<GatewayCore>,
}

#[async_trait]
impl Tool for PairTool {
    fn name(&self) -> &str {
        "gateway_pair"
    }
    fn description(&self) -> &str {
        "Approve a pending pairing code."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {"code": {"type": "string"}},
            "required": ["code"],
            "additionalProperties": false
        })
    }
    async fn execute(&self, args: Value, _ctx: ToolContext) -> ToolResult {
        let code = args.get("code").and_then(Value::as_str).unwrap_or_default();
        match self.core.state.approve(code) {
            Some(code) => ToolResult::ok(json!({"approved": code})),
            None => ToolResult::error("unknown or expired pairing code"),
        }
    }
}

fn load_config(plugin_config: &Value) -> GatewayConfig {
    let paths = leo_plugin_sdk::LeoPaths::detect();
    let mut layers = Vec::new();
    if let Some(dir) = &paths.project_dir {
        if let Ok(Some(value)) = load_config_file(dir, CONFIG_FILE_NAME) {
            layers.push(value);
        }
    }
    if let Ok(Some(value)) = load_config_file(&paths.user_dir, CONFIG_FILE_NAME) {
        layers.push(value);
    }
    if !plugin_config.is_null() {
        layers.push(plugin_config.clone());
    }
    let merged = merge_layers(layers);
    serde_json::from_value(merged).unwrap_or_default()
}

/// A minimal HTTP/1.1 control plane (status + channels).
async fn spawn_control_plane(
    host: String,
    port: u16,
    registry: Arc<ChannelRegistry>,
) -> std::io::Result<(AbortHandle, u16)> {
    let listener = TcpListener::bind(format!("{host}:{port}")).await?;
    let addr = listener.local_addr()?;
    let handle = tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => break,
            };
            let registry = registry.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let request = String::from_utf8_lossy(&buf);
                let path = request.lines().next().unwrap_or("");
                let body = if path.contains("/v1/channels") {
                    serde_json::to_string(&json!({"channels": registry.channels(), "accounts": registry.accounts()})).unwrap_or_default()
                } else if path.contains("/v1/status") {
                    serde_json::to_string(&json!({"name": "leo-gateway", "accounts": registry.accounts().len()})).unwrap_or_default()
                } else {
                    json!({"error": "not found"}).to_string()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    })
    .abort_handle();
    Ok((handle, addr.port()))
}

#[derive(Default)]
pub struct GatewayPlugin;

#[async_trait]
impl Plugin for GatewayPlugin {
    fn name(&self) -> &str {
        "leo-plugin-gateway"
    }

    fn inject(&self) -> Vec<String> {
        vec!["tools".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec![CONFIG_FILE_NAME.into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let core = Arc::new(GatewayCore::new(config.clone()));
        let registry = Arc::new(ChannelRegistry::new(config.clone(), core.clone(), ctx.clone()));

        // Register builtin placeholder drivers.
        for id in &config.builtin {
            let driver: Arc<dyn ChannelDriver> = Arc::new(PlaceholderDriver { id: id.clone() });
            let disposer = registry.register_channel(driver);
            ctx.effect(disposer);
        }

        ctx.provide_gateway(registry.clone());

        if config.tools {
            let status: Arc<dyn Tool> = Arc::new(StatusTool { registry: registry.clone() });
            ctx.register_tool(status).await?;
            let gateway: Arc<dyn GatewayService> = registry.clone();
            let send: Arc<dyn Tool> = Arc::new(SendTool { gateway });
            ctx.register_tool(send).await?;
            let pair: Arc<dyn Tool> = Arc::new(PairTool { core: core.clone() });
            ctx.register_tool(pair).await?;

            // Chat agents cannot approve pairing.
            let core_for_guard = core.clone();
            ctx.on("tools/guard", move |payload: Value| {
                let name = payload
                    .get("tool")
                    .and_then(|t| t.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let deny = name == "gateway_pair";
                let _ = &core_for_guard;
                async move {
                    if deny {
                        json!({"deny": "pairing can only be approved by the operator or an admin"})
                    } else {
                        Value::Null
                    }
                }
            });
        }

        // Minimal control plane.
        if config.server.enabled {
            let registry_for_server = registry.clone();
            match spawn_control_plane(
                config.server.host.clone(),
                config.server.port,
                registry_for_server,
            )
            .await
            {
                Ok((handle, port)) => {
                    let _ = ctx.emit(
                        "plugin/notice",
                        json!({"plugin": "gateway", "message": format!("control plane on http://{}:{port}", config.server.host)}),
                    );
                    ctx.effect(Box::pin(async move {
                        handle.abort();
                    }));
                }
                Err(err) => {
                    let _ = ctx.emit(
                        "plugin/notice",
                        json!({"plugin": "gateway", "message": format!("control plane not started: {err}"), "level": "warn"}),
                    );
                }
            }
        }

        Ok(())
    }
}