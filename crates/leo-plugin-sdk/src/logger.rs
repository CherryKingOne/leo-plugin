//! Structured logging for plugins.
//!
//! The original host injected a `ctx.logger` with `trace/debug/info/warn/error`
//! levels and structured key/value fields. This trait keeps the same shape and
//! ships two implementations: [`ConsoleLogger`] (writes to stderr) and
//! [`NullLogger`] (drops everything).

use std::fmt::Arguments;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

/// Log levels, ordered by increasing severity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Level {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warn = 3,
    Error = 4,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }

    fn parse(s: &str) -> Option<Level> {
        match s.to_ascii_lowercase().as_str() {
            "trace" => Some(Level::Trace),
            "debug" => Some(Level::Debug),
            "info" => Some(Level::Info),
            "warn" | "warning" => Some(Level::Warn),
            "error" => Some(Level::Error),
            _ => None,
        }
    }
}

impl std::fmt::Display for Level {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A structured logger. `fields` is a JSON object of structured key/values and
/// `message` is the human-readable message.
pub trait Logger: Send + Sync {
    fn log(&self, level: Level, fields: serde_json::Value, message: &str);

    fn trace(&self, message: &str) {
        self.log(Level::Trace, serde_json::Value::Null, message);
    }
    fn debug(&self, message: &str) {
        self.log(Level::Debug, serde_json::Value::Null, message);
    }
    fn info(&self, message: &str) {
        self.log(Level::Info, serde_json::Value::Null, message);
    }
    fn warn(&self, message: &str) {
        self.log(Level::Warn, serde_json::Value::Null, message);
    }
    fn error(&self, message: &str) {
        self.log(Level::Error, serde_json::Value::Null, message);
    }

    fn with(&self, fields: serde_json::Value, message: &str) {
        self.log(Level::Info, fields, message);
    }
}

/// Logger that discards all records.
#[derive(Clone, Copy, Default)]
pub struct NullLogger;

impl Logger for NullLogger {
    fn log(&self, _level: Level, _fields: serde_json::Value, _message: &str) {}
}

/// Logger that writes `LEVEL message {fields}` lines to stderr.
pub struct ConsoleLogger {
    min_level: AtomicU8,
    target: String,
}

impl Default for ConsoleLogger {
    fn default() -> Self {
        Self::new(Level::Info, "leo-plugin")
    }
}

impl ConsoleLogger {
    pub fn new(min_level: Level, target: impl Into<String>) -> Self {
        Self {
            min_level: AtomicU8::new(min_level as u8),
            target: target.into(),
        }
    }

    /// Read the minimum level from `LEO_LOG` (trace/debug/info/warn/error).
    pub fn from_env(target: impl Into<String>) -> Self {
        let level = std::env::var("LEO_LOG")
            .ok()
            .and_then(|s| Level::parse(&s))
            .unwrap_or(Level::Info);
        Self::new(level, target)
    }

    pub fn set_min_level(&self, level: Level) {
        self.min_level.store(level as u8, Ordering::Relaxed);
    }
}

impl Logger for ConsoleLogger {
    fn log(&self, level: Level, fields: serde_json::Value, message: &str) {
        if (level as u8) < self.min_level.load(Ordering::Relaxed) {
            return;
        }
        let rendered = if m_is_empty(&fields) {
            String::new()
        } else {
            format!(" {}", fields)
        };
        eprintln!("[{}] {} {}{}", level.as_str(), self.target, message, rendered);
    }
}

fn m_is_empty(v: &serde_json::Value) -> bool {
    matches!(v, serde_json::Value::Object(m) if m.is_empty())
}

/// Convenience alias used across the SDK.
pub type SharedLogger = Arc<dyn Logger>;

/// Helper to format a message with arguments into a `String`.
pub fn fmt_args(args: Arguments<'_>) -> String {
    format!("{args}")
}