//! `xtask` – repository maintenance commands (Rust replacement for the
//! original `scripts/gen-registry.mjs` and `scripts/release.mjs`).
//!
//! Usage:
//!   cargo run -p leo-plugin-xtask -- gen-registry
//!   cargo run -p leo-plugin-xtask -- validate

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context as _, Result};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
struct RegistryEntry {
    id: String,
    package: String,
    version: String,
    status: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    keywords: Option<Vec<String>>,
    leo: String,
    entry: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inject: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provides: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permissions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    install: Option<Value>,
}

fn main() -> Result<()> {
    let command = std::env::args().nth(1).unwrap_or_else(|| "gen-registry".into());
    let root = repo_root()?;
    match command.as_str() {
        "gen-registry" => gen_registry(&root),
        "validate" => validate(&root),
        other => Err(anyhow!("unknown command '{other}' (expected gen-registry|validate)")),
    }
}

fn repo_root() -> Result<PathBuf> {
    let mut dir = std::env::current_dir()?;
    loop {
        if dir.join("plugins").is_dir() && dir.join("Cargo.toml").is_file() {
            return Ok(dir);
        }
        if !dir.pop() {
            return Err(anyhow!("could not locate repository root"));
        }
    }
}

fn plugin_dirs(root: &Path) -> Result<Vec<PathBuf>> {
    let plugins = root.join("plugins");
    let mut dirs = Vec::new();
    for entry in std::fs::read_dir(&plugins)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Skip template directories like `_template`.
        let is_template = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.starts_with('_'))
            .unwrap_or(false);
        if is_template {
            continue;
        }
        if path.join("leo-plugin.json").is_file() {
            dirs.push(path);
        }
    }
    dirs.sort();
    Ok(dirs)
}

fn read_manifest(dir: &Path) -> Result<Value> {
    let path = dir.join("leo-plugin.json");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    Ok(serde_json::from_str(&text)?)
}

fn gen_registry(root: &Path) -> Result<()> {
    let mut entries = Vec::new();
    for dir in plugin_dirs(root)? {
        let manifest = read_manifest(&dir)?;
        let id = manifest
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("manifest in {} has no id", dir.display()))?;
        entries.push(RegistryEntry {
            id: id.to_string(),
            package: manifest
                .get("package")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            version: manifest
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("0.0.0")
                .to_string(),
            status: manifest
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("planned")
                .to_string(),
            description: manifest
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            keywords: manifest.get("keywords").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            }),
            leo: manifest
                .get("leo")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            entry: manifest
                .get("entry")
                .and_then(Value::as_str)
                .unwrap_or("./dist/index.js")
                .to_string(),
            bundle: manifest
                .get("bundle")
                .and_then(Value::as_str)
                .map(str::to_string),
            inject: manifest.get("inject").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            }),
            provides: manifest.get("provides").cloned(),
            permissions: manifest
                .get("permissions")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()),
            install: manifest.get("install").cloned(),
        });
    }

    let body = serde_json::to_string_pretty(&serde_json::json!({ "plugins": entries }))?;
    let out = root.join("registry.json");
    std::fs::write(&out, format!("{body}\n"))?;
    println!("wrote {} ({} bytes)", out.display(), body.len());
    Ok(())
}

fn validate(root: &Path) -> Result<()> {
    let mut problems = Vec::new();
    for dir in plugin_dirs(root)? {
        let manifest = read_manifest(&dir)?;
        let id = manifest.get("id").and_then(Value::as_str).unwrap_or("");
        let package = manifest.get("package").and_then(Value::as_str).unwrap_or("");
        let expected = format!("leo-plugin-{id}");
        if dir.file_name().and_then(|s| s.to_str()) != Some(id) {
            problems.push(format!("{}: id '{id}' != directory name", dir.display()));
        }
        if package != expected {
            problems.push(format!("{id}: package '{package}' != '{expected}'"));
        }
        if manifest.get("version").and_then(Value::as_str).is_none() {
            problems.push(format!("{id}: missing version"));
        }
    }
    if problems.is_empty() {
        println!("all plugin manifests are consistent");
        Ok(())
    } else {
        for problem in &problems {
            eprintln!("{problem}");
        }
        Err(anyhow!("{} manifest problem(s)", problems.len()))
    }
}