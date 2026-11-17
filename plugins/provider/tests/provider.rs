use std::sync::Arc;

use leo_plugin_sdk::{
    json, Context, LlmRequest, LlmResponse, LlmService, NullLogger, Plugin, ProviderDriver,
    ProvidersService,
};
use leo_plugin_provider::{ProviderConfig, ProviderPlugin, ProviderRegistry};

fn mock_driver() -> ProviderDriver {
    ProviderDriver {
        id: "mock".into(),
        name: "Mock".into(),
        default_model: Some("mock-1".into()),
        complete: Some(Arc::new(|request: LlmRequest| {
            Box::pin(async move {
                Ok(LlmResponse {
                    text: format!("echo:{}", request.model),
                    ..Default::default()
                })
            })
        })),
        ..Default::default()
    }
}

#[test]
fn registry_drivers_and_default() {
    let registry = ProviderRegistry::new(ProviderConfig::default());
    registry.register_driver(mock_driver());
    assert_eq!(registry.drivers(), vec!["mock".to_string()]);
    registry.set_default("mock/mock-1").unwrap();
    assert_eq!(registry.default_model().as_deref(), Some("mock/mock-1"));
}

#[tokio::test]
async fn llm_dispatches_to_driver() {
    let registry = ProviderRegistry::new(ProviderConfig::default());
    registry.register_driver(mock_driver());
    let response = registry
        .complete(LlmRequest {
            model: "mock/mock-1".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(response.text, "echo:mock-1");
}

#[test]
fn config_drivers_from_settings() {
    let mut config = ProviderConfig::default();
    config.providers.insert(
        "local".into(),
        serde_json::from_value(json!({
            "baseURL": "http://127.0.0.1:11434/v1",
            "defaultModel": "llama3",
            "keyless": true
        }))
        .unwrap(),
    );
    let registry = ProviderRegistry::new(config);
    registry.sync_config_drivers();
    assert!(registry.drivers().contains(&"local".to_string()));
}

#[tokio::test]
async fn plugin_provides_services_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    ProviderPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert!(ctx.providers().is_some());
    assert!(ctx.llm().is_some());

    ctx.dispose().await;
    // Services registered by the plugin are revoked on dispose.
    assert!(ctx.providers().is_none());

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    ProviderPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(ctx2.llm().is_some());
}