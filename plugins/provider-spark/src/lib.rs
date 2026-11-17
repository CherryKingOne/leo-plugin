//! Rust rewrite of `leo-plugin-provider-spark` (iFlytek Spark).

use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{
    build_body, json, post_chat, CompleteFn, Context, Plugin, PluginError, ProviderDriver,
    LlmRequest, Result, Value,
};

pub const SPARK_BASE_URL: &str = "https://maas-api.cn-huabei-1.xf-yun.com/v2";
pub const SPARK_DEFAULT_MODEL: &str = "spark-x2.6";
pub const SPARK_MAX_TOOLS: usize = 128;

fn model(id: &str, name: &str, context_window: u64) -> Value {
    json!({
        "id": id, "name": name, "contextWindow": context_window,
        "inputModalities": ["text"], "outputModalities": ["text"],
        "ownedBy": "iflytek",
        "reasoning": {"supported": true, "canDisable": true, "defaultEnabled": true}
    })
}

pub fn spark_models() -> Value {
    json!([
        model("spark-x2.6", "Spark-X2.6", 1_048_576),
        model("spark-x2.6-4b", "Spark-X2.6-4B", 1_048_576),
        model("spark-x2.6-preview", "Spark-X2.6-Preview", 262_144),
        model("spark-x2.5", "Spark-X2.5", 262_144),
        model("spark-x2.5-4b", "Spark-X2.5-4B", 1_048_576),
        model("spark-x2.5-1.7b", "Spark-X2.5-1.7B", 1_048_576),
    ])
}

/// Rewrite a request body for Spark: thinking type and removal of unsupported
/// sampling parameters / historical reasoning content.
pub fn prepare_spark_body(body: Value, settings: &Value) -> Value {
    let mut out = body;

    let thinking = settings
        .get("thinking")
        .and_then(Value::as_str)
        .unwrap_or("enabled");
    let thinking = match thinking {
        "enabled" | "disabled" | "auto" => thinking,
        _ => "enabled",
    };
    out["thinking"] = json!({ "type": thinking });

    if let Some(obj) = out.as_object_mut() {
        for key in [
            "temperature",
            "top_p",
            "presence_penalty",
            "frequency_penalty",
            "reasoning_effort",
            "thinking_budget",
        ] {
            obj.remove(key);
        }
    }

    if let Some(messages) = out.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if let Some(obj) = message.as_object_mut() {
                obj.remove("reasoning_content");
                obj.remove("reasoning");
            }
        }
    }

    if let Some(tools) = out.get("tools").and_then(Value::as_array) {
        if tools.len() > SPARK_MAX_TOOLS {
            out["tools"] = json!(tools[..SPARK_MAX_TOOLS].to_vec());
        }
    }

    out
}

fn complete_hook(base_url: &'static str) -> CompleteFn {
    Arc::new(move |request: LlmRequest| {
        Box::pin(async move {
            let body = prepare_spark_body(build_body(&request), &Value::Null);
            let key = std::env::var("SPARK_API_KEY")
                .ok()
                .or_else(|| std::env::var("SPARK_API_PASSWORD").ok());
            post_chat(base_url, key.as_deref(), body).await
        })
    })
}

pub fn spark_driver() -> ProviderDriver {
    ProviderDriver {
        id: "spark".into(),
        name: "Spark".into(),
        plugin: Some("provider-spark".into()),
        base_url: Some(SPARK_BASE_URL.into()),
        env_keys: vec!["SPARK_API_KEY".into(), "SPARK_API_PASSWORD".into()],
        default_model: Some(SPARK_DEFAULT_MODEL.into()),
        models: spark_models().as_array().cloned().unwrap_or_default(),
        keyless: false,
        protocol: Some("openai-compatible".into()),
        settings_template: json!({"defaultModel": SPARK_DEFAULT_MODEL, "thinking": "enabled"}),
        prepare: Some(Arc::new(|body, settings| prepare_spark_body(body, settings))),
        complete: Some(complete_hook(SPARK_BASE_URL)),
    }
}

#[derive(Default)]
pub struct ProviderSparkPlugin;

#[async_trait]
impl Plugin for ProviderSparkPlugin {
    fn name(&self) -> &str {
        "leo-plugin-provider-spark"
    }

    fn inject(&self) -> Vec<String> {
        vec!["providers".into()]
    }

    async fn apply(&self, ctx: Context, _config: Value) -> Result<()> {
        let providers = ctx
            .providers()
            .ok_or_else(|| PluginError::MissingService("providers".into()))?;
        let disposer = providers.register_driver(spark_driver());
        ctx.effect(disposer);
        Ok(())
    }
}