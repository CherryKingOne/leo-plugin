//! Rust rewrite of `leo-plugin-provider-longcat` (LongCat / Meituan).

use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{
    build_body, json, post_chat, CompleteFn, Context, Plugin, PluginError, ProviderDriver,
    LlmRequest, Result, Value,
};

pub const LONGCAT_BASE_URL: &str = "https://api.longcat.chat/openai/v1";
pub const LONGCAT_DEFAULT_MODEL: &str = "LongCat-2.5-Preview";
pub const LONGCAT_MAX_THINKING_BUDGET: u32 = 262_144;

pub fn longcat_models() -> Value {
    json!([{
        "id": LONGCAT_DEFAULT_MODEL,
        "name": "LongCat-2.5-Preview",
        "contextWindow": 1048576,
        "maxOutputTokens": 262144,
        "inputModalities": ["text"],
        "outputModalities": ["text"],
        "ownedBy": "meituan",
        "reasoning": {"supported": true, "canDisable": true, "defaultEnabled": true}
    }])
}

/// Map a generic reasoning effort to a LongCat `thinking_budget`.
pub fn effort_to_budget(effort: &str) -> Option<u32> {
    match effort {
        "none" => None,
        "minimal" | "low" => Some(8_192),
        "medium" => Some(32_768),
        "high" => Some(131_072),
        "xhigh" | "max" => Some(LONGCAT_MAX_THINKING_BUDGET),
        _ => Some(131_072),
    }
}

/// Rewrite a request body for LongCat: thinking switch + `thinking_budget`.
pub fn prepare_longcat_body(body: Value, settings: &Value) -> Value {
    let mut out = body;

    let mut enabled = match settings.get("thinking").and_then(Value::as_str) {
        Some("disabled") => Some(false),
        Some("enabled") => Some(true),
        _ => None,
    };
    if enabled.is_none() {
        if let Some("none") = settings.get("reasoningEffort").and_then(Value::as_str) {
            enabled = Some(false);
        }
    }
    let enabled = enabled.unwrap_or(true);
    out["thinking"] = json!({ "type": if enabled { "enabled" } else { "disabled" } });

    if let Some(obj) = out.as_object_mut() {
        obj.remove("reasoning_effort");
        obj.remove("thinking_budget");
        // LongCat Chat Completions rejects temperature.
        obj.remove("temperature");
    }

    if enabled {
        let effort = settings
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string);
        let budget = settings
            .get("thinkingBudget")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .or_else(|| effort.as_deref().and_then(effort_to_budget))
            .unwrap_or(131_072)
            .min(LONGCAT_MAX_THINKING_BUDGET);
        out["thinking_budget"] = json!(budget);
    } else if let Some(messages) = out.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if let Some(obj) = message.as_object_mut() {
                obj.remove("reasoning_content");
            }
        }
    }

    out
}

fn complete_hook(base_url: &'static str) -> CompleteFn {
    Arc::new(move |request: LlmRequest| {
        Box::pin(async move {
            let body = prepare_longcat_body(build_body(&request), &Value::Null);
            let key = std::env::var("LONGCAT_API_KEY").ok();
            post_chat(base_url, key.as_deref(), body).await
        })
    })
}

pub fn longcat_driver() -> ProviderDriver {
    ProviderDriver {
        id: "longcat".into(),
        name: "LongCat".into(),
        plugin: Some("provider-longcat".into()),
        base_url: Some(LONGCAT_BASE_URL.into()),
        env_keys: vec!["LONGCAT_API_KEY".into()],
        default_model: Some(LONGCAT_DEFAULT_MODEL.into()),
        models: longcat_models().as_array().cloned().unwrap_or_default(),
        keyless: false,
        protocol: Some("openai-compatible".into()),
        settings_template: json!({"defaultModel": LONGCAT_DEFAULT_MODEL, "thinking": "enabled"}),
        prepare: Some(Arc::new(|body, settings| prepare_longcat_body(body, settings))),
        complete: Some(complete_hook(LONGCAT_BASE_URL)),
    }
}

#[derive(Default)]
pub struct ProviderLongcatPlugin;

#[async_trait]
impl Plugin for ProviderLongcatPlugin {
    fn name(&self) -> &str {
        "leo-plugin-provider-longcat"
    }

    fn inject(&self) -> Vec<String> {
        vec!["providers".into()]
    }

    async fn apply(&self, ctx: Context, _config: Value) -> Result<()> {
        let providers = ctx
            .providers()
            .ok_or_else(|| PluginError::MissingService("providers".into()))?;
        let disposer = providers.register_driver(longcat_driver());
        ctx.effect(disposer);
        Ok(())
    }
}