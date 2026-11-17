use leo_plugin_sdk::json;
use leo_plugin_speakup::{decide, is_awake, SpeakupConfig, Decision};

fn at(hour: u32, minute: u32) -> i64 {
    (hour * 60 + minute) as i64 * 60_000
}

#[test]
fn awake_window() {
    let cfg = SpeakupConfig::default();
    assert!(is_awake(&cfg, 10 * 60));
    assert!(!is_awake(&cfg, 8 * 60));
    assert!(!is_awake(&cfg, 23 * 60));
}

#[test]
fn idle_triggers_speak() {
    let cfg = SpeakupConfig {
        idle_minutes: 60,
        max_per_day: 3,
        ..Default::default()
    };
    let now = at(12, 0);
    let last_user = now - 61 * 60_000;
    let d = decide(&cfg, last_user, last_user, false, 0, 0, now, 0.0);
    assert_eq!(d, Decision::Speak);
}

#[test]
fn not_idle_enough() {
    let cfg = SpeakupConfig::default();
    let now = at(12, 0);
    let last_user = now - 30 * 60_000;
    assert_eq!(
        decide(&cfg, last_user, last_user, false, 0, 0, now, 0.0),
        Decision::Silent
    );
}

#[test]
fn daily_quota_respected() {
    let cfg = SpeakupConfig {
        idle_minutes: 60,
        max_per_day: 1,
        ..Default::default()
    };
    let now = at(12, 0);
    let last_user = now - 120 * 60_000;
    assert_eq!(
        decide(&cfg, last_user, last_user, false, 1, 0, now, 0.0),
        Decision::Silent
    );
}

#[test]
fn nudge_when_question_ignored() {
    let cfg = SpeakupConfig {
        nudge: true,
        nudge_min_minutes: 15,
        nudge_max_minutes: 40,
        ..Default::default()
    };
    let now = at(12, 0);
    let last_user = now - 20 * 60_000;
    assert_eq!(
        decide(&cfg, last_user, last_user, true, 0, 0, now, 0.1),
        Decision::Nudge
    );
}

#[test]
fn config_defaults_parse() {
    let cfg: SpeakupConfig = serde_json::from_value(json!({})).unwrap();
    assert!(cfg.enabled);
    assert_eq!(cfg.idle_minutes, 60);
    assert_eq!(cfg.awake_from, 9);
}