use std::sync::Arc;

use leo_plugin_sdk::{
    json, Context, Disposer, NullLogger, Plugin, ProviderDriver, ProvidersService, Result,
};
use leo_plugin_provider_spark::{prepare_spark_body, spark_driver, ProviderSparkPlugin};

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
fn driver_has_six_models() {
    assert_eq!(spark_driver().models.len(), 6);
    assert_eq!(spark_driver().default_model.as_deref(), Some("spark-x2.6"));
}

#[test]
fn prepare_sets_thinking_and_strips_sampling() {
    let body = prepare_spark_body(
        json!({"model": "spark-x2.6", "temperature": 0.7, "top_p": 1, "messages": []}),
        &json!({"thinking": "auto"}),
    );
    assert_eq!(body["thinking"]["type"], json!("auto"));
    assert!(body.get("temperature").is_none());
    assert!(body.get("top_p").is_none());
}

#[test]
fn prepare_drops_reasoning_content() {
    let body = prepare_spark_body(
        json!({"messages": [{"role": "assistant", "reasoning_content": "x"}]}),
        &json!({}),
    );
    assert!(body["messages"][0].get("reasoning_content").is_none());
}

#[tokio::test]
async fn registers_driver() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    let mock = Arc::new(MockProviders::default());
    ctx.provide_providers(mock.clone());
    ProviderSparkPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert!(mock.drivers().contains(&"spark".to_string()));
}