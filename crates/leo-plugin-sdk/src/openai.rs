//! Minimal OpenAI-compatible Chat Completions client.
//!
//! Shared by `leo-plugin-provider` and the `provider-*` sub-plugins so they do
//! not each re-implement HTTP. The request body can be customised (vendor
//! prepare hooks) before it is sent.

use serde_json::{json, Value};

use crate::error::{PluginError, Result};
use crate::{LlmRequest, LlmResponse};

/// Build the default OpenAI-compatible request body for `request`.
pub fn build_body(request: &LlmRequest) -> Value {
    let mut body = json!({
        "model": request.model,
        "messages": request.messages,
    });
    if !request.tools.is_empty() {
        body["tools"] = json!(request.tools);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(reasoning) = &request.reasoning {
        body["reasoning"] = reasoning.clone();
    }
    if request.stream {
        body["stream"] = json!(true);
    }
    body
}

/// POST an already-built body to `{base_url}/chat/completions` and parse the
/// non-streaming response.
pub async fn post_chat(base_url: &str, api_key: Option<&str>, body: Value) -> Result<LlmResponse> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| PluginError::Other(format!("http client: {e}")))?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut req = client.post(&url).header("Content-Type", "application/json");
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }
    let response = req
        .json(&body)
        .send()
        .await
        .map_err(|e| PluginError::Other(format!("request failed: {e}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| PluginError::Other(format!("reading response: {e}")))?;
    if !status.is_success() {
        return Err(PluginError::Other(format!(
            "provider returned {}: {}",
            status,
            truncate(&text, 500)
        )));
    }
    let value: Value = serde_json::from_str(&text)?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_calls = value
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let usage = value.get("usage").cloned().unwrap_or(Value::Null);
    Ok(LlmResponse {
        text: content,
        tool_calls,
        usage,
        raw: value,
    })
}

/// Convenience: build the default body and POST it.
pub async fn complete(base_url: &str, api_key: Option<&str>, request: &LlmRequest) -> Result<LlmResponse> {
    post_chat(base_url, api_key, build_body(request)).await
}

/// Truncate a string to `max` chars, appending an ellipsis.
pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}