// src/index.ts
var DEEPSEEK_BASE_URL = "https://api.deepseek.com";
var DEEPSEEK_MODELS = [
  { id: "deepseek-flash", contextWindow: 1e6, maxOutputTokens: 384e3, pricing: { inputPerMTok: 0.3, cachedInputPerMTok: 6e-3, outputPerMTok: 1.2 } },
  { id: "deepseek-v4-pro", contextWindow: 1e6, maxOutputTokens: 384e3, pricing: { inputPerMTok: 1.32, cachedInputPerMTok: 0.044, outputPerMTok: 3.96 } }
];
var LEGACY_MODELS = {
  "deepseek-chat": { model: "deepseek-flash", thinking: "disabled" },
  "deepseek-reasoner": { model: "deepseek-flash", thinking: "enabled" }
};
var ROUTED_ALIASES = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];
var configError = (message) => Object.assign(new Error(message), { name: "LeoError", code: "invalid_request", [/* @__PURE__ */ Symbol.for("leo.error")]: true });
var EFFORTS = ["low", "high", "max"];
function settingsOf(s) {
  const out = {};
  if (s.thinking === "enabled" || s.thinking === "disabled") out.thinking = s.thinking;
  else if (s.thinking !== void 0) throw configError('deepseek: "thinking" must be "enabled" or "disabled" (provider.json)');
  if (s.reasoningEffort !== void 0) {
    if (!EFFORTS.includes(s.reasoningEffort)) throw configError(`deepseek: "reasoningEffort" must be one of ${EFFORTS.join(" / ")} (provider.json)`);
    out.reasoningEffort = s.reasoningEffort;
  }
  if (s.legacyModels === false) out.legacyModels = false;
  return out;
}
function prepareDeepSeekBody(body, input) {
  const s = settingsOf(input.settings);
  const out = { ...body };
  let thinking = s.thinking;
  const legacy = s.legacyModels === false ? void 0 : LEGACY_MODELS[String(out.model)];
  if (legacy) {
    out.model = legacy.model;
    thinking ??= legacy.thinking;
  }
  if (thinking) out.thinking = { type: thinking };
  if (s.reasoningEffort && thinking !== "disabled") out.reasoning_effort = s.reasoningEffort;
  return out;
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
      // 旧名字也给出模型信息，预算与上下文窗口按改写后的模型算
      ...Object.entries(LEGACY_MODELS).map(([id, l]) => ({ ...DEEPSEEK_MODELS.find((m) => m.id === l.model), id })),
      ...ROUTED_ALIASES.map((id) => ({ ...DEEPSEEK_MODELS[0], id }))
    ],
    maxTokensField: "max_tokens",
    // 带工具的请求必须回传全部 reasoning_content；不带工具时 DeepSeek 会忽略，所以始终回传
    sendReasoning: true,
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
  DEEPSEEK_MODELS,
  LEGACY_MODELS,
  createDeepSeekDriver,
  createProviderDeepSeekPlugin,
  index_default as default,
  prepareDeepSeekBody
};
