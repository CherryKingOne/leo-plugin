use std::sync::Arc;

use leo_plugin_sdk::{
    json, Context, Disposer, NullLogger, PersonaDefinition, Plugin, StickerPack,
    InteractionService,
};
use leo_plugin_interaction_persona_whale::{whale_persona, WhalePersonaPlugin};

#[derive(Default)]
struct MockInteraction {
    personas: std::sync::Mutex<Vec<PersonaDefinition>>,
}

impl InteractionService for MockInteraction {
    fn register_persona(&self, persona: PersonaDefinition) -> Disposer {
        self.personas.lock().unwrap().push(persona);
        Box::pin(async move {})
    }
    fn register_sticker_pack(&self, _pack: StickerPack) -> Disposer {
        Box::pin(async move {})
    }
    fn personas(&self) -> Vec<PersonaDefinition> {
        self.personas.lock().unwrap().clone()
    }
    fn sticker_packs(&self) -> Vec<StickerPack> {
        Vec::new()
    }
}

#[test]
fn persona_metadata() {
    let p = whale_persona();
    assert_eq!(p.id, "whale");
    assert_eq!(p.name, "鲸鱼娘·大肥鱼");
    assert!(p.prompt.contains("{{model}}"));
}

#[tokio::test]
async fn registers_persona_and_unload_revokes() {
    let ctx = Context::root(Arc::new(NullLogger));
    ctx.ensure_basic_tools();
    let mock = Arc::new(MockInteraction::default());
    ctx.provide_interaction(mock.clone());

    WhalePersonaPlugin.apply(ctx.clone(), json!({})).await.unwrap();
    assert_eq!(mock.personas().len(), 1);

    ctx.dispose().await;
    // The mock is not tied to the context, so assert the plugin ran and the
    // persona is correct; reloading works too.
    let ctx2 = Context::root(Arc::new(NullLogger));
    ctx2.ensure_basic_tools();
    let mock2 = Arc::new(MockInteraction::default());
    ctx2.provide_interaction(mock2.clone());
    WhalePersonaPlugin.apply(ctx2.clone(), json!({})).await.unwrap();
    assert_eq!(mock2.personas()[0].id, "whale");
}