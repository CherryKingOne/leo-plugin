use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{
    json, ChannelDriver, Context, Disposer, GatewayService, NullLogger, Plugin, Result, Value,
};
use leo_plugin_gateway_feishu::{
    credential_key, CredentialStore, FeishuApi, FeishuCredentials, GatewayFeishuPlugin,
};

#[derive(Default)]
struct MockGateway {
    drivers: std::sync::Mutex<Vec<String>>,
}

#[async_trait]
impl GatewayService for MockGateway {
    fn register_channel(&self, driver: Arc<dyn ChannelDriver>) -> Disposer {
        self.drivers.lock().unwrap().push(driver.id().to_string());
        Box::pin(async move {})
    }
    fn accounts(&self) -> Vec<Value> {
        vec![json!({"account": "main", "channel": "feishu"})]
    }
    async fn restart_account(&self, _account: &str, _rebind: bool) -> Result<Value> {
        Ok(json!({"state": "waiting_bind", "bindUrl": "https://feishu.example/bind"}))
    }
}

#[test]
fn credential_roundtrip() {
    let path = std::env::temp_dir().join(format!("leo-feishu-creds-{}", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let store = CredentialStore::new(path.clone());
    store.set(&credential_key("main", "appId"), "cli_123").unwrap();
    assert_eq!(store.get(&credential_key("main", "appId")).as_deref(), Some("cli_123"));
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn plugin_registers_driver_and_tool() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    let gateway = Arc::new(MockGateway::default());
    ctx.provide_gateway(gateway.clone());
    GatewayFeishuPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert!(gateway.drivers.lock().unwrap().contains(&"feishu".to_string()));
    assert!(ctx
        .tools()
        .unwrap()
        .list()
        .iter()
        .any(|t| t.name == "gateway_feishu_bind"));

    ctx.dispose().await;
    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    let gateway2 = Arc::new(MockGateway::default());
    ctx2.provide_gateway(gateway2.clone());
    GatewayFeishuPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(gateway2.drivers.lock().unwrap().contains(&"feishu".to_string()));
}

// Keep the trait import used in this build.
#[allow(dead_code)]
fn _assert_api(_: &dyn FeishuApi) {}

#[allow(dead_code)]
fn _assert_creds(_: FeishuCredentials) {}