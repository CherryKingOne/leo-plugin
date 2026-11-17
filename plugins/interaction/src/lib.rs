//! Rust rewrite of `leo-plugin-interaction` (persona + sticker registry layer).

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use leo_plugin_sdk::{
    Context, ContextSection, Disposer, InteractionService, PersonaDefinition, Plugin, Result,
    StickerDefinition, StickerPack, Tool, ToolContext, ToolResult,
};

pub const CONFIG_FILE_NAME: &str = "interaction.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StickerSettings {
    pub enabled: bool,
    pub max_per_turn: u32,
    pub variant: String,
    pub display: String,
    pub hidden: bool,
    pub user_prompt: bool,
}

impl Default for StickerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_per_turn: 3,
            variant: "blue".into(),
            display: "art".into(),
            hidden: false,
            user_prompt: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InteractionConfig {
    pub persona: String,
    pub stickers: StickerSettings,
}

impl Default for InteractionConfig {
    fn default() -> Self {
        Self {
            persona: "auto".into(),
            stickers: StickerSettings::default(),
        }
    }
}

/// A sent sticker.
#[derive(Clone, Debug, Serialize)]
pub struct SentSticker {
    #[serde(rename = "ref")]
    pub reference: String,
    pub pack: String,
    pub id: String,
    pub text: String,
    pub variant: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    pub sender: String,
}

fn valid_id(id: &str, max: usize, allow_digit_start: bool) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || (allow_digit_start && c.is_ascii_digit()) => {}
        _ => return false,
    }
    id.len() <= max
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// The interaction registry.
pub struct InteractionRegistry {
    pub config: Mutex<InteractionConfig>,
    personas: Arc<RwLock<Vec<PersonaDefinition>>>,
    packs: Arc<RwLock<Vec<StickerPack>>>,
    listeners: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
}

impl InteractionRegistry {
    pub fn new(config: InteractionConfig) -> Self {
        Self {
            config: Mutex::new(config),
            personas: Arc::new(RwLock::new(Vec::new())),
            packs: Arc::new(RwLock::new(Vec::new())),
            listeners: Mutex::new(Vec::new()),
        }
    }

    fn changed(&self) {
        for listener in self.listeners.lock().iter() {
            listener();
        }
    }

    pub fn on_change(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Disposer {
        self.listeners.lock().push(listener);
        Box::pin(async move {})
    }

    pub fn personas(&self) -> Vec<PersonaDefinition> {
        self.personas.read().clone()
    }

    pub fn sticker_packs(&self) -> Vec<StickerPack> {
        self.packs.read().clone()
    }

    pub fn active_persona(&self) -> Option<PersonaDefinition> {
        let want = self.config.lock().persona.clone();
        if want == "off" {
            return None;
        }
        let list = self.personas.read();
        if want == "auto" {
            return list.first().cloned();
        }
        list.iter().find(|p| p.id == want).cloned()
    }

    pub fn set_persona(&self, id: &str, persist: bool) -> Result<Option<PersonaDefinition>> {
        if id != "auto" && id != "off" && !self.personas.read().iter().any(|p| p.id == id) {
            let available: Vec<String> = self.personas.read().iter().map(|p| p.id.clone()).collect();
            return Err(leo_plugin_sdk::PluginError::other(format!(
                "没有人设 \"{id}\"。可用：{}",
                if available.is_empty() { "（没有安装人设子插件）".into() } else { available.join(", ") }
            )));
        }
        self.config.lock().persona = id.to_string();
        if persist {
            persist_persona(id)?;
        }
        self.changed();
        Ok(self.active_persona())
    }

    /// All stickers with a stable reference (adds `pack:` when duplicated).
    pub fn stickers(&self) -> Vec<(String, StickerPack, StickerDefinition)> {
        let packs = self.packs.read();
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for pack in packs.iter() {
            for sticker in &pack.stickers {
                *counts.entry(sticker.id.as_str()).or_default() += 1;
            }
        }
        let mut out = Vec::new();
        for pack in packs.iter() {
            for sticker in &pack.stickers {
                let reference = if counts.get(sticker.id.as_str()).copied().unwrap_or(0) > 1 {
                    format!("{}:{}", pack.id, sticker.id)
                } else {
                    sticker.id.clone()
                };
                out.push((reference, pack.clone(), sticker.clone()));
            }
        }
        out
    }

    pub fn find_sticker(&self, reference: &str) -> Option<(String, StickerPack, StickerDefinition)> {
        if let Some((pack_id, id)) = reference.split_once(':') {
            for pack in self.packs.read().iter() {
                if pack.id == pack_id {
                    if let Some(sticker) = pack.stickers.iter().find(|s| s.id == id) {
                        return Some((reference.to_string(), pack.clone(), sticker.clone()));
                    }
                }
            }
        }
        self.stickers()
            .into_iter()
            .find(|(r, _, _)| r == reference)
    }

    pub fn variants(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for pack in self.packs.read().iter() {
            for variant in &pack.variants {
                if !out.iter().any(|(id, _)| id == &variant.id) {
                    out.push((variant.id.clone(), variant.name.clone()));
                }
            }
        }
        out
    }

    fn resolve_variant(&self, pack: &StickerPack, requested: Option<&str>) -> String {
        let ids: Vec<&str> = pack.variants.iter().map(|v| v.id.as_str()).collect();
        let config_variant = self.config.lock().stickers.variant.clone();
        for candidate in [requested, Some(config_variant.as_str()), pack.default_variant.as_deref()]
            .into_iter()
            .flatten()
        {
            if ids.contains(&candidate) {
                return candidate.to_string();
            }
        }
        ids.first().copied().unwrap_or("default").to_string()
    }

    /// Send a sticker, validating visibility and variant.
    pub fn send(&self, reference: &str, sender: &str, variant: Option<&str>) -> Result<SentSticker> {
        let (reference, pack, sticker) = self
            .find_sticker(reference)
            .ok_or_else(|| leo_plugin_sdk::PluginError::other(format!("表情不存在：{reference}")))?;
        let visibility = sticker.visibility.as_deref().unwrap_or("public");
        let allowed = if sender == "agent" {
            self.config.lock().stickers.hidden || visibility == "public"
        } else {
            visibility == "public"
        };
        if !allowed {
            return Err(leo_plugin_sdk::PluginError::other(format!(
                "表情不能由 {sender} 发送：{reference}"
            )));
        }
        if let Some(requested) = variant {
            if !pack.variants.iter().any(|v| v.id == requested) {
                return Err(leo_plugin_sdk::PluginError::other(format!(
                    "未知的角色 \"{requested}\""
                )));
            }
        }
        let variant = self.resolve_variant(&pack, variant);
        let image = sticker
            .assets
            .get(&variant)
            .and_then(|asset| asset.image.clone());
        Ok(SentSticker {
            reference,
            pack: pack.id,
            id: sticker.id,
            text: sticker.text,
            variant,
            image,
            sender: sender.to_string(),
        })
    }

    pub fn sticker_guidance(&self) -> Option<String> {
        let config = self.config.lock().clone();
        if !config.stickers.enabled || config.stickers.max_per_turn == 0 {
            return None;
        }
        let stickers = self.stickers();
        if stickers.is_empty() {
            return None;
        }
        let mut lines = vec![
            "## 表情包".to_string(),
            format!(
                "你可以用 send_sticker 工具给用户发表情。每轮最多 {} 张，只在确实能表达语气时发。",
                config.stickers.max_per_turn
            ),
        ];
        for (reference, _, sticker) in stickers {
            lines.push(format!("- {reference}：{}", sticker.text));
        }
        Some(lines.join("\n"))
    }
}

impl InteractionService for InteractionRegistry {
    fn register_persona(&self, persona: PersonaDefinition) -> Disposer {
        if !valid_id(&persona.id, 32, false) {
            panic!("interaction: invalid persona id");
        }
        self.personas.write().push(persona);
        self.changed();
        let personas = self.personas.clone();
        Box::pin(async move { personas.write().clear(); })
    }

    fn register_sticker_pack(&self, pack: StickerPack) -> Disposer {
        self.packs.write().push(pack);
        self.changed();
        let packs = self.packs.clone();
        Box::pin(async move { packs.write().clear(); })
    }

    fn personas(&self) -> Vec<PersonaDefinition> {
        self.personas.read().clone()
    }

    fn sticker_packs(&self) -> Vec<StickerPack> {
        self.packs.read().clone()
    }
}

/// `send_sticker` tool.
pub struct SendStickerTool {
    registry: Arc<InteractionRegistry>,
    per_turn: Mutex<HashMap<String, u32>>,
}

impl SendStickerTool {
    pub fn new(registry: Arc<InteractionRegistry>) -> Self {
        Self {
            registry,
            per_turn: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl Tool for SendStickerTool {
    fn name(&self) -> &str {
        "send_sticker"
    }

    fn description(&self) -> &str {
        "Send one reaction sticker to the user when it naturally adds tone. Use proactively, at most the per-turn limit, and never instead of a substantive answer."
    }

    fn parameters(&self) -> Value {
        let refs: Vec<Value> = self
            .registry
            .stickers()
            .into_iter()
            .map(|(r, _, _)| json!(r))
            .collect();
        let variants: Vec<Value> = self
            .registry
            .variants()
            .into_iter()
            .map(|(id, _)| json!(id))
            .collect();
        let mut properties = json!({ "id": { "type": "string", "enum": refs, "description": "Sticker id" } });
        if variants.len() > 1 {
            properties["variant"] = json!({ "type": "string", "enum": variants, "description": "Character variant" });
        }
        json!({
            "type": "object",
            "properties": properties,
            "required": ["id"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, args: Value, ctx: ToolContext) -> ToolResult {
        let turn = ctx
            .agent_id
            .clone()
            .unwrap_or_else(|| "default".into());
        let max = self.registry.config.lock().stickers.max_per_turn;
        let used = {
            let mut per_turn = self.per_turn.lock();
            let entry = per_turn.entry(turn).or_default();
            *entry += 1;
            *entry
        };
        if used > max {
            return ToolResult::error(format!(
                "本轮已经发过 {} 张表情（上限 {}），不要再发了",
                used - 1,
                max
            ));
        }
        let reference = args.get("id").and_then(Value::as_str).unwrap_or_default();
        let variant = args.get("variant").and_then(Value::as_str);
        match self.registry.send(reference, "agent", variant) {
            Ok(sent) => ToolResult::ok(json!(sent)),
            Err(err) => ToolResult::error(err.to_string()),
        }
    }
}

fn persona_section(persona: &PersonaDefinition, model: &str, cwd: &str, date: &str) -> String {
    let prompt = persona
        .prompt
        .replace("{{model}}", model)
        .replace("{{cwd}}", cwd)
        .replace("{{date}}", date);
    format!(
        "## 人设：{}\n下面的人设决定你的身份、自称与说话方式。\n\n{}",
        persona.name, prompt
    )
}

fn persist_persona(id: &str) -> Result<()> {
    let paths = leo_plugin_sdk::LeoPaths::detect();
    let dir = paths.project_dir.clone().unwrap_or(paths.user_dir.clone());
    std::fs::create_dir_all(&dir).map_err(|e| leo_plugin_sdk::PluginError::other(e.to_string()))?;
    let path = dir.join(CONFIG_FILE_NAME);
    let mut value = leo_plugin_sdk::load_config_file(&dir, CONFIG_FILE_NAME)
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({}));
    value["persona"] = json!(id);
    let text = serde_json::to_string_pretty(&value)?;
    std::fs::write(&path, text).map_err(|e| leo_plugin_sdk::PluginError::other(e.to_string()))?;
    Ok(())
}

pub fn load_config(plugin_config: &Value) -> InteractionConfig {
    let paths = leo_plugin_sdk::LeoPaths::detect();
    let mut layers = Vec::new();
    if let Some(dir) = &paths.project_dir {
        if let Ok(Some(value)) = leo_plugin_sdk::load_config_file(dir, CONFIG_FILE_NAME) {
            layers.push(value);
        }
    }
    if let Ok(Some(value)) = leo_plugin_sdk::load_config_file(&paths.user_dir, CONFIG_FILE_NAME) {
        layers.push(value);
    }
    if !plugin_config.is_null() {
        layers.push(plugin_config.clone());
    }
    let merged = leo_plugin_sdk::merge_layers(layers);
    serde_json::from_value(merged).unwrap_or_default()
}

#[derive(Default)]
pub struct InteractionPlugin;

#[async_trait]
impl Plugin for InteractionPlugin {
    fn name(&self) -> &str {
        "leo-plugin-interaction"
    }

    fn inject(&self) -> Vec<String> {
        vec!["tools".into(), "context".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec![CONFIG_FILE_NAME.into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let registry = Arc::new(InteractionRegistry::new(load_config(&config)));

        // Persona + sticker system-prompt sections.
        if let Some(context) = ctx.context() {
            let reg = registry.clone();
            let section = ContextSection {
                id: "interaction.persona".into(),
                layer: "agent".into(),
                priority: 10,
                render: Arc::new(move || {
                    reg.active_persona()
                        .map(|p| persona_section(&p, "model", ".", "today"))
                }),
            };
            ctx.effect(context.register_section(section));

            let reg = registry.clone();
            let section = ContextSection {
                id: "interaction.stickers".into(),
                layer: "agent".into(),
                priority: 20,
                render: Arc::new(move || reg.sticker_guidance()),
            };
            ctx.effect(context.register_section(section));
        }

        // send_sticker tool (static enum snapshot; reload picks up changes).
        let config = registry.config.lock().clone();
        if config.stickers.enabled && config.stickers.max_per_turn > 0 {
            let tool: Arc<dyn Tool> = Arc::new(SendStickerTool {
                registry: registry.clone(),
                per_turn: Mutex::new(HashMap::new()),
            });
            ctx.register_tool(tool).await?;
        }

        ctx.provide_interaction(registry);
        Ok(())
    }
}