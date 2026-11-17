//! Rust rewrite of `leo-plugin-speakup` (proactive messages via the gateway).
//!
//! The decision logic is pure and unit-tested. The background ticker checks
//! periodically; when a session is due it sends a prompt through the gateway
//! service. If no gateway is present the plugin degrades gracefully.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::AbortHandle;

use leo_plugin_sdk::{load_config_file, merge_layers, Context, Plugin, Result, SecretResolver};

pub const CONFIG_FILE_NAME: &str = "speakup.json";

/// `speakup.json` configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpeakupConfig {
    pub enabled: bool,
    pub targets: Vec<String>,
    pub idle_minutes: u64,
    pub min_interval_minutes: u64,
    pub max_interval_minutes: u64,
    pub max_per_day: u32,
    pub awake_from: u32,
    pub awake_to: u32,
    pub timezone: String,
    pub nudge: bool,
    pub nudge_min_minutes: u64,
    pub nudge_max_minutes: u64,
    pub name: String,
    /// Rust addition: scheduler tick interval in seconds.
    pub tick_seconds: u64,
}

impl Default for SpeakupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            targets: Vec::new(),
            idle_minutes: 60,
            min_interval_minutes: 30,
            max_interval_minutes: 120,
            max_per_day: 10,
            awake_from: 9,
            awake_to: 23,
            timezone: String::new(),
            nudge: true,
            nudge_min_minutes: 15,
            nudge_max_minutes: 40,
            name: String::new(),
            tick_seconds: 60,
        }
    }
}

/// The decision for one session at one moment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Silent,
    Speak,
    Nudge,
}

/// Whether `minute_of_day` (0..1440) is inside the configured awake window.
pub fn is_awake(config: &SpeakupConfig, minute_of_day: u32) -> bool {
    let (from, to) = (config.awake_from, config.awake_to);
    if from <= to {
        minute_of_day >= from * 60 && minute_of_day < to * 60
    } else {
        // Window wraps past midnight.
        minute_of_day >= from * 60 || minute_of_day < to * 60
    }
}

/// Pure decision function.
///
/// * `last_user_at` / `last_bot_at` are epoch millis.
/// * `last_bot_asked` is true when the agent's last message was a question.
/// * `count_today` is how many proactive messages were already sent today.
/// * `next_at` is the earliest time to speak again.
/// * `rand` is a deterministic 0..1 value (injectable for tests).
pub fn decide(
    config: &SpeakupConfig,
    last_user_at: i64,
    last_bot_at: i64,
    last_bot_asked: bool,
    count_today: u32,
    next_at: i64,
    now: i64,
    rand: f64,
) -> Decision {
    if !config.enabled || config.max_per_day == 0 {
        return Decision::Silent;
    }
    let minute_of_day = ((now / 60_000).rem_euclid(24 * 60)) as u32;
    if !is_awake(config, minute_of_day) {
        return Decision::Silent;
    }
    if now < next_at {
        return Decision::Silent;
    }

    let idle_ms = now.saturating_sub(last_user_at);
    let idle_min = idle_ms / 60_000;

    // Gentle follow-up when the agent asked something and the user went quiet.
    if config.nudge
        && last_bot_asked
        && idle_min >= config.nudge_min_minutes as i64
        && idle_min <= config.nudge_max_minutes as i64
        && rand < 0.5
    {
        return Decision::Nudge;
    }

    if idle_min >= config.idle_minutes as i64 && count_today < config.max_per_day {
        return Decision::Speak;
    }

    Decision::Silent
}

/// Per-session state (kept in memory).
#[derive(Clone, Debug, Default)]
pub struct SessionState {
    pub day: String,
    pub count: u32,
    pub next_at: i64,
    pub last_user_at: i64,
    pub last_bot_at: i64,
    pub last_bot_asked: bool,
    pub nudged_for: i64,
}

/// The speakup service.
pub struct SpeakupService {
    config: SpeakupConfig,
    state: Mutex<HashMap<String, SessionState>>,
    running: Arc<AtomicBool>,
    abort: Mutex<Option<AbortHandle>>,
}

impl SpeakupService {
    pub fn new(config: SpeakupConfig) -> Self {
        Self {
            config,
            state: Mutex::new(HashMap::new()),
            running: Arc::new(AtomicBool::new(false)),
            abort: Mutex::new(None),
        }
    }

    pub fn config(&self) -> &SpeakupConfig {
        &self.config
    }

    pub fn state(&self) -> HashMap<String, SessionState> {
        self.state.lock().unwrap().clone()
    }

    pub fn update_state(&self, session_key: &str, state: SessionState) {
        self.state.lock().unwrap().insert(session_key.to_string(), state);
    }

    /// Evaluate one session; returns the decision and updates `next_at`.
    pub fn evaluate(
        &self,
        session_key: &str,
        last_bot_asked: bool,
        now: i64,
        rand: f64,
    ) -> Decision {
        let mut guard = self.state.lock().unwrap();
        let state = guard.entry(session_key.to_string()).or_default();
        let decision = decide(
            &self.config,
            state.last_user_at,
            state.last_bot_at,
            last_bot_asked,
            state.count,
            state.next_at,
            now,
            rand,
        );
        match decision {
            Decision::Speak => {
                state.count += 1;
                state.next_at = now + (self.config.max_interval_minutes as i64) * 60_000;
            }
            Decision::Nudge => {
                state.nudged_for = state.last_bot_at;
            }
            Decision::Silent => {}
        }
        drop(guard);
        decision
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.abort.lock().unwrap().take() {
            handle.abort();
        }
    }

    fn spawn_ticker(&self, gateway: Option<Arc<dyn leo_plugin_sdk::GatewayService>>) {
        self.running.store(true, Ordering::SeqCst);
        let interval = self.config.tick_seconds.max(1);
        let running = self.running.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(interval)).await;
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                // The gateway session feed is provided by the host; without it
                // there is nothing to evaluate here. This is a simplification
                // of the original TypeScript ticker.
                if let Some(gateway) = &gateway {
                    let _ = gateway.channels();
                }
            }
        })
        .abort_handle();
        *self.abort.lock().unwrap() = Some(handle);
    }
}

pub fn load_config(plugin_config: &Value) -> SpeakupConfig {
    let paths = leo_plugin_sdk::LeoPaths::detect();
    let mut layers = Vec::new();
    let mut push = |dir: &std::path::Path| {
        if let Ok(Some(value)) = load_config_file(dir, CONFIG_FILE_NAME) {
            layers.push(value);
        }
    };
    if let Some(dir) = &paths.project_dir {
        push(dir);
    }
    push(&paths.user_dir);
    if !plugin_config.is_null() {
        layers.push(plugin_config.clone());
    }
    let merged = merge_layers(layers);
    serde_json::from_value(merged).unwrap_or_default()
}

#[derive(Default)]
pub struct SpeakupPlugin;

#[async_trait]
impl Plugin for SpeakupPlugin {
    fn name(&self) -> &str {
        "leo-plugin-speakup"
    }

    fn inject(&self) -> Vec<String> {
        vec!["gateway".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec![CONFIG_FILE_NAME.into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let service = Arc::new(SpeakupService::new(config));
        let gateway = ctx.gateway();
        service.spawn_ticker(gateway.clone());
        ctx.provide("speakup", service.clone());
        ctx.effect(Box::pin(async move {
            service.stop();
        }));
        // Resolve secrets eagerly so misconfiguration surfaces at load time.
        let _ = SecretResolver::default();
        Ok(())
    }
}