// src/index.ts
import { mkdir, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/config.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

// src/config.ts
var CONFIG_FILE_NAME = "speakup.json";
var DEFAULT_CONFIG = {
  enabled: true,
  targets: [],
  idleMinutes: 120,
  minIntervalMinutes: 90,
  maxIntervalMinutes: 240,
  maxPerDay: 3,
  awakeFrom: 9,
  awakeTo: 23,
  timezone: "",
  nudge: true,
  nudgeMinMinutes: 15,
  nudgeMaxMinutes: 40,
  name: ""
};
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function normalizeConfig(raw) {
  const bad = (key, want) => new Error(`speakup: ${key} \u5E94\u4E3A ${want}`);
  const d = DEFAULT_CONFIG;
  const pick = (key, type) => {
    const v = raw[key];
    if (v === void 0) return d[key];
    if (typeof v !== type) throw bad(key, type);
    return v;
  };
  const num = (key, min, max = Infinity) => {
    const v = pick(key, "number");
    if (!Number.isFinite(v) || v < min || v > max) throw bad(key, `${min}${max === Infinity ? " \u4EE5\u4E0A" : ` ~ ${max}`} \u7684\u6570\u5B57`);
    return v;
  };
  let targets = raw.targets ?? d.targets;
  if (typeof targets === "string") targets = targets.trim() ? [targets] : [];
  if (!Array.isArray(targets) || targets.some((t) => typeof t !== "string")) throw bad("targets", "\u5B57\u7B26\u4E32\u6570\u7EC4");
  const timezone = pick("timezone", "string").trim();
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw bad("timezone", 'IANA \u65F6\u533A\u540D\uFF08\u5982 "Asia/Shanghai"\uFF09');
    }
  }
  const cfg = {
    enabled: pick("enabled", "boolean"),
    targets: targets.map((t) => t.trim()).filter(Boolean),
    idleMinutes: num("idleMinutes", 1),
    minIntervalMinutes: num("minIntervalMinutes", 1),
    maxIntervalMinutes: num("maxIntervalMinutes", 1),
    maxPerDay: num("maxPerDay", 0),
    awakeFrom: num("awakeFrom", 0, 24),
    awakeTo: num("awakeTo", 0, 24),
    timezone,
    nudge: pick("nudge", "boolean"),
    nudgeMinMinutes: num("nudgeMinMinutes", 1),
    nudgeMaxMinutes: num("nudgeMaxMinutes", 1),
    name: pick("name", "string").trim()
  };
  if (cfg.maxIntervalMinutes < cfg.minIntervalMinutes) throw bad("maxIntervalMinutes", "\u4E0D\u5C0F\u4E8E minIntervalMinutes \u7684\u6570\u5B57");
  if (cfg.nudgeMaxMinutes < cfg.nudgeMinMinutes) throw bad("nudgeMaxMinutes", "\u4E0D\u5C0F\u4E8E nudgeMinMinutes \u7684\u6570\u5B57");
  if (!Number.isInteger(cfg.maxPerDay)) throw bad("maxPerDay", "\u975E\u8D1F\u6574\u6570");
  return cfg;
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
    throw new Error(`speakup: ${file} \u683C\u5F0F\u9519\u8BEF\uFF1A${err.message}`);
  }
}
async function loadConfig(paths, options) {
  const merged = {};
  if (paths && options.loadConfigFiles !== false) {
    for (const dir of [paths.userDir, paths.projectDir]) {
      if (!dir) continue;
      const data = await readConfigFile(dir);
      if (data) Object.assign(merged, data);
    }
  }
  for (const [k, v] of Object.entries(options)) if (v !== void 0 && k !== "loadConfigFiles" && k !== "$schema") merged[k] = v;
  delete merged.$schema;
  return normalizeConfig(merged);
}

// src/speakup.ts
var MIN = 6e4;
var SILENT = /\[\s*沉默\s*\]/g;
var IS_SILENT = /\[\s*沉默\s*\]/;
var QUESTION = /[？?]\s*$|[吗呢嘛没][~～。.!！\s]*$/;
var ANGLES = [
  "\u5206\u4EAB\u4E00\u4EF6\u4F60\u6700\u8FD1\u6CE8\u610F\u5230\u6216\u60F3\u5230\u7684\u5C0F\u4E8B\uFF08\u7B26\u5408\u4F60\u7684\u4EBA\u8BBE\uFF0C\u522B\u7F16\u9020\u5177\u4F53\u7684\u73B0\u5B9E\u7ECF\u5386\uFF09",
  "\u63A5\u7740\u4F60\u4EEC\u4E0A\u6B21\u804A\u7684\u8BDD\u9898\uFF0C\u95EE\u95EE\u540E\u6765\u600E\u4E48\u6837\u4E86",
  "\u60F3\u8D77\u4E4B\u524D\u804A\u5929\u91CC\u5173\u4E8E\u5BF9\u65B9\u7684\u4E00\u4EF6\u4E8B\uFF0C\u987A\u53E3\u63D0\u4E00\u53E5\u6216\u5173\u5FC3\u4E00\u4E0B",
  "\u95EE\u95EE\u5BF9\u65B9\u73B0\u5728\u5728\u5E72\u561B\u3001\u5403\u4E86\u6CA1\u3001\u7D2F\u4E0D\u7D2F",
  "\u6492\u4E2A\u5A07\u6216\u8005\u5410\u69FD\u4E00\u53E5\uFF0C\u8BF4\u4F60\u6709\u70B9\u65E0\u804A",
  "\u968F\u624B\u53D1\u4E2A\u8868\u60C5\u6216\u8005\u4E00\u53E5\u6CA1\u5934\u6CA1\u5C3E\u7684\u611F\u6168",
  "\u770B\u770B\u73B0\u5728\u51E0\u70B9\uFF0C\u6309\u65F6\u95F4\u8BF4\u70B9\u5E94\u666F\u7684\uFF08\u65E9\u4E0A\u3001\u996D\u70B9\u3001\u6DF1\u591C\uFF09"
];
function clock(t, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...timezone ? { timeZone: timezone } : {},
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(t));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}
function isAwake(hour, from, to) {
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
function matchesTarget(session, targets) {
  if (session.origin.channel === "api") return false;
  const direct = session.origin.chatType === "direct";
  if (!targets.length) return direct;
  return targets.some((t) => {
    if (session.key !== t && !session.key.startsWith(`${t}:`)) return false;
    return direct || t.includes(`:${session.origin.chatType}:`);
  });
}
function idleText(minutes) {
  if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))} \u5929\u591A`;
  if (minutes >= 120) return `${Math.floor(minutes / 60)} \u4E2A\u591A\u5C0F\u65F6`;
  return `${Math.max(1, Math.round(minutes))} \u5206\u949F`;
}
function buildPrompt(opts) {
  const { name } = opts;
  if (opts.nudge) {
    return `\u3010\u7CFB\u7EDF\u63D0\u9192\uFF0C\u4E0D\u662F${name}\u53D1\u7684\u6D88\u606F\u3011\u4F60\u521A\u624D\u8DDF${name}\u8BF4\u300C${opts.nudge.lastText.slice(-60)}\u300D\uFF0C${name}\u5DF2\u7ECF ${Math.round(opts.nudge.quietMinutes)} \u5206\u949F\u6CA1\u56DE\u4E86\u3002\u53EF\u4EE5\u8F7B\u8F7B\u8FFD\u4E00\u53E5\uFF08\u6BD4\u5982\u300C\u4EBA\u5462\u300D\u300C\u7761\u7740\u5566\uFF1F\u300D\uFF0C\u6216\u8005\u6362\u4E2A\u8BDD\u9898\uFF09\uFF0C\u522B\u50AC\u3001\u522B\u62B1\u6028\uFF1B\u89C9\u5F97${name}\u5728\u5FD9\u5C31\u53EA\u56DE [\u6C89\u9ED8]\u3002`;
  }
  return `\u3010\u7CFB\u7EDF\u63D0\u9192\uFF0C\u4E0D\u662F${name}\u53D1\u7684\u6D88\u606F\u3011\u4F60\u5DF2\u7ECF${idleText(opts.idleMinutes)}\u6CA1\u548C${name}\u804A\u5929\u4E86\uFF0C\u60F3\u4E3B\u52A8\u627E${name}\u8BF4\u70B9\u4EC0\u4E48\u3002\u8FD9\u6B21\u7684\u7531\u5934\u53EF\u4EE5\u662F\uFF1A${opts.angle}\u3002\u7528\u4F60\u81EA\u5DF1\u7684\u53E3\u6C14\uFF0C\u4E00\u4E24\u53E5\u5C31\u597D\uFF0C\u522B\u7528\u6A21\u677F\u3001\u522B\u89E3\u91CA\u4E3A\u4EC0\u4E48\u6765\u627E\uFF1B\u5B9E\u5728\u4E0D\u60F3\u8BF4\u5C31\u53EA\u56DE [\u6C89\u9ED8]\u3002`;
}
var SpeakUp = class {
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }
  deps;
  now;
  random;
  /** 正在主动搭话的会话（这些 turn 的 turn-end 不算 Agent 回复） */
  firing = /* @__PURE__ */ new Set();
  noticed = /* @__PURE__ */ new Set();
  ticking = false;
  get state() {
    return this.deps.state;
  }
  entry(key, fallbackAt = 0) {
    let s = this.deps.state[key];
    if (!s) {
      s = { day: "", count: 0, nextAt: 0, lastUserAt: fallbackAt, lastBotAt: 0, lastBotText: "", nudgedFor: 0, lastFireAt: 0 };
      this.deps.state[key] = s;
    }
    return s;
  }
  persist() {
    void Promise.resolve(this.deps.save?.(this.deps.state)).catch((err) => this.deps.log?.warn(`speakup: \u4FDD\u5B58\u72B6\u6001\u5931\u8D25\uFF1A${err.message}`));
  }
  schedule(s, cfg) {
    const span = cfg.maxIntervalMinutes - cfg.minIntervalMinutes;
    s.nextAt = this.now() + (cfg.minIntervalMinutes + this.random() * span) * MIN;
  }
  /** 对方发来消息（gateway/message） */
  onUserMessage(sessionKey, at = this.now()) {
    const s = this.entry(sessionKey);
    s.lastUserAt = Math.max(s.lastUserAt, at);
    this.persist();
  }
  /** 一轮对话结束（gateway/turn-end）：Agent 回了话 */
  onTurnEnd(sessionKey, text) {
    if (this.firing.has(sessionKey) || !text.trim()) return;
    const s = this.entry(sessionKey);
    s.lastBotAt = this.now();
    s.lastBotText = text.trim();
    this.persist();
  }
  /** 会话被 /new 重置：清掉追问记录（次数保留） */
  onReset(sessionKey) {
    const s = this.deps.state[sessionKey];
    if (!s) return;
    s.lastBotText = "";
    this.persist();
  }
  /** 当前的目标会话 */
  targets() {
    const cfg = this.deps.config();
    return this.deps.gateway().sessions().filter((s) => matchesTarget(s, cfg.targets));
  }
  async tick() {
    const cfg = this.deps.config();
    if (!cfg.enabled || this.ticking) return [];
    this.ticking = true;
    const out = [];
    try {
      const now = this.now();
      const { day, hour } = clock(now, cfg.timezone);
      const awake = isAwake(hour, cfg.awakeFrom, cfg.awakeTo);
      let dirty = false;
      for (const session of this.targets()) {
        const s = this.entry(session.key, session.updatedAt);
        if (s.day !== day) Object.assign(s, { day, count: 0 }), dirty = true;
        if (!s.nextAt) this.schedule(s, cfg), dirty = true;
        if (!awake || session.running || session.queued > 0 || session.pendingApproval || this.firing.has(session.key)) continue;
        const quiet = now - s.lastBotAt;
        if (cfg.nudge && s.lastBotAt > s.lastUserAt && s.lastBotAt !== s.nudgedFor && QUESTION.test(s.lastBotText) && quiet > cfg.nudgeMinMinutes * MIN && quiet < cfg.nudgeMaxMinutes * MIN) {
          s.nudgedFor = s.lastBotAt;
          dirty = true;
          if (this.random() < 0.5) out.push(await this.fire(session, { nudge: true }));
          continue;
        }
        const last = Math.max(s.lastUserAt, s.lastBotAt, session.updatedAt);
        if (now - last > cfg.idleMinutes * MIN && s.count < cfg.maxPerDay && now >= s.nextAt) {
          s.count++;
          this.schedule(s, cfg);
          dirty = true;
          out.push(await this.fire(session));
        }
      }
      if (dirty) this.persist();
    } finally {
      this.ticking = false;
    }
    return out;
  }
  /** 立刻让 Agent 找某个会话说话（不看时段、空闲与次数） */
  async fire(session, opts = {}) {
    const key = session.key;
    if (this.firing.has(key) || session.running || session.queued > 0) return { sessionKey: key, status: "busy" };
    const cfg = this.deps.config();
    const gw = this.deps.gateway();
    const s = this.entry(key, session.updatedAt);
    const now = this.now();
    const name = cfg.name || session.origin.userName || "\u5BF9\u65B9";
    const angle = ANGLES[Math.floor(this.random() * ANGLES.length)] ?? ANGLES[0];
    const prompt = buildPrompt({
      name,
      idleMinutes: (now - Math.max(s.lastUserAt, s.lastBotAt, session.updatedAt)) / MIN,
      angle,
      ...opts.nudge ? { nudge: { lastText: s.lastBotText, quietMinutes: (now - s.lastBotAt) / MIN } } : {}
    });
    const images = [];
    this.firing.add(key);
    try {
      this.deps.log?.info(`speakup: ${opts.nudge ? "\u8FFD\u95EE" : "\u4E3B\u52A8\u642D\u8BDD"} ${key}`);
      const res = await gw.chat({
        sessionKey: key,
        text: prompt,
        onEvent: (ev) => {
          if (ev.type === "image" && ev.url) images.push({ url: ev.url, ...ev.alt ? { alt: ev.alt } : {} });
        }
      });
      const text = res.text.replace(SILENT, "").trim();
      if (res.reason !== "completed" && !text) return { sessionKey: key, status: "failed", error: res.error ?? res.reason };
      if (!text && (IS_SILENT.test(res.text) || !images.length)) return { sessionKey: key, status: "silent" };
      const o = session.origin;
      const target = { account: o.account, chatId: o.chatId, chatType: o.chatType, ...o.extra ? { extra: o.extra } : {} };
      if (text) await gw.send(target, text);
      let sentImages = 0;
      for (const image of images) {
        if (!gw.sendImage) break;
        try {
          await gw.sendImage(target, image);
          sentImages++;
        } catch (err) {
          this.deps.log?.warn(`speakup: \u53D1\u56FE\u7247\u5931\u8D25 ${key}\uFF1A${err.message}`);
        }
      }
      s.lastBotAt = this.now();
      s.lastFireAt = s.lastBotAt;
      if (text) s.lastBotText = text;
      this.persist();
      return { sessionKey: key, status: "sent", text, images: sentImages };
    } catch (err) {
      const message = err.message;
      this.deps.log?.warn(`speakup: \u4E3B\u52A8\u53D1\u6D88\u606F\u5931\u8D25 ${key}\uFF1A${message}`);
      const tag = `${key}
${message.slice(0, 80)}`;
      if (!this.noticed.has(tag)) {
        this.noticed.add(tag);
        const hint = session.origin.channel === "qq" ? "\uFF08QQ\uFF1A\u5BF9\u65B9\u53EF\u80FD\u5728\u673A\u5668\u4EBA\u8D44\u6599\u5361\u5173\u4E86\u300C\u5141\u8BB8\u4E3B\u52A8\u53D1\u9001\u300D\uFF0C\u6216\u8D85\u8FC7\u4E86\u4E3B\u52A8\u6D88\u606F\u989D\u5EA6\uFF09" : "";
        this.deps.notice?.(`\u4E3B\u52A8\u642D\u8BDD\u53D1\u9001\u5931\u8D25\uFF1A${key}\uFF1A${message}${hint}`);
      }
      return { sessionKey: key, status: "failed", error: message };
    } finally {
      this.firing.delete(key);
    }
  }
};

// src/index.ts
var PLUGIN_NAME = "leo-plugin-speakup";
var STATE_FILE_NAME = "speakup.state.json";
var TICK_MS = 6e4;
async function readState(file) {
  try {
    const data = JSON.parse(await readFile2(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}
async function writeState(file, state) {
  await mkdir(join2(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}
`);
  await rename(tmp, file);
}
var fmtTime = (t, tz) => t ? new Intl.DateTimeFormat("zh-CN", { ...tz ? { timeZone: tz } : {}, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t)) : "\u2014";
function statusText(sp, cfg) {
  const lines = [
    `\u4E3B\u52A8\u642D\u8BDD\uFF1A${cfg.enabled ? "\u5F00" : "\u5173"} \xB7 \u6E05\u9192\u65F6\u6BB5 ${cfg.awakeFrom}\u2013${cfg.awakeTo} \u70B9${cfg.timezone ? `\uFF08${cfg.timezone}\uFF09` : ""} \xB7 \u7A7A\u95F2 ${cfg.idleMinutes} \u5206\u949F\u540E \xB7 \u6BCF\u5929\u6700\u591A ${cfg.maxPerDay} \u6B21`
  ];
  let targets = [];
  try {
    targets = sp.targets();
  } catch {
  }
  if (!targets.length) lines.push(cfg.targets.length ? `\u6CA1\u6709\u5339\u914D ${cfg.targets.join(", ")} \u7684\u4F1A\u8BDD` : "\u8FD8\u6CA1\u6709\u79C1\u804A\u4F1A\u8BDD\uFF1A\u5BF9\u65B9\u5148\u7ED9\u673A\u5668\u4EBA\u53D1\u4E00\u6761\u6D88\u606F\u624D\u4F1A\u51FA\u73B0");
  const { day } = clock(Date.now(), cfg.timezone);
  for (const t of targets) {
    const s = sp.state[t.key];
    const count = s && s.day === day ? s.count : 0;
    lines.push(`  ${t.key}${t.origin.userName ? `\uFF08${t.origin.userName}\uFF09` : ""} \xB7 \u4ECA\u5929 ${count}/${cfg.maxPerDay} \xB7 \u4E0B\u6B21\u4E0D\u65E9\u4E8E ${fmtTime(s?.nextAt ?? 0, cfg.timezone)} \xB7 \u4E0A\u6B21 ${fmtTime(s?.lastFireAt ?? 0, cfg.timezone)}`);
  }
  lines.push("\u7ACB\u523B\u627E\u4E00\u6B21\uFF1A/speakup now [\u4F1A\u8BDD\u952E\u524D\u7F00]");
  return lines.join("\n");
}
function resultText(r) {
  switch (r.status) {
    case "sent":
      return `\u5DF2\u4E3B\u52A8\u53D1\u7ED9 ${r.sessionKey}\uFF1A${r.text || `[\u56FE\u7247 ${r.images ?? 0} \u5F20]`}`;
    case "silent":
      return `Agent \u8FD9\u6B21\u4E0D\u60F3\u8BF4\u8BDD\uFF08\u56DE\u4E86 [\u6C89\u9ED8]\uFF09\uFF1A${r.sessionKey}`;
    case "busy":
      return `${r.sessionKey} \u6B63\u5728\u5BF9\u8BDD\uFF0C\u7A0D\u540E\u518D\u8BD5`;
    default:
      return `\u53D1\u9001\u5931\u8D25\uFF1A${r.sessionKey}\uFF1A${r.error ?? "\u672A\u77E5\u9519\u8BEF"}`;
  }
}
function createSpeakUpPlugin(opts = {}) {
  return {
    name: PLUGIN_NAME,
    inject: ["gateway"],
    watch: [CONFIG_FILE_NAME],
    async apply(ctx, raw = {}) {
      const paths = ctx.maybe("leoPaths");
      const config = await loadConfig(paths, raw ?? {});
      const stateFile = paths && raw?.loadConfigFiles !== false ? join2(paths.userDir, STATE_FILE_NAME) : void 0;
      const state = stateFile ? await readState(stateFile) : {};
      const gateway = () => ctx.get("gateway");
      const log = {
        info: (m) => ctx.logger?.info?.(m),
        warn: (m) => ctx.logger?.warn?.(m)
      };
      let saving = Promise.resolve();
      const sp = new SpeakUp({
        gateway,
        config: () => config,
        state,
        ...stateFile ? { save: (s) => saving = saving.then(() => writeState(stateFile, s)).catch(() => {
        }) } : {},
        ...opts.now ? { now: opts.now } : {},
        ...opts.random ? { random: opts.random } : {},
        log,
        notice: (message) => void ctx.emit("plugin/notice", { plugin: "speakup", message, level: "warn" })
      });
      ctx.provide("speakup", sp);
      ctx.on("gateway/message", ((p) => {
        if (p?.sessionKey) sp.onUserMessage(p.sessionKey, p.message?.timestamp || void 0);
      }));
      ctx.on("gateway/turn-end", ((p) => {
        if (p?.sessionKey && p.reason !== "cancelled") sp.onTurnEnd(p.sessionKey, p.text ?? "");
      }));
      ctx.on("gateway/session-reset", ((p) => {
        if (p?.sessionKey) sp.onReset(p.sessionKey);
      }));
      const tickMs = opts.tickMs ?? TICK_MS;
      if (tickMs > 0) {
        await ctx.effect(() => {
          const timer = setInterval(() => {
            sp.tick().catch((err) => log.warn(`speakup: ${err.message}`));
          }, tickMs);
          timer.unref?.();
          return () => clearInterval(timer);
        });
      }
      const commands = ctx.maybe("commands");
      if (commands) {
        await ctx.effect(
          () => commands.register({
            name: "speakup",
            usage: "[now [\u4F1A\u8BDD\u952E\u524D\u7F00]]",
            description: "\u4E3B\u52A8\u642D\u8BDD\uFF1A\u67E5\u770B\u72B6\u6001\uFF0C\u6216\u8BA9 Agent \u7ACB\u523B\u4E3B\u52A8\u627E\u5BF9\u65B9\u8BF4\u4E00\u53E5",
            plugin: "speakup",
            run: async ({ argv }) => {
              if (argv[0] !== "now") return { text: statusText(sp, config) };
              const prefix = argv[1];
              const list = sp.targets().filter((t) => !prefix || t.key === prefix || t.key.startsWith(`${prefix}:`));
              const target = list.sort((a, b) => b.updatedAt - a.updatedAt)[0];
              if (!target) return { text: prefix ? `\u6CA1\u6709\u5339\u914D ${prefix} \u7684\u4F1A\u8BDD` : "\u8FD8\u6CA1\u6709\u53EF\u4EE5\u4E3B\u52A8\u627E\u7684\u79C1\u804A\u4F1A\u8BDD", isError: true };
              return { text: resultText(await sp.fire(target)) };
            }
          })
        );
      }
    }
  };
}
var plugin = createSpeakUpPlugin();
var index_default = plugin;
export {
  ANGLES,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  STATE_FILE_NAME,
  SpeakUp,
  TICK_MS,
  buildPrompt,
  clock,
  createSpeakUpPlugin,
  index_default as default,
  idleText,
  isAwake,
  matchesTarget,
  normalizeConfig,
  resultText,
  statusText
};
