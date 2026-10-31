// src/index.ts
var DEEPSEEK_BASE_URL = "https://api.deepseek.com";
var DEEPSEEK_EFFORTS = ["low", "high", "max"];
var REASONING = { supported: true, canDisable: true, defaultEnabled: true, efforts: [...DEEPSEEK_EFFORTS], defaultEffort: "high" };
var DEEPSEEK_MODELS = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    reasoning: REASONING,
    ownedBy: "deepseek",
    pricing: { inputPerMTok: 0.3, cachedInputPerMTok: 6e-3, outputPerMTok: 1.2 }
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: REASONING,
    ownedBy: "deepseek",
    pricing: { inputPerMTok: 1.32, cachedInputPerMTok: 0.044, outputPerMTok: 3.96 }
  }
];
var LEGACY_MODELS = {
  "deepseek-chat": { model: "deepseek-flash", thinking: "disabled" },
  "deepseek-reasoner": { model: "deepseek-flash", thinking: "enabled" }
};
var ROUTED_ALIASES = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];
var configError = (message) => Object.assign(new Error(message), { name: "LeoError", code: "invalid_request", [/* @__PURE__ */ Symbol.for("leo.error")]: true });
var ALL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function settingsOf(s) {
  const out = {};
  if (s.thinking === "enabled" || s.thinking === true) out.thinking = "enabled";
  else if (s.thinking === "disabled" || s.thinking === false) out.thinking = "disabled";
  else if (s.thinking !== void 0) throw configError('deepseek: "thinking" must be "enabled" / "disabled" (or true / false) in provider.json');
  if (s.reasoningEffort !== void 0) {
    if (!ALL_EFFORTS.includes(s.reasoningEffort)) {
      throw configError(`deepseek: "reasoningEffort" must be one of none / low / high / max in provider.json, got "${String(s.reasoningEffort)}"`);
    }
    out.reasoningEffort = s.reasoningEffort;
  }
  if (s.legacyModels === false) out.legacyModels = false;
  return out;
}
function mapEffort(effort, supported = DEEPSEEK_EFFORTS) {
  if (effort === "none") return "none";
  const mapped = effort === "minimal" ? "low" : effort === "medium" || effort === "xhigh" ? "high" : effort;
  if (!supported.length || supported.includes(mapped)) return mapped;
  const order = ALL_EFFORTS.slice(1);
  const at = order.indexOf(mapped);
  const ranked = supported.filter((l) => order.includes(l)).sort((a, b) => Math.abs(order.indexOf(a) - at) - Math.abs(order.indexOf(b) - at));
  return ranked[0] ?? mapped;
}
function prepareDeepSeekBody(body, input) {
  const s = settingsOf(input.settings);
  const out = { ...body };
  const legacy = s.legacyModels === false ? void 0 : LEGACY_MODELS[String(out.model)];
  if (legacy) out.model = legacy.model;
  const r = input.request.reasoning;
  let enabled;
  let effort;
  let explicit = false;
  if (r && (r.enabled !== void 0 || r.effort !== void 0)) {
    explicit = true;
    effort = r.effort;
    enabled = r.enabled ?? (effort ? effort !== "none" : void 0);
    if (effort === "none") enabled = false;
  }
  if (enabled === void 0 && s.thinking) {
    explicit = true;
    enabled = s.thinking === "enabled";
  }
  if (effort === void 0 && s.reasoningEffort) effort = s.reasoningEffort;
  if (effort === "none" && enabled === void 0) enabled = false;
  if (enabled === void 0 && legacy) enabled = legacy.thinking === "enabled";
  enabled ??= true;
  const tc = out.tool_choice;
  if (enabled && tc !== void 0 && tc !== "auto" && tc !== "none") {
    if (explicit) throw configError('deepseek: tool_choice "required" or a named tool is not supported in thinking mode; turn thinking off (--thinking off, /think off) for this agent');
    enabled = false;
  }
  out.thinking = { type: enabled ? "enabled" : "disabled" };
  delete out.reasoning_effort;
  if (enabled && effort && effort !== "none") {
    const level = mapEffort(effort, input.model?.reasoning?.efforts ?? DEEPSEEK_EFFORTS);
    if (level !== "none") out.reasoning_effort = level;
  }
  if (!enabled && Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      if (m.role !== "assistant" || !("reasoning_content" in m)) return m;
      const { reasoning_content: _drop, ...rest } = m;
      return rest;
    });
  }
  return out;
}
function mapDeepSeekModel(raw, builtin) {
  const n = (v) => typeof v === "number" && v > 0 ? v : void 0;
  const arr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : void 0;
  const effort = raw.effort;
  const levels = arr(effort?.supported_levels)?.filter((l) => l !== "none");
  const def = typeof effort?.default_level === "string" ? effort.default_level : void 0;
  const reasoning = levels?.length ? { supported: true, canDisable: true, defaultEnabled: true, efforts: levels, ...def && levels.includes(def) ? { defaultEffort: def } : {} } : builtin?.reasoning ?? REASONING;
  const name = typeof raw.name === "string" ? raw.name : builtin?.name;
  const maxOut = n(raw.max_output_tokens) ?? builtin?.maxOutputTokens;
  const input = arr(raw.input_modalities) ?? builtin?.inputModalities;
  const output = arr(raw.output_modalities) ?? builtin?.outputModalities;
  return {
    ...builtin,
    id: raw.id,
    ...name ? { name } : {},
    contextWindow: n(raw.context_window) ?? builtin?.contextWindow ?? DEEPSEEK_MODELS[0].contextWindow,
    ...maxOut ? { maxOutputTokens: maxOut } : {},
    ...input ? { inputModalities: input } : {},
    ...output ? { outputModalities: output } : {},
    reasoning,
    ...typeof raw.owned_by === "string" ? { ownedBy: raw.owned_by } : {},
    source: "remote"
  };
}
function createDeepSeekDriver() {
  return {
    id: "deepseek",
    name: "DeepSeek",
    plugin: "provider-deepseek",
    baseURL: DEEPSEEK_BASE_URL,
    envKeys: ["DEEPSEEK_API_KEY"],
    defaultModel: "deepseek-flash",
    models: [
      ...DEEPSEEK_MODELS,
      // 旧名字只作为别名：请求时可用、预算按改写后的模型算，但不在模型列表里展示
      ...Object.entries(LEGACY_MODELS).map(([id, l]) => ({ ...DEEPSEEK_MODELS.find((m) => m.id === l.model), id, name: `${id}\uFF08\u5DF2\u4E0B\u7EBF\uFF0C\u6539\u7528 ${l.model}\uFF09`, alias: true })),
      ...ROUTED_ALIASES.map((id) => ({ ...DEEPSEEK_MODELS[0], id, name: `${id}\uFF08\u522B\u540D\uFF0C\u5373 deepseek-flash\uFF09`, alias: true }))
    ],
    maxTokensField: "max_tokens",
    // 思考模式下带工具的请求必须回传全部 reasoning_content；非思考模式由 prepare 去掉
    sendReasoning: true,
    fetchModels: true,
    mapModel: mapDeepSeekModel,
    prepare: prepareDeepSeekBody
  };
}
function createProviderDeepSeekPlugin() {
  return {
    name: "leo-plugin-provider-deepseek",
    inject: ["providers"],
    async apply(ctx) {
      const registry = ctx.get("providers");
      try {
        await ctx.effect(() => registry.registerDriver(createDeepSeekDriver()));
      } catch (err) {
        throw new Error(`provider-deepseek: ${err.message}\uFF08\u9700\u8981 leo-plugin-provider \u2265 0.1.0\uFF09`);
      }
    }
  };
}
var plugin = createProviderDeepSeekPlugin();
var index_default = plugin;
export {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_EFFORTS,
  DEEPSEEK_MODELS,
  LEGACY_MODELS,
  createDeepSeekDriver,
  createProviderDeepSeekPlugin,
  index_default as default,
  mapDeepSeekModel,
  mapEffort,
  prepareDeepSeekBody
};
