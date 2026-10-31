// src/index.ts
var LONGCAT_BASE_URL = "https://api.longcat.chat/openai/v1";
var LONGCAT_DEFAULT_MODEL = "LongCat-2.5-Preview";
var LONGCAT_MAX_THINKING_BUDGET = 262144;
var LONGCAT_THINKING_BUDGETS = { low: 8192, medium: 32768, high: 131072, max: LONGCAT_MAX_THINKING_BUDGET };
var EFFORTS = ["low", "medium", "high", "max"];
var ALL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function normalizeLongCatEffort(e) {
  if (e === "none") return "none";
  if (e === "minimal") return "low";
  if (e === "xhigh") return "max";
  return EFFORTS.includes(e) ? e : void 0;
}
var REASONING = { supported: true, canDisable: true, defaultEnabled: true, efforts: EFFORTS, defaultEffort: "high" };
var LONGCAT_MODELS = [
  {
    id: LONGCAT_DEFAULT_MODEL,
    name: "LongCat-2.5-Preview",
    contextWindow: 1048576,
    maxOutputTokens: 262144,
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: REASONING,
    ownedBy: "LongCat",
    pricing: { inputPerMTok: 0.3, cachedInputPerMTok: 6e-3, outputPerMTok: 1.2 }
  }
];
var configError = (message) => Object.assign(new Error(message), { name: "LeoError", code: "invalid_request", [/* @__PURE__ */ Symbol.for("leo.error")]: true });
function settingsOf(s) {
  const out = {};
  if (s.thinking === "enabled" || s.thinking === true) out.thinking = "enabled";
  else if (s.thinking === "disabled" || s.thinking === false) out.thinking = "disabled";
  else if (s.thinking !== void 0) throw configError('longcat: "thinking" must be "enabled" / "disabled" (or true / false) in provider.json');
  if (s.reasoningEffort !== void 0) {
    const e = ALL_EFFORTS.includes(s.reasoningEffort) ? normalizeLongCatEffort(s.reasoningEffort) : void 0;
    if (!e) throw configError(`longcat: "reasoningEffort" must be one of none / low / medium / high / max in provider.json, got "${String(s.reasoningEffort)}"`);
    out.reasoningEffort = e;
  }
  if (s.thinkingBudget !== void 0) {
    const b = s.thinkingBudget;
    if (typeof b !== "number" || !Number.isInteger(b) || b < 1 || b > LONGCAT_MAX_THINKING_BUDGET) {
      throw configError(`longcat: "thinkingBudget" must be an integer between 1 and ${LONGCAT_MAX_THINKING_BUDGET} in provider.json`);
    }
    out.thinkingBudget = b;
  }
  return out;
}
function prepareLongCatBody(body, input) {
  const s = settingsOf(input.settings);
  const out = { ...body };
  const r = input.request.reasoning;
  const reqEffort = normalizeLongCatEffort(r?.effort);
  let enabled;
  if (r?.enabled !== void 0) enabled = r.enabled;
  else if (reqEffort === "none") enabled = false;
  if (enabled === void 0 && s.thinking) enabled = s.thinking === "enabled";
  if (enabled === void 0 && s.reasoningEffort === "none") enabled = false;
  enabled ??= true;
  out.thinking = { type: enabled ? "enabled" : "disabled" };
  delete out.reasoning_effort;
  delete out.thinking_budget;
  if (enabled) {
    const fileEffort = s.reasoningEffort && s.reasoningEffort !== "none" ? s.reasoningEffort : void 0;
    out.thinking_budget = reqEffort && reqEffort !== "none" ? LONGCAT_THINKING_BUDGETS[reqEffort] : s.thinkingBudget ?? LONGCAT_THINKING_BUDGETS[fileEffort ?? "high"];
  }
  delete out.temperature;
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      if (m.role !== "assistant") return m;
      let next = m;
      if (next.content === null || next.content === void 0) next = { ...next, content: "" };
      if (!enabled && "reasoning_content" in next) {
        const { reasoning_content: _drop, ...rest } = next;
        next = rest;
      }
      return next;
    });
  }
  return out;
}
function mapLongCatModel(raw, builtin) {
  const n = (v) => typeof v === "number" && v > 0 ? v : void 0;
  const arr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : void 0;
  const arch = raw.architecture ?? {};
  const base = builtin ?? { ...LONGCAT_MODELS[0], name: raw.id };
  const name = typeof raw.name === "string" ? raw.name : base.name;
  const input = arr(arch.input_modalities) ?? arr(raw.input_modalities) ?? base.inputModalities;
  const output = arr(arch.output_modalities) ?? arr(raw.output_modalities) ?? base.outputModalities;
  return {
    ...base,
    id: raw.id,
    ...name ? { name } : {},
    contextWindow: n(raw.context_length) ?? n(raw.context_window) ?? base.contextWindow,
    ...input ? { inputModalities: input } : {},
    ...output ? { outputModalities: output } : {},
    reasoning: base.reasoning ?? REASONING,
    ...typeof raw.owned_by === "string" ? { ownedBy: raw.owned_by } : {},
    source: "remote"
  };
}
function createLongCatDriver() {
  return {
    id: "longcat",
    name: "LongCat",
    plugin: "provider-longcat",
    baseURL: LONGCAT_BASE_URL,
    envKeys: ["LONGCAT_API_KEY"],
    defaultModel: LONGCAT_DEFAULT_MODEL,
    models: LONGCAT_MODELS,
    maxTokensField: "max_tokens",
    // 思考 + 工具调用时回传历史思考内容（与 DeepSeek 同类协议）；非思考模式由 prepare 去掉
    sendReasoning: true,
    fetchModels: true,
    mapModel: mapLongCatModel,
    prepare: prepareLongCatBody,
    // provider ≥ 0.3.0：provider.json 里没有 longcat 条目时写入，/think、/effort 切换后同步这些字段
    settingsTemplate: { defaultModel: LONGCAT_DEFAULT_MODEL, thinking: "enabled", reasoningEffort: "high" }
  };
}
function createProviderLongCatPlugin() {
  return {
    name: "leo-plugin-provider-longcat",
    inject: ["providers"],
    async apply(ctx) {
      const registry = ctx.get("providers");
      try {
        await ctx.effect(() => registry.registerDriver(createLongCatDriver()));
      } catch (err) {
        throw new Error(`provider-longcat: ${err.message}\uFF08\u9700\u8981 leo-plugin-provider \u2265 0.2.0\uFF09`);
      }
    }
  };
}
var plugin = createProviderLongCatPlugin();
var index_default = plugin;
export {
  LONGCAT_BASE_URL,
  LONGCAT_DEFAULT_MODEL,
  LONGCAT_MAX_THINKING_BUDGET,
  LONGCAT_MODELS,
  LONGCAT_THINKING_BUDGETS,
  createLongCatDriver,
  createProviderLongCatPlugin,
  index_default as default,
  mapLongCatModel,
  normalizeLongCatEffort,
  prepareLongCatBody
};
