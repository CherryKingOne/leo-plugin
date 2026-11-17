//! Shared contracts for plugin-to-plugin services.
//!
//! Plugins may not import each other's source (`PROTOCOL.md` §10). These
//! contracts live in the SDK so mutually independent plugins can exchange typed
//! handles (e.g. `provider-deepseek` registering a driver with `provider`).

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::context::Disposer;
use crate::error::Result;
use crate::{LlmRequest, LlmResponse};

// ———————————————————————————————— providers ————————————————————————————————

/// Prepare hook: rewrite an OpenAI-compatible request body for a vendor.
pub type PrepareFn = Arc<dyn Fn(Value, &Value) -> Value + Send + Sync>;

/// Completion hook: perform the actual model call for a driver.
pub type CompleteFn =
    Arc<dyn Fn(LlmRequest) -> futures::future::BoxFuture<'static, Result<LlmResponse>> + Send + Sync>;

/// A model-provider driver registered by a `provider-*` sub-plugin.
#[derive(Clone)]
pub struct ProviderDriver {
    pub id: String,
    pub name: String,
    pub plugin: Option<String>,
    pub base_url: Option<String>,
    pub env_keys: Vec<String>,
    pub default_model: Option<String>,
    pub models: Vec<Value>,
    pub keyless: bool,
    pub protocol: Option<String>,
    pub settings_template: Value,
    pub prepare: Option<PrepareFn>,
    pub complete: Option<CompleteFn>,
}

impl Default for ProviderDriver {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            plugin: None,
            base_url: None,
            env_keys: Vec::new(),
            default_model: None,
            models: Vec::new(),
            keyless: false,
            protocol: None,
            settings_template: Value::Null,
            prepare: None,
            complete: None,
        }
    }
}

/// The provider registry (`providers` service) exposed by `leo-plugin-provider`.
pub trait ProvidersService: Send + Sync {
    /// Register a driver. The returned disposer unregisters it.
    fn register_driver(&self, driver: ProviderDriver) -> Disposer;
    /// Ids of registered drivers.
    fn drivers(&self) -> Vec<String>;
    /// Set the default model (e.g. `deepseek/deepseek-flash`).
    fn set_default(&self, model: &str) -> Result<()>;
    /// The current default model.
    fn default_model(&self) -> Option<String>;
}

// ———————————————————————————————— gateway ————————————————————————————————

/// A chat's location on a platform.
#[derive(Clone, Debug, Default)]
pub struct GatewayChat {
    pub id: String,
    pub chat_type: String,
    pub extra: Option<HashMap<String, String>>,
}

/// The sender of an inbound message.
#[derive(Clone, Debug, Default)]
pub struct GatewaySender {
    pub id: String,
    pub name: Option<String>,
}

/// A platform-normalised inbound message.
#[derive(Clone, Debug, Default)]
pub struct InboundMessage {
    pub channel: String,
    pub account: String,
    pub id: String,
    pub chat: GatewayChat,
    pub sender: GatewaySender,
    pub text: String,
    pub mentioned: bool,
    pub timestamp: u64,
    pub raw: Option<Value>,
}

/// A send target.
#[derive(Clone, Debug, Default)]
pub struct ChannelTarget {
    pub chat_id: String,
    pub chat_type: Option<String>,
    pub extra: Option<HashMap<String, String>>,
}

/// An outbound image.
#[derive(Clone, Debug, Default)]
pub struct OutboundImage {
    pub url: String,
    pub alt: Option<String>,
}

/// An outbound message.
#[derive(Clone, Debug, Default)]
pub struct OutboundMessage {
    pub text: String,
    pub image: Option<OutboundImage>,
    pub reply_to: Option<String>,
}

/// The result of sending a message.
#[derive(Clone, Debug, Default)]
pub struct SendResult {
    pub message_ids: Vec<String>,
}

/// Everything a channel driver receives when the gateway creates a connection.
pub struct ChannelInit {
    pub account: String,
    pub options: Value,
    pub secret: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub dispatch: Arc<dyn Fn(InboundMessage) + Send + Sync>,
    pub notify: Arc<dyn Fn(&str) + Send + Sync>,
    pub authorize: Arc<dyn Fn(&str, bool) + Send + Sync>,
    pub rebind: bool,
}

impl std::fmt::Debug for ChannelInit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChannelInit")
            .field("account", &self.account)
            .field("rebind", &self.rebind)
            .finish()
    }
}

/// A running platform connection created by a [`ChannelDriver`].
#[async_trait]
pub trait ChannelConnection: Send + Sync {
    async fn start(&self) -> Result<()> {
        Ok(())
    }
    async fn send(&self, target: ChannelTarget, message: OutboundMessage) -> Result<SendResult>;
    async fn stop(&self) -> Result<()> {
        Ok(())
    }
}

/// A platform driver (Telegram / Feishu / QQ / …) registered with the gateway.
#[async_trait]
pub trait ChannelDriver: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn description(&self) -> Option<String> {
        None
    }
    fn options_schema(&self) -> Value {
        serde_json::json!({ "type": "object" })
    }
    fn secret_fields(&self) -> Vec<String> {
        Vec::new()
    }
    fn text_limit(&self) -> Option<usize> {
        None
    }
    fn images(&self) -> bool {
        false
    }
    async fn create(&self, init: ChannelInit) -> Result<Arc<dyn ChannelConnection>>;
}

/// The message gateway (`gateway` service).
#[async_trait]
pub trait GatewayService: Send + Sync {
    /// Register (or override) a channel driver. Returned disposer unregisters it.
    fn register_channel(&self, driver: Arc<dyn ChannelDriver>) -> Disposer;
    fn channels(&self) -> Vec<Value> {
        Vec::new()
    }
    fn accounts(&self) -> Vec<Value> {
        Vec::new()
    }
    async fn restart_account(&self, account: &str, rebind: bool) -> Result<Value>;
    fn session_of_agent(&self, agent_id: &str) -> Option<String> {
        let _ = agent_id;
        None
    }
    /// Send a proactive message to a target (`{"account":..,"chatId":..}`).
    async fn send(&self, target: Value, text: &str) -> Result<SendResult> {
        let _ = (target, text);
        Err(crate::PluginError::Other(
            "gateway.send is not supported by this gateway".into(),
        ))
    }
}

// ———————————————————————————————— interaction ————————————————————————————————

/// A persona definition registered by an `interaction-*` sub-plugin.
#[derive(Clone, Debug)]
pub struct PersonaDefinition {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub prompt: String,
    pub sticker_pack: Option<String>,
    pub plugin: Option<String>,
}

/// Art assets for a sticker under one variant.
#[derive(Clone, Debug, Default)]
pub struct StickerAsset {
    pub image: Option<String>,
    pub ansi: Option<Vec<String>>,
}

/// A sticker definition.
#[derive(Clone, Debug)]
pub struct StickerDefinition {
    pub id: String,
    pub text: String,
    pub visibility: Option<String>,
    pub triggers: Vec<String>,
    pub assets: HashMap<String, StickerAsset>,
}

/// A character variant of a sticker pack.
#[derive(Clone, Debug)]
pub struct StickerVariant {
    pub id: String,
    pub name: String,
}

/// A sticker pack.
#[derive(Clone, Debug)]
pub struct StickerPack {
    pub id: String,
    pub name: String,
    pub variants: Vec<StickerVariant>,
    pub default_variant: Option<String>,
    pub stickers: Vec<StickerDefinition>,
    pub credits: Option<String>,
    pub plugin: Option<String>,
}

/// The interaction registry (`interaction` service).
pub trait InteractionService: Send + Sync {
    fn register_persona(&self, persona: PersonaDefinition) -> Disposer;
    fn register_sticker_pack(&self, pack: StickerPack) -> Disposer;
    fn personas(&self) -> Vec<PersonaDefinition>;
    fn sticker_packs(&self) -> Vec<StickerPack>;
}