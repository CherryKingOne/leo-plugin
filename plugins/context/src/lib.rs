//! Rust rewrite of `leo-plugin-context` (context observability, read-only).
//!
//! Computes per-request context composition, token estimates, redaction and
//! cross-session insights, and exposes a minimal JSON API (the original web UI
//! is represented by a placeholder page).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::task::AbortHandle;

use leo_plugin_sdk::{load_config_file, merge_layers, Context, Plugin, Result};

pub const CONFIG_FILE_NAME: &str = "context.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContextConfig {
    pub server: bool,
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
    pub redact: bool,
    pub max_preview_chars: usize,
    pub max_sessions: usize,
    pub cache_sessions: usize,
    pub max_commands: usize,
    pub sessions_dir: Option<String>,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            server: true,
            host: "127.0.0.1".into(),
            port: 18792,
            token: None,
            redact: true,
            max_preview_chars: 2_000,
            max_sessions: 300,
            cache_sessions: 20,
            max_commands: 500,
            sessions_dir: None,
        }
    }
}

/// Approximate token count (~4 characters per token).
pub fn approx_tokens(text: &str) -> u64 {
    (text.chars().count() as f64 / 4.0).ceil() as u64
}

/// Classify messages by role and size.
pub fn message_composition(messages: &[Value]) -> Value {
    let mut by_role: HashMap<String, (u64, u64)> = HashMap::new();
    let mut total_tokens = 0u64;
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let text = message
            .get("content")
            .map(content_to_string)
            .unwrap_or_default();
        let tokens = approx_tokens(&text);
        let entry = by_role.entry(role).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += tokens;
        total_tokens += tokens;
    }
    let mut roles = serde_json::Map::new();
    for (role, (count, tokens)) in by_role {
        roles.insert(role, json!({"messages": count, "tokens": tokens}));
    }
    json!({
        "totalMessages": messages.len(),
        "totalTokens": total_tokens,
        "byRole": roles,
    })
}

fn content_to_string(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(""),
        other => other.to_string(),
    }
}

/// Redact secret-looking substrings.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    let markers = ["sk-", "Bearer ", "api_key=", "token="];
    let mut search_from = 0usize;
    while search_from < out.len() {
        let mut found: Option<(usize, &str)> = None;
        for marker in markers {
            if let Some(index) = out[search_from..].find(marker) {
                let start = search_from + index;
                match found {
                    Some((best, _)) if best <= start => {}
                    _ => found = Some((start, marker)),
                }
            }
        }
        let (start, marker) = match found {
            Some(found) => found,
            None => break,
        };
        let value_start = start + marker.len();
        let end = out[value_start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
            .unwrap_or(out.len() - value_start);
        if end == 0 {
            search_from = value_start;
            continue;
        }
        let value = &out[value_start..value_start + end];
        if value == "***" {
            search_from = value_start + end;
            continue;
        }
        out.replace_range(value_start..value_start + end, "***");
        search_from = value_start + 3;
    }
    out
}

/// Analyze one session record.
pub fn analyze_session(session: &Value) -> Value {
    let messages = session
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let composition = message_composition(&messages);
    let usage = session.get("usage").cloned().unwrap_or(Value::Null);
    json!({
        "sessionId": session.get("sessionId").and_then(Value::as_str).unwrap_or(""),
        "composition": composition,
        "usage": usage,
    })
}

/// Context insights service (`contextInsight`).
pub struct ContextInsights {
    config: ContextConfig,
    touched: RwLock<HashMap<String, Value>>,
    cache: RwLock<HashMap<String, Value>>,
    updates: AtomicU64,
}

impl ContextInsights {
    pub fn new(config: ContextConfig) -> Self {
        Self {
            config,
            touched: RwLock::new(HashMap::new()),
            cache: RwLock::new(HashMap::new()),
            updates: AtomicU64::new(0),
        }
    }

    pub fn touch(&self, session_id: &str, kind: &str) {
        let mut touched = self.touched.write();
        let entry = touched
            .entry(session_id.to_string())
            .or_insert_with(|| json!({"sessionId": session_id, "events": 0}));
        entry["events"] = json!(entry.get("events").and_then(Value::as_u64).unwrap_or(0) + 1);
        entry["lastKind"] = json!(kind);
        self.updates.fetch_add(1, Ordering::SeqCst);
    }

    pub fn snapshot(&self) -> Vec<Value> {
        let mut sessions: Vec<Value> = self.touched.read().values().cloned().collect();
        sessions.truncate(self.config.max_sessions);
        sessions
    }

    pub fn get(&self, session_id: &str) -> Option<Value> {
        if let Some(hit) = self.cache.read().get(session_id) {
            return Some(hit.clone());
        }
        let session = self.touched.read().get(session_id).cloned()?;
        let analysis = analyze_session(&session);
        let mut cache = self.cache.write();
        if cache.len() >= self.config.cache_sessions {
            if let Some(key) = cache.keys().next().cloned() {
                cache.remove(&key);
            }
        }
        cache.insert(session_id.to_string(), analysis.clone());
        Some(analysis)
    }

    pub fn updates(&self) -> u64 {
        self.updates.load(Ordering::SeqCst)
    }

    pub fn clear(&self) {
        self.touched.write().clear();
        self.cache.write().clear();
    }
}

async fn spawn_server(
    host: String,
    port: u16,
    service: Arc<ContextInsights>,
) -> std::io::Result<(AbortHandle, u16)> {
    let listener = TcpListener::bind(format!("{host}:{port}")).await?;
    let addr = listener.local_addr()?;
    let handle = tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => break,
            };
            let service = service.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let request = String::from_utf8_lossy(&buf);
                let path = request.lines().next().unwrap_or("");
                let body = if path.contains("/api/status") {
                    json!({"name": "leo-context", "sessions": service.snapshot().len(), "updates": service.updates()}).to_string()
                } else if path.contains("/api/sessions") {
                    serde_json::to_string(&service.snapshot()).unwrap_or_else(|_| "[]".into())
                } else if path.contains("/api/insights") {
                    json!({"sessions": service.snapshot().len()}).to_string()
                } else {
                    "<html><body>leo-context</body></html>".to_string()
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

pub fn load_config(plugin_config: &Value) -> ContextConfig {
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
pub struct ContextPlugin;

#[async_trait]
impl Plugin for ContextPlugin {
    fn name(&self) -> &str {
        "leo-plugin-context"
    }

    fn inject(&self) -> Vec<String> {
        vec!["sessions".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec![CONFIG_FILE_NAME.into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let service = Arc::new(ContextInsights::new(config.clone()));

        let service_for_event = service.clone();
        ctx.on("session/appended", move |payload: Value| {
            let session_id = payload
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let kind = payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("event")
                .to_string();
            let service = service_for_event.clone();
            async move {
                service.touch(&session_id, &kind);
                Value::Null
            }
        });

        ctx.provide("contextInsight", service.clone());

        if config.server {
            match spawn_server(config.host.clone(), config.port, service).await {
                Ok((handle, port)) => {
                    let _ = ctx.emit(
                        "plugin/notice",
                        json!({"plugin": "context", "message": format!("context page: http://{}:{port}", config.host)}),
                    );
                    ctx.effect(Box::pin(async move {
                        handle.abort();
                    }));
                }
                Err(err) => {
                    let _ = ctx.emit(
                        "plugin/notice",
                        json!({"plugin": "context", "message": format!("context server not started: {err}"), "level": "warn"}),
                    );
                }
            }
        }
        Ok(())
    }
}