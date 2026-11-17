//! Event definitions and dispatch.
//!
//! Mirrors the host event model from `PROTOCOL.md`: each event has a dispatch
//! mode (`emit`, `waterfall`, `bail`, `serial`, `parallel`) and handlers are
//! plain async closures over [`Value`].

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

/// How an event fans out to its handlers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventMode {
    /// Fire-and-forget; handler return values are ignored.
    Emit,
    /// Each handler receives the previous handler's return value.
    Waterfall,
    /// Handlers run in order; the first `Some(value)` stops the chain.
    Bail,
    /// Like [`EventMode::Waterfall`] but conceptually a serial pipeline.
    Serial,
    /// All handlers run concurrently; results are collected into an array.
    Parallel,
}

impl Default for EventMode {
    fn default() -> Self {
        EventMode::Emit
    }
}

/// Static description of an event, used to declare custom events.
#[derive(Clone, Copy, Debug)]
pub struct EventDef {
    pub mode: EventMode,
}

impl EventDef {
    pub const fn new(mode: EventMode) -> Self {
        Self { mode }
    }
    pub const fn emit() -> Self {
        Self::new(EventMode::Emit)
    }
    pub const fn waterfall() -> Self {
        Self::new(EventMode::Waterfall)
    }
    pub const fn bail() -> Self {
        Self::new(EventMode::Bail)
    }
    pub const fn serial() -> Self {
        Self::new(EventMode::Serial)
    }
    pub const fn parallel() -> Self {
        Self::new(EventMode::Parallel)
    }
}

/// A boxed future returned by an event handler.
pub type HandlerFuture = Pin<Box<dyn Future<Output = Value> + Send>>;

/// A single event handler.
pub trait EventHandler: Send + Sync {
    fn call(&self, payload: Value) -> HandlerFuture;
}

impl<F, Fut> EventHandler for F
where
    F: Fn(Value) -> Fut + Send + Sync,
    Fut: Future<Output = Value> + Send + 'static,
{
    fn call(&self, payload: Value) -> HandlerFuture {
        Box::pin((self)(payload))
    }
}

/// Result of dispatching an event to its handlers.
#[derive(Debug, Clone)]
pub enum Dispatch {
    /// A single (possibly transformed) value.
    Value(Value),
    /// Collected results from a parallel dispatch.
    Many(Vec<Value>),
}

impl Dispatch {
    pub fn into_value(self) -> Value {
        match self {
            Dispatch::Value(v) => v,
            Dispatch::Many(v) => Value::Array(v),
        }
    }
}

/// Dispatch `handlers` according to `mode`.
pub async fn dispatch(mode: EventMode, handlers: &[std::sync::Arc<dyn EventHandler>], payload: Value) -> Dispatch {
    match mode {
        EventMode::Emit => {
            for handler in handlers {
                handler.call(payload.clone()).await;
            }
            Dispatch::Value(Value::Null)
        }
        EventMode::Waterfall | EventMode::Serial => {
            let mut current = payload;
            for handler in handlers {
                current = handler.call(current).await;
            }
            Dispatch::Value(current)
        }
        EventMode::Bail => {
            for handler in handlers {
                let out = handler.call(payload.clone()).await;
                if !out.is_null() {
                    return Dispatch::Value(out);
                }
            }
            Dispatch::Value(Value::Null)
        }
        EventMode::Parallel => {
            let results = futures::future::join_all(
                handlers.iter().map(|h| h.call(payload.clone())),
            )
            .await;
            Dispatch::Many(results)
        }
    }
}