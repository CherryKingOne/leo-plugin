use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{
    json, ChannelConnection, ChannelDriver, ChannelInit, ChannelTarget, Context, Disposer,
    GatewayService, NullLogger, OutboundMessage, Plugin, Result, SendResult, Value,
};
use leo_plugin_gateway_qq::{
    credential_key, CredentialStore, GatewayQqPlugin, QqApi, QqCredentials, QqDriver,
};

#[derive(Default)]
struct MockGateway {
    drivers: std::sync::Mutex<Vec<String>>,
    accounts: Vec<Value>,
}

#[async_trait]
impl GatewayService for MockGateway {
    fn register_channel(&self, driver: Arc<dyn ChannelDriver>) -> Disposer {
        self.drivers.lock().unwrap().push(driver.id().to_string());
        Box::pin(async move {})
    }
    fn accounts(&self) -> Vec<Value> {
        self.accounts.clone()
    }
    async fn restart_account(&self, _account: &str, _rebind: bool) -> Result<Value> {
        Ok(json!({"state": "waiting_bind", "bindUrl": "https://qq.example/bind"}))
    }
}

struct MockApi;

#[async_trait]
impl QqApi for MockApi {
    async fn bind(&self) -> Result<(String, QqCredentials)> {
        Ok((
            "https://qq.example/bind".into(),
            QqCredentials { app_id: "app".into(), app_secret: "secret".into() },
        ))
    }
    async fn send(&self, _target: ChannelTarget, _message: OutboundMessage) -> Result<SendResult> {
        Ok(SendResult { message_ids: vec!["1".into()] })
    }
}

fn temp_credentials() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("leo-qq-creds-{}", std::process::id()))
}

#[test]
fn credential_roundtrip() {
    let path = temp_credentials();
    let _ = std::fs::remove_file(&path);
    let store = CredentialStore::new(path.clone());
    store
        .set(&credential_key("main", "appId"), "app")
        .unwrap();
    assert_eq!(store.get(&credential_key("main", "appId")).as_deref(), Some("app"));
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn driver_binds_and_saves_credentials() {
    let path = temp_credentials();
    let _ = std::fs::remove_file(&path);
    let store = CredentialStore::new(path.clone());
    let driver = QqDriver::new(Arc::new(MockApi), store.clone(), true);
    let init = ChannelInit {
        account: "main".into(),
        options: json!({}),
        secret: Arc::new(|_| None),
        dispatch: Arc::new(|_| {}),
        notify: Arc::new(|_| {}),
        authorize: Arc::new(|_user, _admin| {}),
        rebind: true,
    };
    driver.create(init).await.unwrap();
    assert_eq!(
        store.get(&credential_key("main", "appId")).as_deref(),
        Some("app")
    );
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn plugin_registers_driver_and_tool() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    let gateway = Arc::new(MockGateway::default());
    ctx.provide_gateway(gateway.clone());
    GatewayQqPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert!(gateway.drivers.lock().unwrap().contains(&"qq".to_string()));
    assert!(ctx
        .tools()
        .unwrap()
        .list()
        .iter()
        .any(|t| t.name == "gateway_qq_bind"));

    ctx.dispose().await;
    // Reload works.
    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    let gateway2 = Arc::new(MockGateway::default());
    ctx2.provide_gateway(gateway2.clone());
    GatewayQqPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(gateway2.drivers.lock().unwrap().contains(&"qq".to_string()));
}