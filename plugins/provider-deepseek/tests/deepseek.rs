//! Tests for the DeepSeek provider sub-plugin.

use std::sync::Arc;

use leo_plugin_sdk::{
    json, Context, Disposer, NullLogger, Plugin, ProviderDriver, ProvidersService, Result,
};
use leo_plugin_provider_deepseek::{deepseek_driver, prepare_deepseek_body, ProviderDeepseekPlugin};

#[derive(Default)]
struct MockProviders {
    drivers: std::sync::Mutex<Vec<String>>,
}

impl ProvidersService for MockProviders {
    fn register_driver(&self, driver: ProviderDriver) -> Disposer {
        self.drivers.lock().unwrap().push(driver.id);
        Box::pin(async move {})
    }
    fn drivers(&self) -> Vec<String> {
        self.drivers.lock().unwrap().clone()
    }
    fn set_default(&self, _model: &str) -> Result<()> {
        Ok(())
    }
    fn default_model(&self) -> Option<String> {
        None
    }
}

#[test]
fn driver_metadata() {
    let driver = deepseek_driver();
    assert_eq!(driver.id, "deepseek");
    assert_eq!(driver.default_model.as_deref(), Some("deepseek-flash"));
    assert_eq!(driver.models.len(), 2);
}

#[test]
fn prepare_rewrites_legacy_model() {
    let body = prepare_deepseek_body(json!({"model": "deepseek-chat"}), &json!({}));
    assert_eq!(body["model"], json!("deepseek-flash"));
    assert_eq!(body["thinking"]["type"], json!("disabled"));
}

#[test]
fn prepare_maps_effort() {
    let body = prepare_deepseek_body(
        json!({"model": "deepseek-flash"}),
        &json!({"thinking": "enabled", "reasoningEffort": "minimal"}),
    );
    assert_eq!(body["thinking"]["type"], json!("enabled"));
    assert_eq!(body["reasoning_effort"], json!("low"));
}

#[test]
fn prepare_drops_reasoning_when_disabled() {
    let body = prepare_deepseek_body(
        json!({"model": "deepseek-flash", "messages": [{"role": "assistant", "reasoning_content": "x"}]}),
        &json!({"thinking": "disabled"}),
    );
    assert_eq!(body["thinking"]["type"], json!("disabled"));
    assert!(body["messages"][0].get("reasoning_content").is_none());
}

#[tokio::test]
async fn registers_driver() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    let mock = Arc::new(MockProviders::default());
    ctx.provide_providers(mock.clone());

    ProviderDeepseekPlugin
        .apply(ctx.clone(), json!({}))
        .await
        .unwrap();
    assert!(mock.drivers().contains(&"deepseek".to_string()));
}