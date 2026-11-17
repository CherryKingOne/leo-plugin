//! The plugin contract.

use serde_json::Value;

use crate::context::Context;
use crate::error::Result;

/// A plugin: the unit of code loaded by the host.
///
/// Implementors declare metadata and register capabilities in
/// [`Plugin::apply`]. Everything registered through the [`Context`] is revoked
/// on unload, so a plugin can be loaded, unloaded and loaded again safely.
#[async_trait::async_trait]
pub trait Plugin: Send + Sync {
    /// Plugin name. Official plugins use the crate/package name
    /// `leo-plugin-<id>`.
    fn name(&self) -> &str;

    /// Service keys that must be ready before `apply` runs.
    fn inject(&self) -> Vec<String> {
        Vec::new()
    }

    /// Data files (relative to `.leo/`) that trigger a reload when changed.
    fn watch(&self) -> Vec<String> {
        Vec::new()
    }

    /// JSON Schema describing the plugin configuration.
    fn config_schema(&self) -> Value {
        serde_json::json!({ "type": "object" })
    }

    /// Entry point. Register services, event handlers and tools here.
    async fn apply(&self, ctx: Context, config: Value) -> Result<()>;
}

/// Static plugin metadata, derived from a [`Plugin`].
#[derive(Clone, Debug)]
pub struct PluginInfo {
    pub name: String,
    pub inject: Vec<String>,
    pub watch: Vec<String>,
    pub config_schema: Value,
}

impl PluginInfo {
    pub fn of(plugin: &dyn Plugin) -> Self {
        Self {
            name: plugin.name().to_string(),
            inject: plugin.inject(),
            watch: plugin.watch(),
            config_schema: plugin.config_schema(),
        }
    }
}