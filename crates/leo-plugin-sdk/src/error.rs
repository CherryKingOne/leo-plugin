//! Error types shared by plugins and the host.

use thiserror::Error;

/// Errors surfaced from plugin `apply`, tool execution or event handling.
#[derive(Debug, Error)]
pub enum PluginError {
    #[error("plugin configuration invalid: {0}")]
    Config(String),

    #[error("missing required service '{0}'")]
    MissingService(String),

    #[error("tool error: {0}")]
    Tool(String),

    #[error("event handler error: {0}")]
    Event(String),

    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

impl PluginError {
    pub fn other(msg: impl Into<String>) -> Self {
        PluginError::Other(msg.into())
    }
}

impl From<anyhow::Error> for PluginError {
    fn from(err: anyhow::Error) -> Self {
        PluginError::Other(err.to_string())
    }
}

/// Errors returned by a [`crate::Tool::execute`] call.
///
/// Following the plugin protocol, business failures should be returned as an
/// error *result* (`isError: true`) rather than panicking.
#[derive(Debug, Error)]
pub enum ToolError {
    #[error("{0}")]
    Message(String),

    #[error("{message}")]
    Detailed {
        message: String,
        terminate: bool,
    },
}

impl ToolError {
    pub fn new(msg: impl Into<String>) -> Self {
        ToolError::Message(msg.into())
    }

    pub fn terminate(msg: impl Into<String>) -> Self {
        ToolError::Detailed {
            message: msg.into(),
            terminate: true,
        }
    }

    pub fn is_terminate(&self) -> bool {
        matches!(self, ToolError::Detailed { terminate: true, .. })
    }
}

/// Convenience result alias used across the SDK.
pub type Result<T> = std::result::Result<T, PluginError>;