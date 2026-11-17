use std::sync::Arc;

use leo_plugin_sdk::{
    json, Context, Disposer, NullLogger, Plugin, ProviderDriver, ProvidersService, Result,
};
use leo_plugin_provider_longcat::{
    effort_to_budget, longcat_driver, prepare_longcat_body, ProviderLongcatPlugin,
};

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
fn budgets() {
    assert_eq!(effort_to_budget("none"), None);
    assert_eq!(effort_to_budget("low"), Some(8_192));
    assert_eq!(effort_to_budget("max"), Some(262_144));
}

#[test]
fn prepare_sets_thinking_budget() {
    let body = prepare_longcat_body(
        json!({"model": "LongCat-2.5-Preview"}),
        &json!({"thinking": "enabled", "reasoningEffort": "low"}),
    );
    assert_eq!(body["thinking"]["type"], json!("enabled"));
    assert_eq!(body["thinking_budget"], json!(8_192));
}

#[test]
fn prepare_disabled_drops_reasoning() {
    let body = prepare_longcat_body(
        json!({"messages": [{"role": "assistant", "reasoning_content": "x"}]}),
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
    ProviderLongcatPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert_eq!(longcat_driver().id, "longcat");
    assert!(mock.drivers().contains(&"longcat".to_string()));
}