//! JSON value helpers.
//!
//! The Rust rewrite keeps dynamically-typed payloads (services, events, tool
//! arguments/results) as [`serde_json::Value`]. This mirrors the TypeScript
//! `unknown` payloads of the original plugin protocol while staying idiomatic.

use serde::Serialize;
use serde_json::Map;
pub use serde_json::Value;

/// Re-export of [`serde_json::json`] for plugin authors.
pub use serde_json::json;

/// Convert any serializable value into a [`Value`], panicking on failure.
///
/// Only use for values that cannot fail to serialize; for fallible conversion
/// use `serde_json::to_value`.
pub fn to_value<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("value is serializable")
}

/// Build an object value from key/value pairs.
pub fn object<I, K, V>(entries: I) -> Value
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Serialize,
{
    let mut map = Map::new();
    for (k, v) in entries {
        map.insert(k.into(), to_value(v));
    }
    Value::Object(map)
}

/// Return a human-readable type name for a value (for error messages).
pub fn value_error(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(_) => "boolean".into(),
        Value::Number(_) => "number".into(),
        Value::String(_) => "string".into(),
        Value::Array(_) => "array".into(),
        Value::Object(_) => "object".into(),
    }
}

/// Deep-merge `overlay` into `base`, mirroring the TypeScript `mergeConfig`.
/// Objects are merged recursively; any other value replaces the base value.
pub fn merge(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                let merge_into = matches!(base_map.get(&key), Some(Value::Object(_)));
                if merge_into {
                    if let Some(existing) = base_map.get_mut(&key) {
                        merge(existing, value);
                    }
                } else {
                    base_map.insert(key, value);
                }
            }
        }
        (base, overlay) => *base = overlay,
    }
}