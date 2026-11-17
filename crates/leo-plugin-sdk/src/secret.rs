//! Secret resolution.
//!
//! Configuration must never contain plaintext secrets. Values may reference the
//! environment (`$NAME` / `${NAME}`), a shell command (`!command`), or entries
//! in `.leo/credentials.json` (resolved through a caller-supplied lookup).
//! Resolved secrets must never be written to logs or error messages.

use std::sync::Arc;

/// Looks up an environment variable.
pub type EnvLookup = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
/// Looks up a credential by key (e.g. `gateway/main/botToken`).
pub type CredLookup = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Sources used to resolve a secret reference.
#[derive(Clone)]
pub struct SecretResolver {
    pub env: EnvLookup,
    pub credentials: CredLookup,
}

impl Default for SecretResolver {
    fn default() -> Self {
        Self {
            env: Arc::new(|name| std::env::var(name).ok()),
            credentials: Arc::new(|_| None),
        }
    }
}

impl SecretResolver {
    pub fn with_credentials(credentials: CredLookup) -> Self {
        Self {
            credentials,
            ..Default::default()
        }
    }
}

/// Resolve a secret reference.
///
/// * `!command` – run the command and use its trimmed stdout.
/// * `$NAME` / `${NAME}` – environment variable.
/// * `${NAME}` inside a larger string – interpolated.
/// * anything else – returned unchanged.
pub fn resolve_secret(input: &str, resolver: &SecretResolver) -> Result<String, String> {
    let input = input.trim();
    if let Some(cmd) = input.strip_prefix('!') {
        return run_command(cmd);
    }
    if let Some(name) = input.strip_prefix('$') {
        let name = name.trim_matches(|c| c == '{' || c == '}');
        return (resolver.env)(name)
            .or_else(|| (resolver.credentials)(name))
            .ok_or_else(|| format!("secret '{name}' is not set"));
    }
    if input.contains("${") {
        return interpolate(input, resolver);
    }
    Ok(input.to_string())
}

/// Resolve with the default environment/credentials sources.
pub fn resolve_secret_default(input: &str) -> Result<String, String> {
    resolve_secret(input, &SecretResolver::default())
}

fn interpolate(input: &str, resolver: &SecretResolver) -> Result<String, String> {
    let mut out = String::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            if let Some(end) = input[i + 2..].find('}') {
                let name = &input[i + 2..i + 2 + end];
                let value = (resolver.env)(name)
                    .or_else(|| (resolver.credentials)(name))
                    .ok_or_else(|| format!("secret '{name}' is not set"))?;
                out.push_str(&value);
                i = i + 2 + end + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Ok(out)
}

fn run_command(cmd: &str) -> Result<String, String> {
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .map_err(|e| format!("failed to run secret command: {e}"))?;
    if !output.status.success() {
        return Err("secret command exited with a non-zero status".into());
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("secret command produced invalid UTF-8: {e}"))
}