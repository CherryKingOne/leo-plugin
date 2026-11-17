//! Standard `.leo/` path resolution (`leoPaths` service).

use std::path::{Path, PathBuf};

/// Locations the host exposes to plugins, mirroring the TS `leoPaths` service.
#[derive(Clone, Debug)]
pub struct LeoPaths {
    /// Current working directory.
    pub cwd: PathBuf,
    /// Detected project root (contains `.leo/` or a `.git` directory).
    pub project_root: Option<PathBuf>,
    /// Project-level `.leo/` directory.
    pub project_dir: Option<PathBuf>,
    /// User-level `~/.leo/` directory (or `$LEO_HOME`).
    pub user_dir: PathBuf,
}

impl LeoPaths {
    /// Detect paths from environment variables and the filesystem.
    pub fn detect() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let user_dir = std::env::var_os("LEO_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".leo")))
            .unwrap_or_else(|| PathBuf::from(".leo"));

        let project_root = find_project_root(&cwd);
        let project_dir = project_root
            .as_ref()
            .map(|root| root.join(".leo"))
            .filter(|dir| dir.is_dir());

        Self {
            cwd,
            project_root,
            project_dir,
            user_dir,
        }
    }

    /// Read a JSON/JSONC file from a directory, if it exists.
    pub fn read_json(&self, dir: &Path, name: &str) -> Option<serde_json::Value> {
        crate::config::load_config_file(dir, name).ok().flatten()
    }
}

fn find_project_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join(".leo").is_dir() || dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}