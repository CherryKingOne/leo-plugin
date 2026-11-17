//! # leo-plugin-sdk
//!
//! Shared runtime and plugin contract for the Rust rewrite of the
//! [leo-agents](https://github.com/CherryKingOne/leo-agents) plugin repository.
//!
//! The original plugins were TypeScript ESM modules loaded by a TypeScript host.
//! In this rewrite every plugin is a Rust crate implementing [`Plugin`]. A
//! plugin receives a [`Context`] in [`Plugin::apply`] and registers services,
//! event handlers and tools through it; everything registered through the
//! context is revoked when the plugin is unloaded (hot reload).
//!
//! ## Layout
//!
//! * [`Plugin`] – the unit of code. Declare `name`, `inject`, `watch`, a config
//!   schema and an async `apply`.
//! * [`Context`] – plugin-scoped capability handle: `provide`/`get` services,
//!   `on`/`emit` events, `effect` for revocable side effects, `fork` for
//!   tenant/agent scopes, `logger`, `tenant`, `signal`.
//! * [`Tool`] – a model-callable tool with a JSON-Schema parameter list.
//! * [`runtime`] – drives a plugin over newline-delimited JSON-RPC on stdio so
//!   plugins can run as subprocesses (`leo-plugin-host`).
//!
//! ## Example
//!
//! ```
//! use async_trait::async_trait;
//! use leo_plugin_sdk::{Context, Plugin, Result, Tool, ToolContext, ToolResult, json};
//! use serde_json::Value;
//!
//! struct Echo;
//!
//! #[async_trait]
//! impl Tool for Echo {
//!     fn name(&self) -> &str { "template_echo" }
//!     fn description(&self) -> &str { "Echo the input text back." }
//!     fn parameters(&self) -> Value {
//!         json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] })
//!     }
//!     async fn execute(&self, args: Value, _ctx: ToolContext) -> ToolResult {
//!         ToolResult::ok(args.get("text").cloned().unwrap_or(Value::Null))
//!     }
//! }
//!
//! struct EchoPlugin;
//!
//! #[async_trait]
//! impl Plugin for EchoPlugin {
//!     fn name(&self) -> &str { "leo-plugin-template" }
//!     fn inject(&self) -> Vec<String> { vec!["tools".into()] }
//!     async fn apply(&self, ctx: Context, _config: Value) -> Result<()> {
//!         ctx.register_tool(std::sync::Arc::new(Echo)).await?;
//!         Ok(())
//!     }
//! }
//! ```

mod config;
mod context;
mod contracts;
mod error;
mod events;
mod jsonc;
mod logger;
mod openai;
mod paths;
mod plugin;
mod secret;
mod services;
mod tool;
mod value;

pub mod runtime;

pub use config::{load_config_file, merge_json, merge_layers, ConfigError};
pub use context::{
    ApprovalHandle, Context, ContextHandle, CredentialsHandle, Disposer, GatewayHandle,
    HandlerFuture, InteractionHandle, LlmHandle, ProvidersHandle, SessionsHandle, ToolsHandle,
};
pub use contracts::{
    ChannelConnection, ChannelDriver, ChannelInit, ChannelTarget, CompleteFn, GatewayChat,
    GatewayService, GatewaySender, InboundMessage, InteractionService, OutboundImage,
    OutboundMessage, PersonaDefinition, PrepareFn, ProviderDriver, ProvidersService, SendResult,
    StickerAsset, StickerDefinition, StickerPack, StickerVariant,
};
pub use error::{PluginError, Result, ToolError};
pub use events::{dispatch, Dispatch, EventDef, EventHandler, EventMode};
pub use jsonc::{parse_jsonc, strip_jsonc};
pub use logger::{ConsoleLogger, Level, Logger, NullLogger, SharedLogger};
pub use openai::{build_body, complete, post_chat, truncate};
pub use paths::LeoPaths;
pub use plugin::{Plugin, PluginInfo};
pub use secret::{
    resolve_secret, resolve_secret_default, CredLookup, EnvLookup, SecretResolver,
};
pub use services::{
    ApprovalDecision, ApprovalRequest, ApprovalService, BasicContextService, BasicTools,
    ContextSection, ContextService, CredentialsService, DenyApproval, LlmRequest, LlmResponse,
    LlmService, SessionsService, ToolCall, ToolInfo, ToolsService,
};
pub use tool::{Tool, ToolContext, ToolResult};
pub use value::{json, merge, object, to_value, value_error, Value};

/// Resolve a secret with an explicit resolver.
pub fn resolve_secret_with(input: &str, resolver: &SecretResolver) -> std::result::Result<String, String> {
    secret::resolve_secret(input, resolver)
}

/// A convenience trait alias used in docs/tests.
pub mod prelude {
    pub use crate::{
        json, Context, EventDef, EventMode, LeoPaths, Logger, NullLogger, Plugin, PluginError,
        Result, Tool, ToolContext, ToolsService, ToolResult, Value,
    };
    pub use async_trait::async_trait;
    pub use serde_json::{json as json_macro, Value as JsonValue};
}