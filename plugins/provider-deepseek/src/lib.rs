//! Rust rewrite of `leo-plugin-provider-deepseek`.
//!
//! Registers the `deepseek` driver with the provider registry. The request-body
//! preparation (legacy model rewrite, thinking on/off, reasoning effort) is
//! pure and unit-tested; the network call is an OpenAI-compatible chat
//! completion performed by the shared SDK helper.

use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{
    build_body, json, post_chat, CompleteFn, Context, Plugin, PluginError, ProviderDriver,
    LlmRequest, Result, Value,
};

pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
pub const DEEPSEEK_DEFAULT_MODEL: &str = "deepseek-flash";

/// Built-in model metadata (offline / no key).
pub fn deepseek_models() -> Value {
    json!([
        {
            "id": "deepseek-flash", "name": "DeepSeek-V4.1-Flash",
            "contextWindow": 1048576, "maxOutputTokens": 393216,
            "inputModalities": ["text", "image"], "outputModalities": ["text"],
            "ownedBy": "deepseek",
            "pricing": {"inputPerMTok": 0.3, "cachedInputPerMTok": 0.006, "outputPerMTok": 1.2}
        },
        {
            "id": "deepseek-v4-pro", "name": "DeepSeek-V4-Pro",
            "contextWindow": 1048576, "maxOutputTokens": 393216,
            "inputModalities": ["text"], "outputModalities": ["text"],
            "ownedBy": "deepseek",
            "pricing": {"inputPerMTok": 1.32, "cachedInputPerMTok": 0.044, "outputPerMTok": 3.96}
        }
    ])
}

/// Rewrite a request body for DeepSeek.
///
/// * `deepseek-chat` / `deepseek-reasoner` → `deepseek-flash`
/// * thinking on/off (`thinking: {type}`), default on
/// * `reasoning_effort` from settings (minimal→low, medium/xhigh→high)
/// * drop historical `reasoning_content` when thinking is off
pub fn prepare_deepseek_body(body: Value, settings: &Value) -> Value {
    let mut out = body;

    let mut legacy_thinking: Option<bool> = None;
    if let Some(model) = out.get("model").and_then(Value::as_str).map(str::to_string) {
        let rewritten = match model.as_str() {
            "deepseek-chat" => Some(("deepseek-flash", false)),
            "deepseek-reasoner" => Some(("deepseek-flash", true)),
            _ => None,
        };
        if let Some((target, thinking)) = rewritten {
            out["model"] = json!(target);
            legacy_thinking = Some(thinking);
        }
    }

    let settings_thinking = settings.get("thinking").and_then(Value::as_str);
    let mut enabled = match settings_thinking {
        Some("disabled") => Some(false),
        Some("enabled") => Some(true),
        _ => None,
    };
    if enabled.is_none() {
        enabled = legacy_thinking;
    }
    let effort = settings
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .map(str::to_string);

    // Thinking mode does not support tool_choice=required / named tool.
    if let Some(choice) = out.get("tool_choice") {
        if !choice.is_null() && choice != "auto" && choice != "none" {
            enabled = Some(false);
        }
    }
    let enabled = enabled.unwrap_or(true);
    out["thinking"] = json!({ "type": if enabled { "enabled" } else { "disabled" } });

    if let Some(obj) = out.as_object_mut() {
        obj.remove("reasoning_effort");
    }

    if enabled {
        if let Some(effort) = effort {
            let mapped = match effort.as_str() {
                "none" => None,
                "minimal" => Some("low"),
                "medium" | "xhigh" => Some("high"),
                other => Some(other),
            };
            if let Some(level) = mapped {
                if level != "none" {
                    out["reasoning_effort"] = json!(level);
                }
            }
        }
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
            let body = prepare_deepseek_body(build_body(&request), &Value::Null);
            let key = std::env::var("DEEPSEEK_API_KEY").ok();
            post_chat(base_url, key.as_deref(), body).await
        })
    })
}

/// Build the DeepSeek driver.
pub fn deepseek_driver() -> ProviderDriver {
    ProviderDriver {
        id: "deepseek".into(),
        name: "DeepSeek".into(),
        plugin: Some("provider-deepseek".into()),
        base_url: Some(DEEPSEEK_BASE_URL.into()),
        env_keys: vec!["DEEPSEEK_API_KEY".into()],
        default_model: Some(DEEPSEEK_DEFAULT_MODEL.into()),
        models: deepseek_models().as_array().cloned().unwrap_or_default(),
        keyless: false,
        protocol: Some("openai-compatible".into()),
        settings_template: json!({
            "defaultModel": DEEPSEEK_DEFAULT_MODEL,
            "thinking": "enabled",
            "reasoningEffort": "high"
        }),
        prepare: Some(Arc::new(|body, settings| {
            prepare_deepseek_body(body, settings)
        })),
        complete: Some(complete_hook(DEEPSEEK_BASE_URL)),
    }
}

#[derive(Default)]
pub struct ProviderDeepseekPlugin;

#[async_trait]
impl Plugin for ProviderDeepseekPlugin {
    fn name(&self) -> &str {
        "leo-plugin-provider-deepseek"
    }

    fn inject(&self) -> Vec<String> {
        vec!["providers".into()]
    }

    async fn apply(&self, ctx: Context, _config: Value) -> Result<()> {
        let providers = ctx
            .providers()
            .ok_or_else(|| PluginError::MissingService("providers".into()))?;
        let disposer = providers.register_driver(deepseek_driver());
        ctx.effect(disposer);
        Ok(())
    }
}