use std::sync::Arc;

use leo_plugin_sdk::{json, Context, NullLogger, Plugin};
use leo_plugin_trajectory::{
    project_session, LiveTracker, TrajectoryConfig, Trajectories, TrajectoryPlugin,
};

#[test]
fn projection_builds_tree() {
    let session = json!({
        "sessionId": "s1",
        "turns": [
            {"index": 1, "steps": [
                {"model": "m", "durationMs": 100, "firstTokenAt": 20, "usage": {"inputTokens": 10, "outputTokens": 5}, "toolCalls": [{"name": "bash"}]}
            ]}
        ]
    });
    let tree = project_session(&session, 100);
    assert_eq!(tree["sessionId"], json!("s1"));
    assert_eq!(tree["turns"][0]["steps"][0]["tools"][0]["name"], json!("bash"));
    assert_eq!(tree["usage"]["inputTokens"], json!(10));
}

#[test]
fn tracker_records_ttft_and_evicts() {
    let tracker = LiveTracker::new(2);
    tracker.on_appended("a", "message");
    tracker.on_appended("b", "message");
    tracker.on_appended("c", "message");
    tracker.on_first_token("c", 42);
    let live = tracker.snapshot();
    assert!(live.len() <= 2);
    assert!(live.iter().any(|s| s["ttftMs"] == json!(42)));
}

#[test]
fn service_publish_and_get() {
    let service = Trajectories::new(TrajectoryConfig::default());
    service.publish("s1", "message");
    assert!(service.live().iter().any(|s| s["sessionId"] == json!("s1")));
    assert!(service.get("s1").is_none());
}

#[tokio::test]
async fn plugin_applies_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    TrajectoryPlugin
        .apply(ctx.clone(), json!({"server": false}))
        .await
        .unwrap();
    assert!(ctx.get::<Trajectories>("trajectory").is_some());
    ctx.dispose().await;

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    TrajectoryPlugin
        .apply(ctx2.clone(), json!({"server": false}))
        .await
        .unwrap();
    assert!(ctx2.get::<Trajectories>("trajectory").is_some());
}