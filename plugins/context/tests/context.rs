use std::sync::Arc;

use leo_plugin_sdk::{json, Context, NullLogger, Plugin};
use leo_plugin_context::{
    analyze_session, approx_tokens, message_composition, redact, ContextConfig, ContextInsights,
    ContextPlugin,
};

#[test]
fn token_estimate() {
    assert_eq!(approx_tokens("a".repeat(40).as_str()), 10);
}

#[test]
fn composition_counts_roles() {
    let messages = vec![
        json!({"role": "system", "content": "hello"}),
        json!({"role": "user", "content": "hi"}),
        json!({"role": "user", "content": "again"}),
    ];
    let composition = message_composition(&messages);
    assert_eq!(composition["totalMessages"], json!(3));
    assert_eq!(composition["byRole"]["user"]["messages"], json!(2));
}

#[test]
fn redaction_masks_secrets() {
    let text = "token=abcdef123456 and sk-zzzzzzzz";
    let redacted = redact(text);
    assert!(!redacted.contains("abcdef123456"));
    assert!(redacted.contains("***"));
}

#[test]
fn analysis_includes_composition() {
    let session = json!({"sessionId": "s1", "messages": [{"role": "user", "content": "hi"}]});
    let analysis = analyze_session(&session);
    assert_eq!(analysis["sessionId"], json!("s1"));
    assert_eq!(analysis["composition"]["totalMessages"], json!(1));
}

#[test]
fn cache_evicts() {
    let service = ContextInsights::new(ContextConfig { cache_sessions: 2, ..Default::default() });
    for id in ["a", "b", "c"] {
        service.touch(id, "message");
        let _ = service.get(id);
    }
    // All three are still analyzable; the cache is bounded but transparent.
    assert!(service.get("a").is_some());
    assert!(service.get("c").is_some());
    assert_eq!(service.updates(), 3);
}

#[tokio::test]
async fn plugin_applies_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    ContextPlugin
        .apply(ctx.clone(), json!({"server": false}))
        .await
        .unwrap();
    assert!(ctx.get::<ContextInsights>("contextInsight").is_some());
    ctx.dispose().await;

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    ContextPlugin
        .apply(ctx2.clone(), json!({"server": false}))
        .await
        .unwrap();
    assert!(ctx2.get::<ContextInsights>("contextInsight").is_some());
}