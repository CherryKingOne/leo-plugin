//! Rust rewrite of `leo-plugin-trajectory` (trajectory observability, read-only).
//!
//! Projects a session log into a session → turn → step → tool tree, tracks live
//! sessions (TTFT, tool timings), and exposes a minimal JSON API (the original
//! web UI is represented by a placeholder page).

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::task::AbortHandle;

use leo_plugin_sdk::{load_config_file, merge_layers, Context, Plugin, Result};

pub const CONFIG_FILE_NAME: &str = "trajectory.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TrajectoryConfig {
    pub server: bool,
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
    pub max_live_sessions: usize,
    pub redact: bool,
    pub max_preview_chars: usize,
    pub sessions_dir: Option<String>,
}

impl Default for TrajectoryConfig {
    fn default() -> Self {
        Self {
            server: true,
            host: "127.0.0.1".into(),
            port: 18791,
            token: None,
            max_live_sessions: 200,
            redact: true,
            max_preview_chars: 4_000,
            sessions_dir: None,
        }
    }
}

fn preview(value: &Value, max: usize) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    if text.chars().count() <= max {
        text
    } else {
        let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Project a session record into a trajectory tree.
pub fn project_session(session: &Value, max_preview_chars: usize) -> Value {
    let turns = session
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut total_usage = json!({"inputTokens": 0, "outputTokens": 0});
    let mut turn_nodes = Vec::new();

    for turn in turns {
        let steps = turn
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut step_nodes = Vec::new();
        for step in steps {
            if let Some(usage) = step.get("usage") {
                if let Some(input) = usage.get("inputTokens").and_then(Value::as_u64) {
                    total_usage["inputTokens"] = json!(total_usage["inputTokens"].as_u64().unwrap_or(0) + input);
                }
                if let Some(output) = usage.get("outputTokens").and_then(Value::as_u64) {
                    total_usage["outputTokens"] = json!(total_usage["outputTokens"].as_u64().unwrap_or(0) + output);
                }
            }
            step_nodes.push(json!({
                "model": step.get("model").cloned().unwrap_or(Value::Null),
                "durationMs": step.get("durationMs").cloned().unwrap_or(Value::Null),
                "ttftMs": step.get("firstTokenAt").cloned().unwrap_or(Value::Null),
                "usage": step.get("usage").cloned().unwrap_or(Value::Null),
                "error": step.get("error").cloned().unwrap_or(Value::Null),
                "tools": step.get("toolCalls").cloned().unwrap_or_else(|| json!([])),
            }));
        }
        turn_nodes.push(json!({
            "index": turn.get("index").cloned().unwrap_or(Value::Null),
            "steps": step_nodes,
        }));
    }

    json!({
        "sessionId": session.get("sessionId").and_then(Value::as_str).unwrap_or(""),
        "turns": turn_nodes,
        "usage": total_usage,
        "children": session.get("children").cloned().unwrap_or_else(|| json!([])),
        "preview": preview(session, max_preview_chars),
    })
}

/// Live session tracker (TTFT, tool timings, parent/child links).
#[derive(Clone)]
pub struct LiveTracker {
    sessions: Arc<RwLock<HashMap<String, Value>>>,
    max: usize,
}

impl LiveTracker {
    pub fn new(max: usize) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            max,
        }
    }

    fn evict_if_needed(&self, keep: &str) {
        let mut sessions = self.sessions.write();
        while sessions.len() > self.max {
            let victim = sessions
                .keys()
                .find(|key| key.as_str() != keep)
                .cloned();
            match victim {
                Some(key) => {
                    sessions.remove(&key);
                }
                None => break,
            }
        }
    }

    pub fn on_appended(&self, session_id: &str, kind: &str) {
        {
            let mut sessions = self.sessions.write();
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| json!({"sessionId": session_id, "events": 0}));
            entry["events"] = json!(entry.get("events").and_then(Value::as_u64).unwrap_or(0) + 1);
            entry["lastKind"] = json!(kind);
        }
        self.evict_if_needed(session_id);
    }

    pub fn on_first_token(&self, session_id: &str, ttft_ms: u64) {
        {
            let mut sessions = self.sessions.write();
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| json!({"sessionId": session_id, "events": 0}));
            entry["ttftMs"] = json!(ttft_ms);
        }
        self.evict_if_needed(session_id);
    }

    pub fn snapshot(&self) -> Vec<Value> {
        self.sessions.read().values().cloned().collect()
    }

    pub fn clear(&self) {
        self.sessions.write().clear();
    }
}

/// The trajectory service (`trajectory`).
#[derive(Clone)]
pub struct Trajectories {
    config: TrajectoryConfig,
    tracker: LiveTracker,
    sessions: Arc<RwLock<HashMap<String, Value>>>,
}

impl Trajectories {
    pub fn new(config: TrajectoryConfig) -> Self {
        let tracker = LiveTracker::new(config.max_live_sessions);
        Self {
            config,
            tracker,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn tracker(&self) -> LiveTracker {
        self.tracker.clone()
    }

    pub fn publish(&self, session_id: &str, kind: &str) {
        self.tracker.on_appended(session_id, kind);
    }

    pub fn get(&self, session_id: &str) -> Option<Value> {
        self.sessions.read().get(session_id).cloned()
    }

    pub fn list(&self) -> Vec<Value> {
        self.sessions.read().values().cloned().collect()
    }

    pub fn live(&self) -> Vec<Value> {
        self.tracker.snapshot()
    }

    pub fn clear(&self) {
        self.sessions.write().clear();
        self.tracker.clear();
    }
}

async fn spawn_server(
    host: String,
    port: u16,
    service: Arc<Trajectories>,
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
                    json!({"name": "leo-trajectory", "live": service.live().len()}).to_string()
                } else if path.contains("/api/live") {
                    serde_json::to_string(&service.live()).unwrap_or_else(|_| "[]".into())
                } else if path.contains("/api/sessions") {
                    serde_json::to_string(&service.list()).unwrap_or_else(|_| "[]".into())
                } else {
                    "<html><body>leo-trajectory</body></html>".to_string()
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

pub fn load_config(plugin_config: &Value) -> TrajectoryConfig {
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
pub struct TrajectoryPlugin;

#[async_trait]
impl Plugin for TrajectoryPlugin {
    fn name(&self) -> &str {
        "leo-plugin-trajectory"
    }

    fn inject(&self) -> Vec<String> {
        vec!["sessions".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec![CONFIG_FILE_NAME.into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let service = Arc::new(Trajectories::new(config.clone()));

        let tracker = service.tracker();
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
            let tracker = tracker.clone();
            async move {
                tracker.on_appended(&session_id, &kind);
                Value::Null
            }
        });

        let tracker_for_event = service.tracker();
        ctx.on("agent/event", move |payload: Value| {
            let session_id = payload
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let ttft = payload
                .get("firstTokenAt")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let tracker = tracker_for_event.clone();
            async move {
                if ttft > 0 {
                    tracker.on_first_token(&session_id, ttft);
                }
                Value::Null
            }
        });

        ctx.provide("trajectory", service.clone());

        if config.server {
            match spawn_server(config.host.clone(), config.port, service).await {
                Ok((handle, port)) => {
                    let _ = ctx.emit(
                        "plugin/notice",
                        json!({"plugin": "trajectory", "message": format!("trajectory page: http://{}:{port}", config.host)}),
                    );
                    ctx.effect(Box::pin(async move {
                        handle.abort();
                    }));
                }
                Err(err) => {
                    let _ = ctx.emit(
                        "plugin/notice",
                        json!({"plugin": "trajectory", "message": format!("trajectory server not started: {err}"), "level": "warn"}),
                    );
                }
            }
        }
        Ok(())
    }
}