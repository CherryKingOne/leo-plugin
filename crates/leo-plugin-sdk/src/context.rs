//! Plugin-scoped capability context.
//!
//! A [`Context`] is handed to [`crate::Plugin::apply`]. Everything a plugin
//! registers through it (services, event handlers, tools, arbitrary side
//! effects) is revoked when the plugin is unloaded, which is what makes plugins
//! hot-reloadable.

use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::contracts::{GatewayService, InteractionService, ProvidersService};
use crate::error::Result;
use crate::events::{dispatch, EventHandler, EventDef, EventMode};
use crate::logger::{NullLogger, SharedLogger};
use crate::services::{
    ApprovalService, BasicContextService, BasicTools, ContextService, CredentialsService,
    LlmService, SessionsService, ToolsService,
};
use crate::tool::{Tool, ToolContext, ToolResult};

/// A boxed, awaitable cleanup action registered with [`Context::effect`].
pub type Disposer = std::pin::Pin<Box<dyn Future<Output = ()> + Send>>;

/// Type-erased service value.
pub type SharedService = Arc<dyn Any + Send + Sync>;

/// A future returned by an event handler.
pub type HandlerFuture = crate::events::HandlerFuture;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct Inner {
    services: RwLock<HashMap<String, SharedService>>,
    handlers: RwLock<HashMap<String, Vec<(u64, Arc<dyn EventHandler>)>>>,
    modes: RwLock<HashMap<String, EventMode>>,
    effects: Mutex<Vec<Disposer>>,
    logger: SharedLogger,
    tenant: Option<String>,
    signal: CancellationToken,
    parent: Option<Arc<Inner>>,
}

impl Inner {
    fn root(logger: SharedLogger) -> Self {
        Self {
            services: RwLock::new(HashMap::new()),
            handlers: RwLock::new(HashMap::new()),
            modes: RwLock::new(HashMap::new()),
            effects: Mutex::new(Vec::new()),
            logger,
            tenant: None,
            signal: CancellationToken::new(),
            parent: None,
        }
    }

    fn child(parent: &Arc<Inner>, tenant: Option<String>) -> Self {
        Self {
            services: RwLock::new(HashMap::new()),
            handlers: RwLock::new(HashMap::new()),
            modes: RwLock::new(HashMap::new()),
            effects: Mutex::new(Vec::new()),
            logger: parent.logger.clone(),
            tenant: tenant.or_else(|| parent.tenant.clone()),
            signal: parent.signal.clone(),
            parent: Some(parent.clone()),
        }
    }
}

// ——— service handles for trait objects ———

/// Type-erased [`ToolsService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct ToolsHandle(pub Arc<dyn ToolsService>);

/// Type-erased [`LlmService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct LlmHandle(pub Arc<dyn LlmService>);

/// Type-erased [`ContextService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct ContextHandle(pub Arc<dyn ContextService>);

/// Type-erased [`ApprovalService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct ApprovalHandle(pub Arc<dyn ApprovalService>);

/// Type-erased [`SessionsService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct SessionsHandle(pub Arc<dyn SessionsService>);

/// Type-erased [`CredentialsService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct CredentialsHandle(pub Arc<dyn CredentialsService>);

/// Type-erased [`ProvidersService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct ProvidersHandle(pub Arc<dyn ProvidersService>);

/// Type-erased [`GatewayService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct GatewayHandle(pub Arc<dyn GatewayService>);

/// Type-erased [`InteractionService`] handle stored on a [`Context`].
#[derive(Clone)]
pub struct InteractionHandle(pub Arc<dyn InteractionService>);

/// Plugin-scoped capability handle.
#[derive(Clone)]
pub struct Context {
    inner: Arc<Inner>,
}

impl Default for Context {
    fn default() -> Self {
        Self::root(Arc::new(NullLogger))
    }
}

impl Context {
    /// Create a root context with the given logger.
    pub fn root(logger: SharedLogger) -> Self {
        Self {
            inner: Arc::new(Inner::root(logger)),
        }
    }

    /// Create a root context backed by a [`crate::ConsoleLogger`].
    pub fn with_console_logger() -> Self {
        Self::root(Arc::new(crate::ConsoleLogger::from_env("leo-plugin")))
    }

    /// The structured logger for this scope.
    pub fn logger(&self) -> SharedLogger {
        self.inner.logger.clone()
    }

    /// The tenant scope, if any.
    pub fn tenant(&self) -> Option<String> {
        self.inner.tenant.clone()
    }

    /// The cancellation signal for the plugin lifecycle.
    pub fn signal(&self) -> CancellationToken {
        self.inner.signal.clone()
    }

    // ——— services ———

    /// Provide (or replace) a service value. Revoked on unload.
    pub fn provide<T>(&self, key: &str, service: Arc<T>)
    where
        T: Any + Send + Sync,
    {
        let key = key.to_string();
        let inner = self.inner.clone();
        let shared: SharedService = service;
        inner.services.write().insert(key.clone(), shared);
        self.effect(Box::pin(async move {
            inner.services.write().remove(&key);
        }));
    }

    /// Provide a JSON-valued service.
    pub fn provide_json(&self, key: &str, value: Value) {
        self.provide(key, Arc::new(value));
    }

    /// Get a service by key, walking up to parent scopes.
    pub fn get<T>(&self, key: &str) -> Option<Arc<T>>
    where
        T: Any + Send + Sync,
    {
        let mut current = Some(self.inner.clone());
        while let Some(inner) = current {
            if let Some(shared) = inner.services.read().get(key).cloned() {
                return shared.downcast::<T>().ok();
            }
            current = inner.parent.clone();
        }
        None
    }

    /// Get a JSON-valued service.
    pub fn get_json(&self, key: &str) -> Option<Value> {
        self.get::<Value>(key).map(|v| (*v).clone())
    }

    /// Whether a service exists in this scope or an ancestor.
    pub fn has(&self, key: &str) -> bool {
        let mut current = Some(self.inner.clone());
        while let Some(inner) = current {
            if inner.services.read().contains_key(key) {
                return true;
            }
            current = inner.parent.clone();
        }
        false
    }

    /// Alias for [`Context::has`] mirroring the TS `ctx.maybe`.
    pub fn maybe(&self, key: &str) -> bool {
        self.has(key)
    }

    /// List service keys visible from this scope.
    pub fn service_keys(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut current = Some(self.inner.clone());
        while let Some(inner) = current {
            for key in inner.services.read().keys() {
                if !out.contains(key) {
                    out.push(key.clone());
                }
            }
            current = inner.parent.clone();
        }
        out
    }

    /// Provide the tools service.
    pub fn provide_tools(&self, service: Arc<dyn ToolsService>) {
        self.provide("tools", Arc::new(ToolsHandle(service)));
    }

    /// Get the tools service.
    pub fn tools(&self) -> Option<Arc<dyn ToolsService>> {
        self.get::<ToolsHandle>("tools").map(|h| h.0.clone())
    }

    /// Provide the llm service.
    pub fn provide_llm(&self, service: Arc<dyn LlmService>) {
        self.provide("llm", Arc::new(LlmHandle(service)));
    }

    /// Get the llm service.
    pub fn llm(&self) -> Option<Arc<dyn LlmService>> {
        self.get::<LlmHandle>("llm").map(|h| h.0.clone())
    }

    /// Provide the context service.
    pub fn provide_context(&self, service: Arc<dyn ContextService>) {
        self.provide("context", Arc::new(ContextHandle(service)));
    }

    /// Get the context service.
    pub fn context(&self) -> Option<Arc<dyn ContextService>> {
        self.get::<ContextHandle>("context").map(|h| h.0.clone())
    }

    /// Provide the approval service.
    pub fn provide_approval(&self, service: Arc<dyn ApprovalService>) {
        self.provide("approval", Arc::new(ApprovalHandle(service)));
    }

    /// Get the approval service.
    pub fn approval(&self) -> Option<Arc<dyn ApprovalService>> {
        self.get::<ApprovalHandle>("approval").map(|h| h.0.clone())
    }

    /// Provide the sessions service.
    pub fn provide_sessions(&self, service: Arc<dyn SessionsService>) {
        self.provide("sessions", Arc::new(SessionsHandle(service)));
    }

    /// Get the sessions service.
    pub fn sessions(&self) -> Option<Arc<dyn SessionsService>> {
        self.get::<SessionsHandle>("sessions").map(|h| h.0.clone())
    }

    /// Provide the credentials service.
    pub fn provide_credentials(&self, service: Arc<dyn CredentialsService>) {
        self.provide("credentials", Arc::new(CredentialsHandle(service)));
    }

    /// Get the credentials service.
    pub fn credentials(&self) -> Option<Arc<dyn CredentialsService>> {
        self.get::<CredentialsHandle>("credentials").map(|h| h.0.clone())
    }

    /// Provide the provider registry (`providers`).
    pub fn provide_providers(&self, service: Arc<dyn ProvidersService>) {
        self.provide("providers", Arc::new(ProvidersHandle(service)));
    }

    /// Get the provider registry.
    pub fn providers(&self) -> Option<Arc<dyn ProvidersService>> {
        self.get::<ProvidersHandle>("providers").map(|h| h.0.clone())
    }

    /// Provide the message gateway (`gateway`).
    pub fn provide_gateway(&self, service: Arc<dyn GatewayService>) {
        self.provide("gateway", Arc::new(GatewayHandle(service)));
    }

    /// Get the message gateway.
    pub fn gateway(&self) -> Option<Arc<dyn GatewayService>> {
        self.get::<GatewayHandle>("gateway").map(|h| h.0.clone())
    }

    /// Provide the interaction registry (`interaction`).
    pub fn provide_interaction(&self, service: Arc<dyn InteractionService>) {
        self.provide("interaction", Arc::new(InteractionHandle(service)));
    }

    /// Get the interaction registry.
    pub fn interaction(&self) -> Option<Arc<dyn InteractionService>> {
        self.get::<InteractionHandle>("interaction").map(|h| h.0.clone())
    }

    /// Register a default [`BasicTools`] service, replacing any existing one.
    pub fn ensure_basic_tools(&self) -> Arc<BasicTools> {
        let basic = BasicTools::shared();
        self.provide_tools(basic.clone());
        basic
    }

    // ——— events ———

    /// Declare the dispatch mode of an event.
    pub fn define_event(&self, event: &str, def: EventDef) {
        self.inner
            .modes
            .write()
            .insert(event.to_string(), def.mode);
    }

    /// Register an event handler. Revoked on unload.
    pub fn on<F, Fut>(&self, event: &str, handler: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Value> + Send + 'static,
    {
        let disposer = self.listen(event, handler);
        self.effect(disposer);
    }

    /// Register an event handler and return a disposer that removes it without
    /// waiting for plugin unload.
    pub fn listen<F, Fut>(&self, event: &str, handler: F) -> Disposer
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Value> + Send + 'static,
    {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let handler: Arc<dyn EventHandler> = Arc::new(handler);
        let inner = self.inner.clone();
        inner
            .handlers
            .write()
            .entry(event.to_string())
            .or_default()
            .push((id, handler));
        let event = event.to_string();
        Box::pin(async move {
            if let Some(list) = inner.handlers.write().get_mut(&event) {
                list.retain(|(hid, _)| *hid != id);
            }
        })
    }

    /// Emit an event using its declared mode (defaulting to `emit`).
    pub async fn emit(&self, event: &str, payload: Value) -> Result<Value> {
        let mode = self.mode_of(event);
        let handlers = self.collect_handlers(event);
        Ok(dispatch(mode, &handlers, payload).await.into_value())
    }

    /// Emit with an explicit mode, ignoring any declared mode.
    pub async fn emit_with(&self, mode: EventMode, event: &str, payload: Value) -> Result<Value> {
        let handlers = self.collect_handlers(event);
        Ok(dispatch(mode, &handlers, payload).await.into_value())
    }

    pub async fn waterfall(&self, event: &str, payload: Value) -> Result<Value> {
        self.emit_with(EventMode::Waterfall, event, payload).await
    }
    pub async fn bail(&self, event: &str, payload: Value) -> Result<Value> {
        self.emit_with(EventMode::Bail, event, payload).await
    }
    pub async fn serial(&self, event: &str, payload: Value) -> Result<Value> {
        self.emit_with(EventMode::Serial, event, payload).await
    }
    pub async fn parallel(&self, event: &str, payload: Value) -> Result<Value> {
        self.emit_with(EventMode::Parallel, event, payload).await
    }

    fn mode_of(&self, event: &str) -> EventMode {
        let mut current = Some(self.inner.clone());
        while let Some(inner) = current {
            if let Some(mode) = inner.modes.read().get(event).copied() {
                return mode;
            }
            current = inner.parent.clone();
        }
        EventMode::Emit
    }

    fn collect_handlers(&self, event: &str) -> Vec<Arc<dyn EventHandler>> {
        // Walk from the root down so parent (outer) handlers run first.
        let mut chain = Vec::new();
        let mut current = Some(self.inner.clone());
        while let Some(inner) = current {
            chain.push(inner.clone());
            current = inner.parent.clone();
        }
        let mut out = Vec::new();
        for inner in chain.iter().rev() {
            if let Some(list) = inner.handlers.read().get(event) {
                out.extend(list.iter().map(|(_, h)| h.clone()));
            }
        }
        out
    }

    // ——— side effects & teardown ———

    /// Register a revocable side effect. Disposers run in LIFO order on unload.
    pub fn effect(&self, disposer: Disposer) {
        self.inner.effects.lock().push(disposer);
    }

    /// Register a tool on the `tools` service, revoking it on unload.
    pub async fn register_tool(&self, tool: Arc<dyn Tool>) -> Result<()> {
        let tools = self
            .tools()
            .ok_or_else(|| crate::PluginError::MissingService("tools".into()))?;
        let disposer = tools.register(tool).await?;
        self.effect(disposer);
        Ok(())
    }

    /// Execute a tool by name through the `tools` service.
    pub async fn call_tool(&self, name: &str, args: Value, ctx: ToolContext) -> Result<ToolResult> {
        let tools = self
            .tools()
            .ok_or_else(|| crate::PluginError::MissingService("tools".into()))?;
        Ok(tools
            .execute(crate::ToolCall::new(name, args), ctx)
            .await)
    }

    /// Run all registered disposers in LIFO order and clear them.
    pub async fn dispose(&self) {
        loop {
            let next = self.inner.effects.lock().pop();
            match next {
                Some(disposer) => disposer.await,
                None => break,
            }
        }
        // Also drop services and handlers owned by this scope.
        self.inner.services.write().clear();
        self.inner.handlers.write().clear();
    }

    /// Derive a child scope (tenant / agent / session). Child registrations are
    /// revoked independently; parent services remain visible.
    pub fn fork(&self) -> Context {
        self.fork_scope(None)
    }

    /// Derive a child scope bound to a tenant.
    pub fn fork_scope(&self, tenant: Option<String>) -> Context {
        Context {
            inner: Arc::new(Inner::child(&self.inner, tenant)),
        }
    }

    /// Convenience: register a default [`BasicContextService`] if absent.
    pub fn ensure_basic_context(&self) -> Arc<BasicContextService> {
        let basic = Arc::new(BasicContextService::new());
        self.provide_context(basic.clone());
        basic
    }
}