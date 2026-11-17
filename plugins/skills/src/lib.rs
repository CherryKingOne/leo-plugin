//! Rust rewrite of `leo-plugin-skills` (SKILL.md management + on-demand loading).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use leo_plugin_sdk::{Context, ContextSection, Plugin, Result, Tool, ToolContext, ToolResult};

pub const CONFIG_FILE_NAME: &str = "skills.json";
pub const SKILLS_DIR_NAME: &str = "skills";
pub const BUILTIN_DIR_NAME: &str = ".builtin";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillsConfig {
    pub enabled: bool,
    pub builtin: bool,
    pub paths: Vec<String>,
    pub disabled: Vec<String>,
    pub max_description_chars: usize,
    pub remote_manage: bool,
}

impl Default for SkillsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            builtin: true,
            paths: Vec::new(),
            disabled: Vec::new(),
            max_description_chars: 500,
            remote_manage: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub file: PathBuf,
    pub dir: PathBuf,
    pub source: String,
    pub disabled: bool,
    pub model_invocable: bool,
    pub user_invocable: bool,
    pub license: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SkillRoot {
    pub source: String,
    pub dir: PathBuf,
}

fn parse_frontmatter(text: &str) -> (HashMap<String, String>, String) {
    let mut meta = HashMap::new();
    let mut body = text;
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some((key, value)) = line.split_once(':') {
                    meta.insert(key.trim().to_string(), value.trim().to_string());
                }
            }
            body = &rest[end + 4..];
        }
    }
    (meta, body.to_string())
}

fn parse_bool(meta: &HashMap<String, String>, key: &str, default: bool) -> bool {
    match meta.get(key).map(|v| v.as_str()) {
        Some("false") => false,
        Some("true") => true,
        _ => default,
    }
}

/// Scan skill roots and produce the catalog.
pub struct SkillCatalog {
    roots: Vec<SkillRoot>,
}

impl SkillCatalog {
    pub fn new(roots: Vec<SkillRoot>) -> Self {
        Self { roots }
    }

    pub fn snapshot(&self, disabled: &[String]) -> Vec<SkillSummary> {
        let mut out: Vec<SkillSummary> = Vec::new();
        for root in &self.roots {
            let entries = match std::fs::read_dir(&root.dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let file = dir.join("SKILL.md");
                let text = match std::fs::read_to_string(&file) {
                    Ok(text) => text,
                    Err(_) => continue,
                };
                let (meta, _body) = parse_frontmatter(&text);
                let dir_name = dir
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("skill")
                    .to_string();
                let name = meta.get("name").cloned().unwrap_or(dir_name);
                if out.iter().any(|s| s.name == name) {
                    continue; // first source wins
                }
                out.push(SkillSummary {
                    name: name.clone(),
                    description: meta.get("description").cloned().unwrap_or_default(),
                    file,
                    dir,
                    source: root.source.clone(),
                    disabled: disabled.iter().any(|d| d == &name),
                    model_invocable: parse_bool(&meta, "model-invocable", true),
                    user_invocable: parse_bool(&meta, "user-invocable", true),
                    license: meta.get("license").cloned(),
                });
            }
        }
        out
    }
}

/// The skills service (`skills`).
pub struct SkillsService {
    pub config: SkillsConfig,
    pub dirs: SkillDirs,
    catalog: SkillCatalog,
    cache: RwLock<Vec<SkillSummary>>,
}

#[derive(Clone, Debug, Default)]
pub struct SkillDirs {
    pub user: PathBuf,
    pub project: Option<PathBuf>,
    pub builtin: PathBuf,
}

impl SkillsService {
    pub fn new(config: SkillsConfig, dirs: SkillDirs, catalog: SkillCatalog) -> Self {
        let cache = RwLock::new(catalog.snapshot(&config.disabled));
        Self {
            config,
            dirs,
            catalog,
            cache,
        }
    }

    pub fn refresh(&self) {
        *self.cache.write() = self.catalog.snapshot(&self.config.disabled);
    }

    pub fn snapshot(&self) -> Vec<SkillSummary> {
        self.cache.read().clone()
    }

    pub fn find(&self, name: &str) -> Option<SkillSummary> {
        self.cache.read().iter().find(|s| s.name == name).cloned()
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// The system-prompt catalog block.
pub fn catalog_section(skills: &[SkillSummary], max_description_chars: usize) -> Option<String> {
    let visible: Vec<&SkillSummary> = skills
        .iter()
        .filter(|s| s.model_invocable && !s.disabled)
        .collect();
    if visible.is_empty() {
        return None;
    }
    let mut out = vec![
        "## Skills".to_string(),
        "When the task matches a skill below, call the `skill` tool with its name to load the full instructions first.".to_string(),
        "<available_skills>".to_string(),
    ];
    for skill in visible {
        out.push(format!(
            "<skill><name>{}</name><description>{}</description></skill>",
            skill.name,
            clip(&skill.description, max_description_chars)
        ));
    }
    out.push("</available_skills>".to_string());
    Some(out.join("\n"))
}

fn render_skill(skill: &SkillSummary) -> String {
    let text = std::fs::read_to_string(&skill.file).unwrap_or_default();
    let (_meta, body) = parse_frontmatter(&text);
    let mut resources = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&skill.dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name != "SKILL.md" {
                resources.push(name);
            }
        }
    }
    let mut out = vec![
        format!("<skill_content name=\"{}\" source=\"{}\">", skill.name, skill.source),
        format!("Skill directory: {}", skill.dir.display()),
    ];
    if !resources.is_empty() {
        out.push("<skill_resources>".to_string());
        out.extend(resources);
        out.push("</skill_resources>".to_string());
    }
    out.push("<skill_instructions>".to_string());
    out.push(body.trim().to_string());
    out.push("</skill_instructions>".to_string());
    out.push("</skill_content>".to_string());
    out.join("\n")
}

/// The `skill` tool.
pub struct SkillTool {
    service: Arc<SkillsService>,
}

impl SkillTool {
    pub fn new(service: Arc<SkillsService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Tool for SkillTool {
    fn name(&self) -> &str {
        "skill"
    }

    fn description(&self) -> &str {
        "Load a skill's full instructions and absolute directory. Call it as soon as the task matches a skill. Pass `file` to read one bundled file."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Skill name" },
                "file": { "type": "string", "description": "Optional file inside the skill directory" }
            },
            "required": ["name"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, args: Value, _ctx: ToolContext) -> ToolResult {
        let name = args.get("name").and_then(Value::as_str).unwrap_or_default();
        let skill = self.service.find(name);
        let skill = match skill {
            Some(skill) if !skill.disabled => skill,
            _ => {
                let available: Vec<String> = self
                    .service
                    .snapshot()
                    .into_iter()
                    .filter(|s| s.model_invocable && !s.disabled)
                    .map(|s| s.name)
                    .collect();
                return ToolResult::error(format!(
                    "没有可用的技能 \"{name}\"{}",
                    if available.is_empty() {
                        String::new()
                    } else {
                        format!("；可用的有：{}", available.join(", "))
                    }
                ));
            }
        };
        if !skill.model_invocable {
            return ToolResult::error(format!("技能 {name} 只能由用户手动触发"));
        }
        if let Some(file) = args.get("file").and_then(Value::as_str).filter(|f| !f.is_empty()) {
            let path = skill.dir.join(file);
            match std::fs::read_to_string(&path) {
                Ok(text) => ToolResult::ok(format!("<skill_file skill=\"{name}\" path=\"{file}\">\n{text}\n</skill_file>")),
                Err(err) => ToolResult::error(format!("failed to read {file}: {err}")),
            }
        } else {
            ToolResult::ok(render_skill(&skill))
        }
    }
}

pub fn load_config(plugin_config: &Value) -> SkillsConfig {
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
pub struct SkillsPlugin;

#[async_trait]
impl Plugin for SkillsPlugin {
    fn name(&self) -> &str {
        "leo-plugin-skills"
    }

    fn inject(&self) -> Vec<String> {
        vec!["tools".into(), "context".into()]
    }

    fn watch(&self) -> Vec<String> {
        vec![CONFIG_FILE_NAME.into()]
    }

    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        let config = load_config(&config);
        let paths = leo_plugin_sdk::LeoPaths::detect();
        let user_dir = paths.user_dir.join(SKILLS_DIR_NAME);
        let project_dir = paths.project_dir.as_ref().map(|p| p.join(SKILLS_DIR_NAME));
        let builtin_dir = user_dir.join(BUILTIN_DIR_NAME);
        let _ = std::fs::create_dir_all(&user_dir);
        if let Some(dir) = &project_dir {
            let _ = std::fs::create_dir_all(dir);
        }

        let mut roots = Vec::new();
        if let Some(dir) = &project_dir {
            roots.push(SkillRoot { source: "project".into(), dir: dir.clone() });
        }
        for custom in &config.paths {
            roots.push(SkillRoot { source: "custom".into(), dir: PathBuf::from(custom) });
        }
        roots.push(SkillRoot { source: "user".into(), dir: user_dir.clone() });
        if config.builtin {
            roots.push(SkillRoot { source: "builtin".into(), dir: builtin_dir.clone() });
        }

        let service = Arc::new(SkillsService::new(
            config.clone(),
            SkillDirs { user: user_dir, project: project_dir, builtin: builtin_dir },
            SkillCatalog::new(roots),
        ));

        if let Some(context) = ctx.context() {
            let service_for_section = service.clone();
            let max_chars = config.max_description_chars;
            let section = ContextSection {
                id: "skills.catalog".into(),
                layer: "agent".into(),
                priority: 60,
                render: Arc::new(move || {
                    catalog_section(&service_for_section.snapshot(), max_chars)
                }),
            };
            ctx.effect(context.register_section(section));
        }

        let tool: Arc<dyn Tool> = Arc::new(SkillTool { service: service.clone() });
        ctx.register_tool(tool).await?;
        ctx.provide("skills", service);
        Ok(())
    }
}

/// Helper for embedders/tests: build a service from explicit roots.
pub fn service_from_roots(config: SkillsConfig, roots: Vec<SkillRoot>) -> Arc<SkillsService> {
    let catalog = SkillCatalog::new(roots);
    let dirs = SkillDirs::default();
    Arc::new(SkillsService::new(config, dirs, catalog))
}

/// Keep `Path` used.
#[allow(dead_code)]
fn _assert_path(_: &Path) {}