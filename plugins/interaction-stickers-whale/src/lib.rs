//! Rust rewrite of `leo-plugin-interaction-stickers-whale`.
//!
//! 24 stickers × blue/black variants. The original embedded gzipped terminal
//! ANSI art; this Rust port omits the ANSI art (image URLs only) and notes the
//! simplification.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use leo_plugin_sdk::{
    Context, Plugin, PluginError, Result, StickerAsset, StickerDefinition, StickerPack,
    StickerVariant, Value,
};

pub const UPSTREAM_COMMIT: &str = "1703f09915db1058b6031b31e52fd404560e0a78";
pub const DEFAULT_IMAGE_BASE: &str =
    "https://raw.githubusercontent.com/william-jin-cmu/dsh-stickers/1703f09915db1058b6031b31e52fd404560e0a78/assets/stickers/";

pub fn variants() -> Vec<StickerVariant> {
    vec![
        StickerVariant { id: "blue".into(), name: "蓝鲸娘".into() },
        StickerVariant { id: "black".into(), name: "黑鲸娘".into() },
    ]
}

/// (id, text, file, visibility, triggers)
pub const CATALOG: &[(&str, &str, &str, &str, &[&str])] = &[
    ("daily-chat", "适合日常对话，即时响应", "01-daily-chat.png", "public", &["你好", "在吗", "聊聊"]),
    ("human-questions", "人类的怪问题怎么那么多…", "02-human-questions.png", "public", &["怪问题", "离谱", "脑洞"]),
    ("use-ai-for-this", "你拿AI搞这个？", "03-use-ai-for-this.png", "public", &["这么简单", "AI搞", "认真的"]),
    ("fish-philosophy", "生鱼忧患，死鱼安乐", "04-fish-philosophy.png", "public", &["摆烂", "不想干", "算了"]),
    ("enough", "这就够了", "05-enough.png", "public", &["够了", "完成", "可以了"]),
    ("server-busy", "服务器繁忙，请稍后再试", "06-server-busy.png", "public", &["限流", "超时", "503"]),
    ("thinking-stopped", "思考已停止", "07-thinking-stopped.png", "public", &["没思路", "宕机", "无语"]),
    ("great-question", "哇，这个问题问的真妙！", "08-great-question.png", "public", &["好问题", "问得妙"]),
    ("deep-thought", "已深度思考", "09-deep-thought.png", "public", &["深度思考", "推理"]),
    ("no-thanks", "No thanks I use DeepSeek", "10-no-thanks.png", "public", &["换模型", "Claude", "GPT"]),
    ("tests-passed", "测试通过！", "21-tests-passed.png", "public", &["测试通过", "green", "CI通过"]),
    ("root-cause", "找到原因了", "22-root-cause.png", "public", &["根因", "找到原因", "定位到了"]),
    ("running-tests", "正在跑测试", "23-running-tests.png", "public", &["跑测试", "验证中", "稍等"]),
    ("fixed-review", "改好了，你看看", "24-fixed-review.png", "public", &["修好了", "请验收", "看看"]),
    ("self-destruct", "最近自己搓自己时，自杀频率有点高", "11-self-destruct.png", "agent", &["自己搓自己", "自修改"]),
    ("restart-myself", "我重启一下自己", "12-restart-myself.png", "agent", &["重启", "重载"]),
    ("hot-update", "热更新成功，进程没了", "13-hot-update.png", "agent", &["热更新", "启动失败"]),
    ("restore-session", "正在恢复会话…未分组里见", "14-restore-session.png", "agent", &["resume", "恢复会话"]),
    ("browser-left", "会话太长，浏览器先走一步", "15-browser-left.png", "agent", &["长会话", "浏览器卡"]),
    ("not-stuck", "我不是卡，我在深度思考", "16-not-stuck.png", "agent", &["卡住", "没反应"]),
    ("memory-alive", "内存正在努力活着", "17-memory-alive.png", "agent", &["内存", "OOM"]),
    ("subagents-down", "已召唤Subagent，已全员中断", "18-subagents-down.png", "agent", &["subagent", "子代理"]),
    ("plugins", "插件装得很好，下次别装了", "19-plugins.png", "agent", &["插件冲突", "上下文爆炸"]),
    ("session-locked", "Session没坏，只是打不开了", "20-session-locked.png", "agent", &["session损坏", "加载失败"]),
];

/// Options for the whale sticker pack.
#[derive(Clone, Debug)]
pub struct WhaleStickersOptions {
    pub image_base: String,
    pub default_variant: String,
}

impl Default for WhaleStickersOptions {
    fn default() -> Self {
        Self {
            image_base: DEFAULT_IMAGE_BASE.into(),
            default_variant: "blue".into(),
        }
    }
}

/// Build the whale sticker pack.
pub fn whale_sticker_pack(options: WhaleStickersOptions) -> StickerPack {
    let base = options.image_base;
    let stickers = CATALOG
        .iter()
        .map(|(id, text, file, visibility, triggers)| {
            let mut assets = HashMap::new();
            assets.insert(
                "blue".to_string(),
                StickerAsset {
                    image: Some(format!("{base}{file}")),
                    ansi: None,
                },
            );
            assets.insert(
                "black".to_string(),
                StickerAsset {
                    image: Some(format!("{base}black/{file}")),
                    ansi: None,
                },
            );
            StickerDefinition {
                id: (*id).into(),
                text: (*text).into(),
                visibility: Some((*visibility).into()),
                triggers: triggers.iter().map(|s| (*s).to_string()).collect(),
                assets,
            }
        })
        .collect();
    StickerPack {
        id: "whale".into(),
        name: "鲸鱼娘表情".into(),
        variants: variants(),
        default_variant: Some(options.default_variant),
        stickers,
        credits: Some("素材来自 dsh-stickers（BSD-3-Clause）；黑鲸娘由 少女阿原（@ayuanwong）绘制".into()),
        plugin: Some("interaction-stickers-whale".into()),
    }
}

#[derive(Default)]
pub struct WhaleStickersPlugin;

#[async_trait]
impl Plugin for WhaleStickersPlugin {
    fn name(&self) -> &str {
        "leo-plugin-interaction-stickers-whale"
    }

    fn inject(&self) -> Vec<String> {
        vec!["interaction".into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let interaction = ctx
            .interaction()
            .ok_or_else(|| PluginError::MissingService("interaction".into()))?;
        let options = WhaleStickersOptions {
            image_base: config
                .get("imageBase")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_IMAGE_BASE)
                .to_string(),
            default_variant: config
                .get("defaultVariant")
                .and_then(Value::as_str)
                .unwrap_or("blue")
                .to_string(),
        };
        let disposer = interaction.register_sticker_pack(whale_sticker_pack(options));
        ctx.effect(disposer);
        Ok(())
    }
}