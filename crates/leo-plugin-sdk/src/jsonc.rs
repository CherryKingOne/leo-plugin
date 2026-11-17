//! JSONC (JSON with comments / trailing commas) support.
//!
//! The original configuration files (`mcp-servers.json`, `provider.json`, …)
//! accept `//` and `/* */` comments and trailing commas. This module strips
//! them before handing the text to `serde_json`.

use serde_json::Value;

use crate::error::PluginError;
use crate::error::Result;

/// Remove `//` and `/* */` comments and trailing commas from JSONC text.
///
/// String literals are preserved verbatim, including embedded comment-like
/// sequences and commas.
pub fn strip_jsonc(input: &str) -> String {
    let stripped = strip_comments(input);
    strip_trailing_commas(&stripped)
}

fn strip_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escape = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }

        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' => match chars.peek().copied() {
                Some('/') => {
                    chars.next();
                    for c2 in chars.by_ref() {
                        if c2 == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                Some('*') => {
                    chars.next();
                    let mut prev = '\0';
                    while let Some(c2) = chars.next() {
                        if prev == '*' && c2 == '/' {
                            break;
                        }
                        if c2 == '\n' {
                            out.push('\n');
                        }
                        prev = c2;
                    }
                }
                _ => out.push(c),
            },
            _ => out.push(c),
        }
    }
    out
}

fn strip_trailing_commas(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escape = false;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];

        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }

        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1;
                continue;
            }
        }

        out.push(c);
        i += 1;
    }
    out
}

/// Parse JSONC text into a [`Value`].
pub fn parse_jsonc(input: &str) -> Result<Value> {
    serde_json::from_str(&strip_jsonc(input)).map_err(PluginError::from)
}