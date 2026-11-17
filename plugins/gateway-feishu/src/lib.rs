//! Rust rewrite of `leo-plugin-gateway-feishu` (Feishu/Lark channel driver).
//!
//! Network access is abstracted behind [`FeishuApi`] so tests never hit the
//! network. The real connector is represented by [`ReqwestFeishuApi`]; the
//! QR-scan app creation flow returns a clear error in this build.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use leo_plugin_sdk::{
    load_config_file, merge_layers, ChannelConnection, ChannelDriver, ChannelInit, ChannelTarget,
    Context, GatewayService, OutboundMessage, Plugin, PluginError, Result, SendResult, Tool,
    ToolContext, ToolResult,
};

pub const CONFIG_FILE_NAME: &str = "gateway-feishu.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FeishuConfig {
    pub credentials_file: Option<String>,
    pub source: String,
    pub qr_console: Value,
    pub authorize_scanner: bool,
    pub tools: bool,
}

impl Default for FeishuConfig {
    fn default() -> Self {
        Self {
            credentials_file: None,
            source: "leo".into(),
            qr_console: json!("auto"),
            authorize_scanner: true,
            tools: true,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct FeishuCredentials {
    pub app_id: String,
    pub app_secret: String,
}

pub fn credential_key(account: &str, field: &str) -> String {
    format!("gateway/{account}/{field}")
}

#[derive(Clone)]
pub struct CredentialStore {
    path: PathBuf,
}

impl CredentialStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn from_config(config: &FeishuConfig) -> Self {
        let paths = leo_plugin_sdk::LeoPaths::detect();
        let base = paths.project_dir.clone().unwrap_or(paths.user_dir.clone());
        let path = config
            .credentials_file
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| base.join("credentials.json"));
        Self::new(path)
    }

    pub fn load(&self) -> HashMap<String, String> {
        let text = std::fs::read_to_string(&self.path).unwrap_or_default();
        let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
        value
            .as_object()
            .map(|map| {
                map.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.load().get(key).cloned()
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let mut map = self.load();
        map.insert(key.to_string(), value.to_string());
        let value = serde_json::to_value(&map)?;
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&self.path, serde_json::to_string_pretty(&value)?)
            .map_err(|e| PluginError::other(e.to_string()))?;
        Ok(())
    }
}

/// Abstraction over the Feishu/Lark connector.
#[async_trait]
pub trait FeishuApi: Send + Sync {
    /// Create (or reuse) an app via QR scan; returns `(bind_url, credentials)`.
    async fn bind(&self) -> Result<(String, FeishuCredentials)>;
    async fn send(&self, target: ChannelTarget, message: OutboundMessage) -> Result<SendResult>;
}

pub struct ReqwestFeishuApi;

#[async_trait]
impl FeishuApi for ReqwestFeishuApi {
    async fn bind(&self) -> Result<(String, FeishuCredentials)> {
        Err(PluginError::other(
            "Feishu QR app creation requires the Feishu OpenAPI connector, which is not available in this Rust build",
        ))
    }
    async fn send(&self, _target: ChannelTarget, _message: OutboundMessage) -> Result<SendResult> {
        Err(PluginError::other(
            "Feishu send is not configured; set gateway/feishu credentials",
        ))
    }
}

struct FeishuConnection {
    api: Arc<dyn FeishuApi>,
}

#[async_trait]
impl ChannelConnection for FeishuConnection {
    async fn send(&self, target: ChannelTarget, message: OutboundMessage) -> Result<SendResult> {
        self.api.send(target, message).await
    }
}

pub struct FeishuDriver {
    api: Arc<dyn FeishuApi>,
    store: CredentialStore,
    authorize_scanner: bool,
}

impl FeishuDriver {
    pub fn new(api: Arc<dyn FeishuApi>, store: CredentialStore, authorize_scanner: bool) -> Self {
        Self { api, store, authorize_scanner }
    }
}

#[async_trait]
impl ChannelDriver for FeishuDriver {
    fn id(&self) -> &str {
        "feishu"
    }

    fn name(&self) -> &str {
        "Feishu"
    }

    fn description(&self) -> Option<String> {
        Some("Feishu / Lark bot".into())
    }

    fn images(&self) -> bool {
        true
    }

    async fn create(&self, init: ChannelInit) -> Result<Arc<dyn ChannelConnection>> {
        if init.rebind || self.store.get(&credential_key(&init.account, "appId")).is_none() {
            let (_url, credentials) = self.api.bind().await?;
            self.store
                .set(&credential_key(&init.account, "appId"), &credentials.app_id)?;
            self.store.set(
                &credential_key(&init.account, "appSecret"),
                &credentials.app_secret,
            )?;
            if self.authorize_scanner {
                (init.authorize)("scanner", true);
            }
        }
        Ok(Arc::new(FeishuConnection { api: self.api.clone() }))
    }
}

pub struct BindTool {
    gateway: Arc<dyn GatewayService>,
}

#[async_trait]
impl Tool for BindTool {
    fn name(&self) -> &str {
        "gateway_feishu_bind"
    }
    fn description(&self) -> &str {
        "Start (or restart) Feishu QR binding for an account. Returns the QR link and account state."
    }
    fn parameters(&self) -> Value {
        json!({"type": "object", "properties": {"account": {"type": "string"}}, "additionalProperties": false})
    }
    fn permissions(&self) -> Option<Value> {
        Some(json!({"kind": "gateway.bind", "sideEffect": true}))
    }
    async fn execute(&self, args: Value, _ctx: ToolContext) -> ToolResult {
        let accounts: Vec<Value> = self
            .gateway
            .accounts()
            .into_iter()
            .filter(|a| a.get("channel").and_then(Value::as_str) == Some("feishu"))
            .collect();
        let account = args
            .get("account")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                if accounts.len() == 1 {
                    accounts[0]
                        .get("account")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            });
        let account = match account {
            Some(account) => account,
            None => {
                return ToolResult::error(if accounts.is_empty() {
                    "No Feishu account in gateway.json channels.".to_string()
                } else {
                    "Several Feishu accounts, pass \"account\".".to_string()
                })
            }
        };
        match self.gateway.restart_account(&account, true).await {
            Ok(state) => ToolResult::ok(state),
            Err(err) => ToolResult::error(err.to_string()),
        }
    }
}

pub fn load_config(plugin_config: &Value) -> FeishuConfig {
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
    serde_json::from_value(merge_layers(layers)).unwrap_or_default()
}

#[derive(Default)]
pub struct GatewayFeishuPlugin;

#[async_trait]
impl Plugin for GatewayFeishuPlugin {
    fn name(&self) -> &str {
        "leo-plugin-gateway-feishu"
    }
    fn inject(&self) -> Vec<String> {
        vec!["gateway".into(), "tools".into()]
    }
    fn watch(&self) -> Vec<String> {
        vec!["credentials.json".into()]
    }
    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let gateway = ctx
            .gateway()
            .ok_or_else(|| PluginError::MissingService("gateway".into()))?;
        let driver: Arc<dyn ChannelDriver> = Arc::new(FeishuDriver {
            api: Arc::new(ReqwestFeishuApi),
            store: CredentialStore::from_config(&config),
            authorize_scanner: config.authorize_scanner,
        });
        let disposer = gateway.register_channel(driver);
        ctx.effect(disposer);

        if config.tools {
            let tool: Arc<dyn Tool> = Arc::new(BindTool { gateway: gateway.clone() });
            ctx.register_tool(tool).await?;
        }
        Ok(())
    }
}