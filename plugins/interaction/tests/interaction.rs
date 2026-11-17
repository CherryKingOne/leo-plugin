use std::collections::HashMap;
use std::sync::Arc;

use leo_plugin_sdk::{
    json, Context, InteractionService, NullLogger, PersonaDefinition, Plugin, StickerAsset,
    StickerDefinition, StickerPack, StickerVariant, Tool, ToolContext, ToolsService,
};
use leo_plugin_interaction::{
    InteractionConfig, InteractionPlugin, InteractionRegistry, SendStickerTool,
};

fn persona(id: &str, name: &str) -> PersonaDefinition {
    PersonaDefinition {
        id: id.into(),
        name: name.into(),
        description: None,
        prompt: "hello {{model}}".into(),
        sticker_pack: None,
        plugin: None,
    }
}

fn pack() -> StickerPack {
    let mut blue = HashMap::new();
    blue.insert(
        "blue".to_string(),
        StickerAsset {
            image: Some("https://example/blue.png".into()),
            ansi: None,
        },
    );
    StickerPack {
        id: "whale".into(),
        name: "鲸鱼娘表情".into(),
        variants: vec![StickerVariant { id: "blue".into(), name: "蓝鲸娘".into() }],
        default_variant: Some("blue".into()),
        stickers: vec![StickerDefinition {
            id: "tests-passed".into(),
            text: "测试通过！".into(),
            visibility: Some("public".into()),
            triggers: vec![],
            assets: blue,
        }],
        credits: None,
        plugin: None,
    }
}

#[test]
fn registry_persona_and_sticker() {
    let registry = InteractionRegistry::new(InteractionConfig::default());
    registry.register_persona(persona("whale", "鲸鱼娘"));
    registry.register_sticker_pack(pack());

    assert_eq!(registry.active_persona().unwrap().id, "whale");
    assert_eq!(registry.stickers().len(), 1);
    let sent = registry.send("tests-passed", "agent", None).unwrap();
    assert_eq!(sent.text, "测试通过！");
    assert!(registry.send("nope", "agent", None).is_err());
}

#[test]
fn set_persona() {
    let registry = InteractionRegistry::new(InteractionConfig::default());
    registry.register_persona(persona("whale", "鲸鱼娘"));
    assert!(registry.set_persona("off", false).unwrap().is_none());
    assert!(registry.set_persona("whale", false).unwrap().is_some());
}

#[tokio::test]
async fn send_sticker_tool_limit() {
    let config = InteractionConfig {
        persona: "auto".into(),
        stickers: leo_plugin_interaction::StickerSettings {
            max_per_turn: 1,
            ..Default::default()
        },
    };
    let registry = Arc::new(InteractionRegistry::new(config));
    registry.register_sticker_pack(pack());
    let tool = SendStickerTool::new(registry);
    let first = tool
        .execute(json!({"id": "tests-passed"}), ToolContext::new())
        .await;
    assert!(!first.is_error);
    let second = tool
        .execute(json!({"id": "tests-passed"}), ToolContext::new())
        .await;
    assert!(second.is_error);
}

#[tokio::test]
async fn plugin_registers_tool_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    ctx.ensure_basic_context();

    InteractionPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    let tools = ctx.tools().unwrap();
    assert!(tools.list().iter().any(|t| t.name == "send_sticker"));

    ctx.dispose().await;
    assert!(!tools.list().iter().any(|t| t.name == "send_sticker"));

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    ctx2.ensure_basic_context();
    InteractionPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert!(ctx2.tools().unwrap().list().iter().any(|t| t.name == "send_sticker"));
}

#[test]
fn tool_info_present() {
    // Keep the trait import used.
    fn assert_tool<T: Tool>(_: &T) {}
    let registry = Arc::new(InteractionRegistry::new(InteractionConfig::default()));
    assert_tool(&SendStickerTool::new(registry));
}