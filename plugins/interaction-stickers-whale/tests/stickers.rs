use std::sync::Arc;

use leo_plugin_sdk::{
    json, Context, Disposer, NullLogger, PersonaDefinition, Plugin, StickerPack,
    InteractionService,
};
use leo_plugin_interaction_stickers_whale::{whale_sticker_pack, WhaleStickersOptions, WhaleStickersPlugin};

#[derive(Default)]
struct MockInteraction {
    packs: std::sync::Mutex<Vec<StickerPack>>,
}

impl InteractionService for MockInteraction {
    fn register_persona(&self, _persona: PersonaDefinition) -> Disposer {
        Box::pin(async move {})
    }
    fn register_sticker_pack(&self, pack: StickerPack) -> Disposer {
        self.packs.lock().unwrap().push(pack);
        Box::pin(async move {})
    }
    fn personas(&self) -> Vec<PersonaDefinition> {
        Vec::new()
    }
    fn sticker_packs(&self) -> Vec<StickerPack> {
        self.packs.lock().unwrap().clone()
    }
}

#[test]
fn pack_shape() {
    let pack = whale_sticker_pack(WhaleStickersOptions::default());
    assert_eq!(pack.id, "whale");
    assert_eq!(pack.variants.len(), 2);
    assert_eq!(pack.stickers.len(), 24);
    assert_eq!(pack.default_variant.as_deref(), Some("blue"));
    let blue = pack.stickers[0].assets.get("blue").unwrap();
    let black = pack.stickers[0].assets.get("black").unwrap();
    assert!(blue.image.as_ref().unwrap().ends_with("01-daily-chat.png"));
    assert!(black.image.as_ref().unwrap().contains("/black/"));
}

#[test]
fn hidden_stickers_are_agent_only() {
    let pack = whale_sticker_pack(WhaleStickersOptions::default());
    assert!(pack
        .stickers
        .iter()
        .filter(|s| s.visibility.as_deref() == Some("agent"))
        .count()
        >= 10);
}

#[tokio::test]
async fn registers_pack_and_reload() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    let mock = Arc::new(MockInteraction::default());
    ctx.provide_interaction(mock.clone());
    WhaleStickersPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert_eq!(mock.sticker_packs().len(), 1);

    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    let mock2 = Arc::new(MockInteraction::default());
    ctx2.provide_interaction(mock2.clone());
    WhaleStickersPlugin
        .apply(ctx2.clone(), json!({"defaultVariant": "black"}))
        .await
        .unwrap();
    assert_eq!(mock2.sticker_packs()[0].default_variant.as_deref(), Some("black"));
}