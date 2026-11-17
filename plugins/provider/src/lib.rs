//! Rust rewrite of `leo-plugin-provider` (model provider registry layer).
//!
//! Sub-plugins register [`ProviderDriver`]s; this plugin merges configuration,
//! resolves keys, and exposes both `providers` (`ProvidersService`) and `llm`
//! (`LlmService`). A built-in OpenAI-compatible driver covers any endpoint that
//! only needs a `baseURL`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use leo_plugin_sdk::{
    build_body, load_config_file, merge_layers, post_chat, resolve_secret, CompleteFn, Context,
    Disposer, LlmRequest, LlmResponse, LlmService, Plugin, PluginError, ProviderDriver,
    ProvidersService, Result, SecretResolver,
};

pub const CONFIG_FILE_NAME: &str = "provider.json";
pub const OPENAI_COMPATIBLE: &str = "openai-compatible";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderSettings {
    pub driver: Option<String>,
    pub protocol: Option<String>,
    pub enabled: bool,
    pub default: bool,
    #[serde(alias = "baseURL")]
    pub base_url: Option<String>,
    #[serde(alias = "apiKey")]
    pub api_key: Option<String>,
    #[serde(alias = "apiKeyEnv")]
    pub api_key_env: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub models: Option<Vec<Value>>,
    #[serde(alias = "defaultModel")]
    pub default_model: Option<String>,
    pub keyless: bool,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            driver: None,
            protocol: None,
            enabled: true,
            default: false,
            base_url: None,
            api_key: None,
            api_key_env: None,
            headers: None,
            models: None,
            default_model: None,
            keyless: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderConfig {
    pub model: Option<String>,
    #[serde(alias = "autoDetect")]
    pub auto_detect: bool,
    pub providers: HashMap<String, ProviderSettings>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            model: None,
            auto_detect: true,
            providers: HashMap::new(),
        }
    }
}

/// Resolve a provider API key from settings / environment / credentials.
pub fn resolve_api_key(settings: &ProviderSettings, credentials: Option<&dyn leo_plugin_sdk::CredentialsService>) -> Option<String> {
    // This synchronous helper only consults env and literal values; async
    // credential lookup is handled by the driver complete hook.
    if let Some(env) = &settings.api_key_env {
        if let Ok(value) = std::env::var(env) {
            return Some(value);
        }
    }
    if let Some(reference) = &settings.api_key {
        if let Ok(value) = resolve_secret(reference, &SecretResolver::default()) {
            return Some(value);
        }
    }
    let _ = credentials;
    None
}

fn complete_from_settings(base_url: String, api_key_env: Option<String>, api_key: Option<String>) -> CompleteFn {
    Arc::new(move |request: LlmRequest| {
        let base_url = base_url.clone();
        let api_key_env = api_key_env.clone();
        let api_key = api_key.clone();
        Box::pin(async move {
            let body = build_body(&request);
            let key = api_key_env
                .and_then(|env| std::env::var(env).ok())
                .or(api_key);
            post_chat(&base_url, key.as_deref(), body).await
        })
    })
}

/// The provider registry.
#[derive(Clone)]
pub struct ProviderRegistry {
    drivers: Arc<RwLock<Vec<ProviderDriver>>>,
    default_model: Arc<RwLock<Option<String>>>,
    config: ProviderConfig,
}

impl ProviderRegistry {
    pub fn new(config: ProviderConfig) -> Self {
        let default_model = config
            .model
            .clone()
            .or_else(|| {
                config
                    .providers
                    .iter()
                    .find(|(_, s)| s.default)
                    .and_then(|(_, s)| s.default_model.clone().or(config.model.clone()))
            });
        Self {
            drivers: Arc::new(RwLock::new(Vec::new())),
            default_model: Arc::new(RwLock::new(default_model)),
            config,
        }
    }

    fn driver(&self, id: &str) -> Option<ProviderDriver> {
        self.drivers.read().iter().find(|d| d.id == id).cloned()
    }

    /// Register drivers for configured providers that have no sub-plugin driver.
    pub fn sync_config_drivers(&self) {
        for (id, settings) in &self.config.providers {
            if !settings.enabled || self.driver(id).is_some() {
                continue;
            }
            let driver_id = settings.driver.clone().unwrap_or_else(|| id.clone());
            let base_url = settings.base_url.clone().or_else(|| {
                self.driver(&driver_id).and_then(|d| d.base_url)
            });
            let complete = base_url.as_ref().map(|url| {
                complete_from_settings(
                    url.clone(),
                    settings.api_key_env.clone(),
                    settings.api_key.clone(),
                )
            });
            let driver = ProviderDriver {
                id: id.clone(),
                name: id.clone(),
                plugin: Some("provider".into()),
                base_url,
                env_keys: settings.api_key_env.clone().into_iter().collect(),
                default_model: settings.default_model.clone(),
                models: settings.models.clone().unwrap_or_default(),
                keyless: settings.keyless,
                protocol: Some(
                    settings
                        .protocol
                        .clone()
                        .unwrap_or_else(|| OPENAI_COMPATIBLE.into()),
                ),
                settings_template: json!({}),
                prepare: None,
                complete,
            };
            let mut drivers = self.drivers.write();
            drivers.retain(|d| d.id != driver.id);
            drivers.push(driver);
        }
    }
}

impl ProvidersService for ProviderRegistry {
    fn register_driver(&self, driver: ProviderDriver) -> Disposer {
        let id = driver.id.clone();
        {
            let mut drivers = self.drivers.write();
            drivers.retain(|d| d.id != id);
            drivers.push(driver);
        }
        let drivers = self.drivers.clone();
        Box::pin(async move {
            drivers.write().retain(|d| d.id != id);
        })
    }

    fn drivers(&self) -> Vec<String> {
        self.drivers.read().iter().map(|d| d.id.clone()).collect()
    }

    fn set_default(&self, model: &str) -> Result<()> {
        *self.default_model.write() = Some(model.to_string());
        Ok(())
    }

    fn default_model(&self) -> Option<String> {
        self.default_model.read().clone()
    }
}

#[async_trait]
impl LlmService for ProviderRegistry {
    async fn complete(&self, request: LlmRequest) -> Result<LlmResponse> {
        let model = request.model.clone();
        let (provider_id, model_name) = match model.split_once('/') {
            Some((provider, name)) => (provider.to_string(), name.to_string()),
            None => (model.clone(), model.clone()),
        };
        let driver = self
            .driver(&provider_id)
            .ok_or_else(|| PluginError::other(format!("no provider driver for '{provider_id}'")))?;

        let mut request = request;
        request.model = model_name;

        if let Some(complete) = &driver.complete {
            return complete(request).await;
        }

        let base_url = driver
            .base_url
            .clone()
            .ok_or_else(|| PluginError::other(format!("provider '{provider_id}' needs a baseURL")))?;
        let body = build_body(&request);
        post_chat(&base_url, None, body).await
    }

    fn models(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for driver in self.drivers.read().iter() {
            out.extend(driver.models.clone());
        }
        out
    }
}

pub fn load_config(plugin_config: &Value) -> ProviderConfig {
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

#[derive(Default)]
pub struct ProviderPlugin;

#[async_trait]
impl Plugin for ProviderPlugin {
    fn name(&self) -> &str {
        "leo-plugin-provider"
    }

    fn inject(&self) -> Vec<String> {
        vec!["llm".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec![CONFIG_FILE_NAME.into(), "credentials.json".into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let registry = Arc::new(ProviderRegistry::new(load_config(&config)));
        registry.sync_config_drivers();
        ctx.provide_providers(registry.clone());
        ctx.provide_llm(registry);
        Ok(())
    }
}