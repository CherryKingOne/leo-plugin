use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{
    json, ChannelConnection, ChannelDriver, ChannelInit, ChannelTarget, Context, GatewayService, InboundMessage,
    NullLogger, OutboundMessage, Plugin, Result, SendResult, ToolsService,
};
use leo_plugin_gateway::{
    session_key, ChannelRegistry, GatewayConfig, GatewayCore, GatewayPlugin,
};

struct MockConnection {
    sent: Arc<AtomicUsize>,
}

#[async_trait]
impl ChannelConnection for MockConnection {
    async fn send(&self, _target: ChannelTarget, _message: OutboundMessage) -> Result<SendResult> {
        self.sent.fetch_add(1, Ordering::SeqCst);
        Ok(SendResult { message_ids: vec!["m1".into()] })
    }
}

struct MockDriver;

#[async_trait]
impl ChannelDriver for MockDriver {
    fn id(&self) -> &str {
        "mock"
    }
    fn name(&self) -> &str {
        "Mock"
    }
    async fn create(&self, _init: ChannelInit) -> Result<Arc<dyn ChannelConnection>> {
        Ok(Arc::new(MockConnection { sent: Arc::new(AtomicUsize::new(0)) }))
    }
}

fn inbound(user: &str) -> InboundMessage {
    InboundMessage {
        channel: "mock".into(),
        account: "main".into(),
        id: "1".into(),
        chat: leo_plugin_sdk::GatewayChat {
            id: "chat1".into(),
            chat_type: "direct".into(),
            extra: None,
        },
        sender: leo_plugin_sdk::GatewaySender {
            id: user.into(),
            name: Some(user.into()),
        },
        text: "hello".into(),
        mentioned: true,
        timestamp: 0,
        raw: None,
    }
}

#[test]
fn config_defaults() {
    let config = GatewayConfig::default();
    assert!(config.enabled);
    assert_eq!(config.server.port, 18790);
    assert_eq!(config.builtin.len(), 3);
}

#[test]
fn session_key_format() {
    let key = session_key("telegram", "main", "direct", "42", None, Some("alice"));
    assert_eq!(key, "telegram:main:direct:42");
}

#[test]
fn authorization_defaults_deny() {
    let config = GatewayConfig::default();
    let core = GatewayCore::new(config);
    assert!(!core.authorize("telegram:alice"));
}

#[tokio::test]
async fn registry_routes_and_sends() {
    let mut config = GatewayConfig::default();
    config.channels.insert("main".into(), json!({"channel": "mock"}));
    config.auth.allow = vec!["mock:alice".into()];
    let ctx = Context::root(Arc::new(NullLogger));
    let core = Arc::new(GatewayCore::new(config.clone()));
    let registry = ChannelRegistry::new(config, core.clone(), ctx);

    let _ = registry.register_channel(Arc::new(MockDriver));
    registry.restart_account("main", false).await.unwrap();

    assert!(core.handle_inbound(&inbound("alice")));
    assert!(!core.handle_inbound(&inbound("bob")));

    let result = registry
        .send_to(
            "main",
            ChannelTarget { chat_id: "chat1".into(), chat_type: None, extra: None },
            OutboundMessage { text: "hi".into(), ..Default::default() },
        )
        .await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn plugin_registers_tools_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    GatewayPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    let names: Vec<String> = ctx.tools().unwrap().list().into_iter().map(|t| t.name).collect();
    assert!(names.contains(&"gateway_status".to_string()));
    assert!(names.contains(&"gateway_send".to_string()));
    assert!(names.contains(&"gateway_pair".to_string()));
    ctx.dispose().await;

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    GatewayPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(ctx2.tools().unwrap().list().iter().any(|t| t.name == "gateway_status"));
}