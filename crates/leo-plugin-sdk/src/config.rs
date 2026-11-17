//! Configuration loading and merging.
//!
//! Plugins merge configuration from, in order: host config, the user-level
//! `.leo/<file>`, the project-level `.leo/<file>`, and the plugin config passed
//! to `apply`. Later layers override earlier ones.

use std::path::Path;

use serde_json::Value;
use thiserror::Error;

use crate::jsonc::strip_jsonc;
use crate::value::merge;

/// Errors that can occur while loading configuration.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse {path}: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

/// Load `<dir>/<name>` as JSONC. Returns `Ok(None)` when the file is absent.
pub fn load_config_file(dir: &Path, name: &str) -> Result<Option<Value>, ConfigError> {
    let path = dir.join(name);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(ConfigError::Io {
                path: path.display().to_string(),
                source: err,
            })
        }
    };
    let value = serde_json::from_str::<Value>(&strip_jsonc(&text)).map_err(|source| ConfigError::Parse {
        path: path.display().to_string(),
        source,
    })?;
    Ok(Some(value))
}

/// Load `<dir>/<name>` and flatten it into `layers` if present.
pub fn push_config_layer(layers: &mut Vec<Value>, dir: &Path, name: &str) {
    if let Ok(Some(value)) = load_config_file(dir, name) {
        layers.push(value);
    }
}

/// Merge configuration layers (later wins).
pub fn merge_layers(layers: impl IntoIterator<Item = Value>) -> Value {
    let mut merged = Value::Null;
    for layer in layers {
        merge(&mut merged, layer);
    }
    merged
}

/// Deep-merge `overlay` into `base` (later wins).
pub fn merge_json(base: &mut Value, overlay: Value) {
    merge(base, overlay);
}