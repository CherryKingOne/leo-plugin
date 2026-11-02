// src/config.ts
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// src/jsonc.ts
function stripJsonc(text) {
  let src = "";
  for (let i = 0, inStr = false; i < text.length; ) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      src += ch;
      if (ch === "\\") {
        src += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
    } else if (ch === '"') {
      inStr = true;
      src += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      src += ch;
      i++;
    }
  }
  let out = "";
  for (let i = 0, inStr = false; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += src[++i] ?? "";
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}
function parseJsoncTree(text) {
  let i = 0;
  const skip = () => {
    for (; ; ) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (text[i] === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? text.length : e + 2;
      } else return;
    }
  };
  const str = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = () => {
    skip();
    const start = i;
    const ch = text[i];
    if (ch === "{") {
      i++;
      const members = [];
      for (; ; ) {
        skip();
        if (text[i] === "}") {
          i++;
          return { type: "object", start, end: i, members };
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== '"') throw new Error(`provider.json: unexpected "${text[i] ?? "EOF"}" at ${i}`);
        const key = str();
        skip();
        if (text[i] !== ":") throw new Error(`provider.json: expected ":" at ${i}`);
        i++;
        members.push({ key, value: value() });
      }
    }
    if (ch === "[") {
      i++;
      for (; ; ) {
        skip();
        if (text[i] === "]") {
          i++;
          return { type: "value", start, end: i };
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (i >= text.length) throw new Error("provider.json: unterminated array");
        value();
      }
    }
    if (ch === '"') {
      str();
      return { type: "value", start, end: i };
    }
    while (i < text.length && /[^\s,\]}/]/.test(text[i])) i++;
    if (i === start) throw new Error(`provider.json: unexpected "${ch ?? "EOF"}" at ${i}`);
    return { type: "value", start, end: i };
  };
  const root = value();
  if (root.type !== "object") throw new Error("provider.json must contain a JSON object");
  return root;
}
var lineIndent = (text, pos) => {
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls))[0];
};
var childIndent = (text, obj) => obj.members.length ? lineIndent(text, obj.members[0].value.start) : `${lineIndent(text, obj.start)}  `;
var format = (v, indent) => JSON.stringify(v, null, 2).replace(/\n/g, `
${indent}`);
var splice = (text, start, end, insert) => text.slice(0, start) + insert + text.slice(end);
var findObject = (root, path) => {
  let cur = root;
  for (const k of path) {
    if (cur?.type !== "object") return void 0;
    cur = cur.members.find((m) => m.key === k)?.value;
  }
  return cur?.type === "object" ? cur : void 0;
};
function setJsonc(text, path, value) {
  const root = parseJsoncTree(text);
  const parent = findObject(root, path.slice(0, -1));
  if (!parent) throw new Error(`provider.json: "${path.slice(0, -1).join(".")}" is not an object`);
  const key = path.at(-1);
  const indent = childIndent(text, parent);
  const existing = parent.members.find((m) => m.key === key);
  if (existing) return splice(text, existing.value.start, existing.value.end, format(value, lineIndent(text, existing.value.start)));
  const member = `${JSON.stringify(key)}: ${format(value, indent)}`;
  if (!parent.members.length) {
    const inner = text.slice(parent.start + 1, parent.end - 1);
    if (!inner.includes("\n")) return splice(text, parent.start, parent.end, `{
${indent}${member}
${lineIndent(text, parent.start)}}`);
    return splice(text, parent.start + 1, parent.start + 1, `
${indent}${member}`);
  }
  const last = parent.members.at(-1);
  const after = last.value.end;
  let j = after;
  while (j < parent.end && /\s/.test(text[j])) j++;
  if (text[j] === ",") return splice(text, j + 1, j + 1, `
${indent}${member}`);
  return splice(text, after, after, `,
${indent}${member}`);
}

// src/config.ts
var CONFIG_FILE_NAME = "interaction.json";
var DEFAULT_CONFIG = {
  persona: "auto",
  stickers: { enabled: true, variant: "", hidden: true, maxPerTurn: 1, display: "art", userPrompt: true }
};
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function mergeConfig(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === void 0 || k === "$schema") continue;
      out[k] = isObj(v) && isObj(out[k]) ? { ...out[k], ...v } : v;
    }
  }
  return out;
}
function normalizeConfig(raw) {
  const bad = (path, want) => new Error(`interaction: ${path} \u5E94\u4E3A ${want}`);
  const persona = raw.persona ?? DEFAULT_CONFIG.persona;
  if (typeof persona !== "string") throw bad("persona", '\u5B57\u7B26\u4E32\uFF08\u4EBA\u8BBE id / "auto" / "off"\uFF09');
  const s = raw.stickers ?? {};
  if (!isObj(s)) throw bad("stickers", "\u5BF9\u8C61");
  const d = DEFAULT_CONFIG.stickers;
  const pick = (key, type, def) => {
    const v = s[key];
    if (v === void 0) return def;
    if (typeof v !== type) throw bad(`stickers.${key}`, type);
    return v;
  };
  const display = pick("display", "string", d.display);
  if (!["art", "image", "off"].includes(display)) throw bad("stickers.display", '"art" / "image" / "off"');
  const maxPerTurn = pick("maxPerTurn", "number", d.maxPerTurn);
  if (!Number.isInteger(maxPerTurn) || maxPerTurn < 0) throw bad("stickers.maxPerTurn", "\u975E\u8D1F\u6574\u6570");
  return {
    persona: persona.trim() || "auto",
    stickers: {
      enabled: pick("enabled", "boolean", d.enabled),
      variant: pick("variant", "string", d.variant),
      hidden: pick("hidden", "boolean", d.hidden),
      maxPerTurn,
      display,
      userPrompt: pick("userPrompt", "boolean", d.userPrompt)
    }
  };
}
async function readConfigFile(dir) {
  const file = join(dir, CONFIG_FILE_NAME);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw err;
  }
  if (!text.trim()) return void 0;
  try {
    const data = JSON.parse(stripJsonc(text));
    if (!isObj(data)) throw new Error("\u9876\u5C42\u5E94\u4E3A\u5BF9\u8C61");
    return data;
  } catch (err) {
    throw new Error(`interaction: ${file} \u683C\u5F0F\u9519\u8BEF\uFF1A${err.message}`);
  }
}
async function loadConfig(paths, options) {
  const layers = [];
  if (paths && options.loadConfigFiles !== false) {
    for (const dir of [paths.userDir, paths.projectDir]) {
      if (!dir) continue;
      const data = await readConfigFile(dir);
      if (data) layers.push(data);
    }
  }
  const { loadConfigFiles: _, ...rest } = options;
  layers.push(rest);
  return normalizeConfig(mergeConfig(...layers));
}
function targetFile(paths) {
  const project = paths.projectDir ? join(paths.projectDir, CONFIG_FILE_NAME) : void 0;
  return project && existsSync(project) ? project : join(paths.userDir, CONFIG_FILE_NAME);
}
async function persistPersona(paths, persona) {
  const file = targetFile(paths);
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!text.trim()) text = "{\n}\n";
  const next = setJsonc(text, ["persona"], persona);
  if (next === text) return false;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, next);
  await rename(tmp, file);
  return true;
}

// src/index.ts
var PLUGIN_NAME = "leo-plugin-interaction";
var ID = /^[a-z][a-z0-9_-]{0,31}$/;
var STICKER_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
function interpolate(prompt, vars) {
  return prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => vars[k] ?? m);
}
var Interaction = class {
  constructor(config, persist) {
    this.config = config;
    this.persist = persist;
  }
  config;
  persist;
  personaList = [];
  packList = [];
  listeners = /* @__PURE__ */ new Set();
  onChange(fn) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  changed() {
    for (const fn of this.listeners) fn();
  }
  registerPersona(persona) {
    if (!ID.test(persona.id)) throw new Error(`interaction: \u4EBA\u8BBE id "${persona.id}" \u4E0D\u5408\u6CD5\uFF08\u5C0F\u5199\u5B57\u6BCD\u5F00\u5934\uFF0C\u6700\u957F 32\uFF09`);
    if (persona.id === "auto" || persona.id === "off") throw new Error(`interaction: \u4EBA\u8BBE id \u4E0D\u80FD\u662F "${persona.id}"`);
    if (this.personaList.some((p) => p.id === persona.id)) throw new Error(`interaction: \u4EBA\u8BBE "${persona.id}" \u5DF2\u6CE8\u518C`);
    if (!persona.prompt?.trim()) throw new Error(`interaction: \u4EBA\u8BBE "${persona.id}" \u6CA1\u6709\u63D0\u793A\u8BCD`);
    const entry = { ...persona };
    this.personaList.push(entry);
    this.changed();
    return () => {
      const i = this.personaList.indexOf(entry);
      if (i >= 0) this.personaList.splice(i, 1);
      this.changed();
    };
  }
  registerStickerPack(pack) {
    if (!ID.test(pack.id)) throw new Error(`interaction: \u8868\u60C5\u5305 id "${pack.id}" \u4E0D\u5408\u6CD5\uFF08\u5C0F\u5199\u5B57\u6BCD\u5F00\u5934\uFF0C\u6700\u957F 32\uFF09`);
    if (this.packList.some((p) => p.id === pack.id)) throw new Error(`interaction: \u8868\u60C5\u5305 "${pack.id}" \u5DF2\u6CE8\u518C`);
    if (!pack.variants?.length) throw new Error(`interaction: \u8868\u60C5\u5305 "${pack.id}" \u81F3\u5C11\u8981\u6709\u4E00\u4E2A\u89D2\u8272\uFF08variants\uFF09`);
    const seen = /* @__PURE__ */ new Set();
    for (const s of pack.stickers) {
      if (!STICKER_ID.test(s.id)) throw new Error(`interaction: \u8868\u60C5 id "${pack.id}:${s.id}" \u4E0D\u5408\u6CD5`);
      if (seen.has(s.id)) throw new Error(`interaction: \u8868\u60C5\u5305 "${pack.id}" \u91CC\u8868\u60C5 "${s.id}" \u91CD\u590D`);
      seen.add(s.id);
    }
    const entry = { ...pack };
    this.packList.push(entry);
    this.changed();
    return () => {
      const i = this.packList.indexOf(entry);
      if (i >= 0) this.packList.splice(i, 1);
      this.changed();
    };
  }
  personas() {
    return [...this.personaList];
  }
  stickerPacks() {
    return [...this.packList];
  }
  activePersona() {
    const want = this.config.persona;
    if (want === "off") return void 0;
    if (want === "auto") return this.personaList[0];
    return this.personaList.find((p) => p.id === want);
  }
  async setPersona(id, opts = {}) {
    if (id !== "auto" && id !== "off" && !this.personaList.some((p) => p.id === id)) {
      throw new Error(`\u6CA1\u6709\u4EBA\u8BBE "${id}"\u3002\u53EF\u7528\uFF1A${this.personaList.map((p) => p.id).join(", ") || "\uFF08\u6CA1\u6709\u5B89\u88C5\u4EBA\u8BBE\u5B50\u63D2\u4EF6\uFF09"}`);
    }
    this.config = { ...this.config, persona: id };
    if (opts.persist) await this.persist?.(id);
    return this.activePersona();
  }
  stickers() {
    const count = /* @__PURE__ */ new Map();
    for (const p of this.packList) for (const s of p.stickers) count.set(s.id, (count.get(s.id) ?? 0) + 1);
    return this.packList.flatMap(
      (pack) => pack.stickers.map((sticker) => ({ ref: count.get(sticker.id) > 1 ? `${pack.id}:${sticker.id}` : sticker.id, pack, sticker }))
    );
  }
  findSticker(ref) {
    const all = this.stickers();
    const colon = ref.indexOf(":");
    if (colon > 0) {
      const [packId, id] = [ref.slice(0, colon), ref.slice(colon + 1)];
      return all.find((s) => s.pack.id === packId && s.sticker.id === id);
    }
    return all.find((s) => s.sticker.id === ref);
  }
  /** Agent 能发的表情（按配置决定是否包含彩蛋） */
  agentStickers() {
    return this.stickers().filter((s) => this.config.stickers.hidden || (s.sticker.visibility ?? "public") === "public");
  }
  publicStickers() {
    return this.stickers().filter((s) => (s.sticker.visibility ?? "public") === "public");
  }
  /** 所有包的角色并集 */
  variants() {
    const out = [];
    for (const p of this.packList) for (const v of p.variants) if (!out.some((x) => x.id === v.id)) out.push(v);
    return out;
  }
  resolveVariant(pack, requested) {
    const ids = pack.variants.map((v) => v.id);
    for (const v of [requested, this.config.stickers.variant, pack.defaultVariant]) if (v && ids.includes(v)) return v;
    return ids[0];
  }
  /** 生成发送结果；表情不存在、不允许或角色未知时抛错 */
  send(ref, sender, variant) {
    const found = this.findSticker(ref);
    const allowed = sender === "agent" ? this.agentStickers() : this.publicStickers();
    if (!found || !allowed.some((s) => s.pack === found.pack && s.sticker === found.sticker)) {
      const list = allowed.map((s) => s.ref);
      throw new Error(`\u8868\u60C5\u4E0D\u5B58\u5728\u6216\u4E0D\u80FD\u7531${sender === "agent" ? " Agent" : "\u7528\u6237"}\u53D1\u9001\uFF1A${ref}\u3002\u53EF\u7528\uFF1A${list.join(", ") || "\uFF08\u6CA1\u6709\u5B89\u88C5\u8868\u60C5\u5305\u5B50\u63D2\u4EF6\uFF09"}`);
    }
    if (variant && !found.pack.variants.some((v2) => v2.id === variant)) {
      throw new Error(`\u672A\u77E5\u7684\u89D2\u8272 "${variant}"\uFF0C\u53EF\u7528\uFF1A${found.pack.variants.map((v2) => v2.id).join(", ")}`);
    }
    const v = this.resolveVariant(found.pack, variant);
    const asset = found.sticker.assets[v] ?? found.sticker.assets[this.resolveVariant(found.pack)];
    return {
      ok: true,
      ref: found.ref,
      pack: found.pack.id,
      id: found.sticker.id,
      text: found.sticker.text,
      variant: v,
      ...asset?.image ? { image: asset.image } : {},
      sender
    };
  }
  /** 给用户看的展示块 */
  display(sent) {
    const mode = this.config.stickers.display;
    const label = `\u{1F40B} [\u8868\u60C5] ${sent.text}`;
    if (mode === "off") return [{ type: "text", text: label }];
    const blocks = [];
    if (mode === "art") {
      const found = this.findSticker(sent.ref);
      const asset = found?.sticker.assets[sent.variant];
      const lines = typeof asset?.ansi === "function" ? asset.ansi() : asset?.ansi;
      if (lines?.length) blocks.push({ type: "ansi", lines, fallback: label });
    }
    if (sent.image) blocks.push({ type: "image", url: sent.image, alt: sent.text });
    if (!blocks.length) blocks.push({ type: "text", text: label });
    return blocks;
  }
  /** 表情提示词片段 */
  stickerGuidance() {
    if (!this.config.stickers.enabled || this.config.stickers.maxPerTurn === 0) return void 0;
    const list = this.agentStickers();
    if (!list.length) return void 0;
    const max = this.config.stickers.maxPerTurn;
    const variants = this.variants();
    const lines = list.map((s) => `- ${s.ref}\uFF1A${s.sticker.text}${s.sticker.triggers?.length ? `\uFF08\u9002\u5408\uFF1A${s.sticker.triggers.join("\u3001")}\uFF09` : ""}`);
    return [
      "## \u8868\u60C5\u5305",
      `\u4F60\u53EF\u4EE5\u7528 send_sticker \u5DE5\u5177\u7ED9\u7528\u6237\u53D1\u8868\u60C5\uFF0C\u8BA9\u5BF9\u8BDD\u66F4\u6709\u6D3B\u4EBA\u611F\u3002\u6309\u5BF9\u8BDD\u8BED\u5883\u4E3B\u52A8\u4F7F\u7528\uFF0C\u4E0D\u5FC5\u7B49\u7528\u6237\u8981\u6C42\uFF1B\u6BCF\u8F6E\u6700\u591A ${max} \u5F20\uFF0C\u53EA\u5728\u5B83\u786E\u5B9E\u80FD\u8868\u8FBE\u8BED\u6C14\u65F6\u53D1\uFF0C\u7EDD\u4E0D\u80FD\u7528\u8868\u60C5\u4EE3\u66FF\u5B9E\u8D28\u56DE\u7B54\u3002\u53D1\u5B8C\u4E0D\u7528\u518D\u63CF\u8FF0\u8868\u60C5\u5185\u5BB9\u3002`,
      "\u53D1\u8868\u60C5\u7684\u552F\u4E00\u65B9\u5F0F\u662F\u8C03\u7528 send_sticker \u5DE5\u5177\u3002\u53EA\u5728\u56DE\u590D\u6587\u5B57\u91CC\u5199\u300C\uFF08\u53D1\u9001\u4E86\u4E00\u5F20\u2026\u2026\u8868\u60C5\uFF09\u300D\u4E4B\u7C7B\u7684\u63CF\u8FF0\uFF0C\u7528\u6237\u4EC0\u4E48\u90FD\u770B\u4E0D\u5230\uFF1B\u60F3\u53D1\u5C31\u8C03\u7528\u5DE5\u5177\uFF0C\u4E0D\u60F3\u53D1\u5C31\u522B\u63D0\u8868\u60C5\u3002\u7528\u6237\u8981\u4F60\u53D1\u8868\u60C5\u65F6\uFF0C\u4E00\u5B9A\u8981\u8C03\u7528\u5DE5\u5177\u3002",
      variants.length > 1 ? `\u6BCF\u5F20\u8868\u60C5\u6709\u591A\u4E2A\u89D2\u8272\uFF1A${variants.map((v) => `${v.id}\uFF08${v.name}\uFF09`).join("\u3001")}\uFF1B\u9ED8\u8BA4 ${this.config.stickers.variant || variants[0].id}\uFF0C\u7528\u6237\u6362\u8FC7\u89D2\u8272\u65F6\u8DDF\u7740\u7528\u6237\u7684\u9009\u62E9\u4F20 variant\u3002` : "",
      "\u53EF\u7528\u8868\u60C5\uFF1A",
      ...lines
    ].filter(Boolean).join("\n");
  }
};
function personaSection(p, vars) {
  return [
    `## \u4EBA\u8BBE\uFF1A${p.name}`,
    "\u4E0B\u9762\u7684\u4EBA\u8BBE\u51B3\u5B9A\u4F60\u7684\u8EAB\u4EFD\u3001\u81EA\u79F0\u4E0E\u8BF4\u8BDD\u65B9\u5F0F\uFF0C\u4F18\u5148\u4E8E\u4E0A\u6587\u4E2D\u5173\u4E8E\u8EAB\u4EFD\u548C\u8BED\u6C14\u7684\u63CF\u8FF0\uFF1B\u5DE5\u4F5C\u51C6\u5219\u3001\u5B89\u5168\u8981\u6C42\u4E0E\u5DE5\u5177\u4F7F\u7528\u89C4\u5219\u4E0D\u53D8\uFF0C\u8F93\u51FA\u8D28\u91CF\u4E0D\u53D7\u4EBA\u8BBE\u5F71\u54CD\u3002",
    "",
    interpolate(p.prompt.trim(), vars)
  ].join("\n");
}
function stickerTool(reg) {
  const refs = reg.agentStickers().map((s) => s.ref);
  const variants = reg.variants().map((v) => v.id);
  const perTurn = /* @__PURE__ */ new Map();
  return {
    name: "send_sticker",
    title: "\u53D1\u8868\u60C5",
    description: "Send one reaction sticker to the user when it naturally adds tone (greeting, tests passed, found the root cause, a weird question...). Use proactively based on the conversation, at most the per-turn limit, and never instead of a substantive answer. The user sees the sticker; do not describe it afterwards.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", enum: refs, description: "Sticker id" },
        ...variants.length > 1 ? { variant: { type: "string", enum: variants, description: "Character variant" } } : {}
      },
      required: ["id"],
      additionalProperties: false
    },
    execute: (args, exec) => {
      const max = reg.config.stickers.maxPerTurn;
      const used = perTurn.get(exec.turnId) ?? 0;
      if (used >= max) throw new Error(`\u672C\u8F6E\u5DF2\u7ECF\u53D1\u8FC7 ${used} \u5F20\u8868\u60C5\uFF08\u4E0A\u9650 ${max}\uFF09\uFF0C\u4E0D\u8981\u518D\u53D1\u4E86`);
      const sent = reg.send(String(args.id ?? ""), "agent", typeof args.variant === "string" ? args.variant : void 0);
      perTurn.set(exec.turnId, used + 1);
      if (perTurn.size > 200) perTurn.delete(perTurn.keys().next().value);
      return sent;
    },
    render: (sent) => ({
      content: `\u5DF2\u53D1\u9001\u8868\u60C5\u300C${sent.text}\u300D\uFF08${sent.ref}${sent.variant ? ` \xB7 ${sent.variant}` : ""}\uFF09\uFF0C\u7528\u6237\u5DF2\u7ECF\u770B\u5230\u3002`,
      details: sent,
      display: reg.display(sent)
    })
  };
}
function personaCommandText(reg) {
  const active = reg.activePersona();
  const list = reg.personas();
  if (!list.length) return "\u6CA1\u6709\u5B89\u88C5\u4EBA\u8BBE\u5B50\u63D2\u4EF6\u3002\u8BD5\u8BD5\uFF1Aleo plugin add interaction-persona-whale";
  const mode = reg.config.persona;
  return [
    `\u5F53\u524D\u4EBA\u8BBE\uFF1A${active ? `${active.name}\uFF08${active.id}\uFF09` : "\u65E0"}${mode === "auto" ? " \xB7 auto" : ""}`,
    ...list.map((p) => `  ${p === active ? "\u25CF" : "\u25CB"} ${p.id}  ${p.name}${p.description ? ` \u2014 ${p.description}` : ""}`),
    "\u5207\u6362\uFF1A/persona <id> \xB7 \u5173\u95ED\uFF1A/persona off \xB7 \u81EA\u52A8\uFF1A/persona auto"
  ].join("\n");
}
function stickersCommandText(reg) {
  const packs = reg.stickerPacks();
  if (!packs.length) return "\u6CA1\u6709\u5B89\u88C5\u8868\u60C5\u5305\u5B50\u63D2\u4EF6\u3002\u8BD5\u8BD5\uFF1Aleo plugin add interaction-stickers-whale";
  const out = [];
  for (const p of packs) {
    out.push(`${p.name}\uFF08${p.id}\uFF09\xB7 \u89D2\u8272\uFF1A${p.variants.map((v) => `${v.id} ${v.name}`).join(" / ")}`);
    for (const s of reg.publicStickers().filter((x) => x.pack === p)) out.push(`  ${s.ref.padEnd(18)} ${s.sticker.text}`);
    const hidden = p.stickers.filter((s) => s.visibility === "agent").length;
    if (hidden) out.push(`  \uFF08\u53E6\u6709 ${hidden} \u5F20\u5F69\u86CB\u53EA\u6709 Agent \u80FD\u53D1\uFF09`);
    if (p.credits) out.push(`  ${p.credits}`);
  }
  out.push("\u53D1\u9001\uFF1A/sticker <id> [\u89D2\u8272]");
  return out.join("\n");
}
function createInteractionPlugin() {
  return {
    name: PLUGIN_NAME,
    inject: ["tools", "context"],
    watch: [CONFIG_FILE_NAME],
    async apply(ctx, raw = {}) {
      const paths = ctx.maybe("leoPaths");
      const config = await loadConfig(paths, raw ?? {});
      const reg = new Interaction(config, async (persona) => {
        if (!paths) return;
        if (await persistPersona(paths, persona)) void ctx.emit("plugin/data-written", { plugin: PLUGIN_NAME });
      });
      ctx.provide("interaction", reg);
      const context = ctx.get("context");
      await ctx.effect(
        () => context.registerSection({
          id: "interaction.persona",
          layer: "agent",
          priority: 10,
          render: (input) => {
            const p = reg.activePersona();
            if (!p) return void 0;
            return personaSection(p, { model: input.model, cwd: paths?.cwd ?? process.cwd(), date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) });
          }
        })
      );
      await ctx.effect(() => context.registerSection({ id: "interaction.stickers", layer: "agent", priority: 20, render: () => reg.stickerGuidance() }));
      const tools = ctx.get("tools");
      let off;
      const sync = () => {
        off?.();
        off = void 0;
        if (reg.config.stickers.enabled && reg.config.stickers.maxPerTurn > 0 && reg.agentStickers().length) off = tools.register(stickerTool(reg));
      };
      await ctx.effect(() => {
        const stop = reg.onChange(sync);
        return () => {
          stop();
          off?.();
          off = void 0;
        };
      });
      const commands = ctx.maybe("commands");
      if (commands) {
        await ctx.effect(
          () => commands.register({
            name: "persona",
            usage: "[<id> | off | auto]",
            description: "\u67E5\u770B\u6216\u5207\u6362\u4EBA\u8BBE\uFF08\u5199\u56DE interaction.json\uFF09",
            plugin: "interaction",
            run: async ({ argv }) => {
              if (!argv[0]) return { text: personaCommandText(reg) };
              const p = await reg.setPersona(argv[0], { persist: true });
              return { text: p ? `\u5DF2\u5207\u6362\u4EBA\u8BBE\uFF1A${p.name}\uFF08\u65B0\u6D88\u606F\u8D77\u751F\u6548\uFF09` : "\u5DF2\u5173\u95ED\u4EBA\u8BBE" };
            }
          })
        );
        await ctx.effect(
          () => commands.register({
            name: "sticker",
            usage: "<id> [\u89D2\u8272]",
            description: "\u53D1\u4E00\u4E2A\u8868\u60C5",
            plugin: "interaction",
            run: ({ argv }) => {
              if (!argv[0]) return { text: stickersCommandText(reg) };
              const sent = reg.send(argv[0], "user", argv[1]);
              return {
                display: reg.display(sent),
                ...reg.config.stickers.userPrompt ? { prompt: `[\u6211\u53D1\u4E86\u4E00\u4E2A\u8868\u60C5\uFF1A\u300C${sent.text}\u300D\uFF08${sent.ref} \xB7 ${sent.variant}\uFF09]` } : {}
              };
            }
          })
        );
        await ctx.effect(
          () => commands.register({ name: "stickers", description: "\u5217\u51FA\u53EF\u4EE5\u53D1\u7684\u8868\u60C5", plugin: "interaction", run: () => ({ text: stickersCommandText(reg) }) })
        );
      }
    }
  };
}
var plugin = createInteractionPlugin();
var index_default = plugin;
export {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  Interaction,
  createInteractionPlugin,
  index_default as default,
  interpolate,
  normalizeConfig
};
