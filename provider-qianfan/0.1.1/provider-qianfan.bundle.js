// src/index.ts
var QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
var QIANFAN_TOKEN_PLAN_BASE_URL = "https://qianfan.baidubce.com/v2/tokenplan/personal";
var QIANFAN_DEFAULT_MODEL = "ernie-5.5-flash-preview";
var QIANFAN_EFFORTS = ["low", "high", "max"];
var ALL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function normalizeQianfanEffort(e) {
  if (e === "none") return "none";
  if (e === "minimal") return "low";
  if (e === "medium") return "high";
  if (e === "xhigh") return "max";
  return QIANFAN_EFFORTS.includes(e) ? e : void 0;
}
var ERNIE_THINKING = {
  "ernie-5.5-flash-preview": { toggle: "always-on", effort: false },
  "ernie-light-dt-1.0": { toggle: "switch", effort: true },
  "ernie-5.1": { toggle: "none", effort: false }
};
var QIANFAN_MODELS = [
  {
    id: "ernie-5.5-flash-preview",
    name: "ERNIE-5.5-Flash-Preview",
    contextWindow: 1e6,
    maxOutputTokens: 131072,
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: { supported: true, canDisable: false, defaultEnabled: true, efforts: ["high"], defaultEffort: "high" },
    ownedBy: "Baidu"
  },
  {
    id: "ernie-light-dt-1.0",
    name: "ERNIE-Light-DT-1.0",
    contextWindow: 1e6,
    maxOutputTokens: 131072,
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: { supported: true, canDisable: true, defaultEnabled: true, efforts: [...QIANFAN_EFFORTS], defaultEffort: "max" },
    ownedBy: "Baidu"
  },
  {
    id: "ernie-5.1",
    name: "ERNIE 5.1",
    contextWindow: 131072,
    maxOutputTokens: 65536,
    inputModalities: ["text"],
    outputModalities: ["text"],
    ownedBy: "Baidu"
  }
];
var QIANFAN_ERROR_CODES = {
  tokens_too_long: "context_overflow",
  characters_too_long: "context_overflow",
  invalid_model: "invalid_request",
  model_offline: "invalid_request",
  invalid_iam_token: "auth",
  account_overdue: "auth",
  // 套餐额度用完不是暂时性错误，不重试
  coding_plan_hour_quota_exceeded: "auth",
  coding_plan_week_quota_exceeded: "auth",
  coding_plan_month_quota_exceeded: "auth",
  coding_plan_api_key_required: "auth",
  coding_plan_api_key_not_allowed: "auth",
  coding_plan_not_subscribed: "auth",
  coding_plan_subscription_expired: "auth",
  coding_plan_cluster_rate_limited: "overloaded"
};
var configError = (message) => Object.assign(new Error(message), { name: "LeoError", code: "invalid_request", [/* @__PURE__ */ Symbol.for("leo.error")]: true });
function settingsOf(s) {
  const out = {};
  if (s.thinking === "enabled" || s.thinking === true) out.thinking = "enabled";
  else if (s.thinking === "disabled" || s.thinking === false) out.thinking = "disabled";
  else if (s.thinking !== void 0) throw configError('qianfan: "thinking" must be "enabled" / "disabled" (or true / false) in provider.json');
  if (s.reasoningEffort !== void 0) {
    const e = ALL_EFFORTS.includes(s.reasoningEffort) ? normalizeQianfanEffort(s.reasoningEffort) : void 0;
    if (!e) throw configError(`qianfan: "reasoningEffort" must be one of none / low / high / max in provider.json, got "${String(s.reasoningEffort)}"`);
    out.reasoningEffort = e;
  }
  return out;
}
function thinkingSpecOf(model, info) {
  const known = ERNIE_THINKING[model.toLowerCase()];
  if (known) return known;
  const r = info?.reasoning;
  if (!r?.supported) return { toggle: "none", effort: false };
  return { toggle: r.canDisable === false ? "always-on" : "switch", effort: (r.efforts?.length ?? 0) > 1 };
}
function prepareQianfanBody(body, input) {
  const s = settingsOf(input.settings);
  const out = { ...body };
  const model = typeof out.model === "string" ? out.model : input.request.model ?? "";
  const spec = thinkingSpecOf(model, input.model);
  const r = input.request.reasoning;
  const reqEffort = normalizeQianfanEffort(r?.effort);
  let enabled;
  if (r?.enabled !== void 0) enabled = r.enabled;
  else if (reqEffort === "none") enabled = false;
  if (enabled === void 0 && s.thinking) enabled = s.thinking === "enabled";
  if (enabled === void 0 && s.reasoningEffort === "none") enabled = false;
  enabled ??= true;
  delete out.thinking;
  delete out.reasoning_effort;
  delete out.enable_thinking;
  if (spec.toggle === "none") enabled = false;
  else if (spec.toggle === "always-on") {
    enabled = true;
    out.thinking = { type: "enabled" };
  } else {
    out.thinking = { type: enabled ? "enabled" : "disabled" };
  }
  if (enabled && spec.effort) {
    const fileEffort = s.reasoningEffort && s.reasoningEffort !== "none" ? s.reasoningEffort : void 0;
    const effort = reqEffort && reqEffort !== "none" ? reqEffort : fileEffort;
    if (effort) out.reasoning_effort = effort;
  }
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
function createQianfanDriver() {
  return {
    id: "qianfan",
    name: "\u767E\u5EA6\u5343\u5E06\uFF08\u6587\u5FC3 ERNIE\uFF09",
    plugin: "provider-qianfan",
    baseURL: QIANFAN_BASE_URL,
    envKeys: ["QIANFAN_API_KEY"],
    defaultModel: QIANFAN_DEFAULT_MODEL,
    models: QIANFAN_MODELS,
    maxTokensField: "max_tokens",
    // 思考 + 工具调用时回传历史思考内容；非思考模式由 prepare 去掉
    sendReasoning: true,
    // /v2/models 返回平台全部模型（含非文本与其它厂商），只展示内置的 ERNIE 模型
    fetchModels: false,
    errorCodes: QIANFAN_ERROR_CODES,
    prepare: prepareQianfanBody,
    // provider ≥ 0.3.0：provider.json 里没有 qianfan 条目时写入，/model、/think、/effort 切换后同步
    settingsTemplate: { defaultModel: QIANFAN_DEFAULT_MODEL, thinking: "enabled", reasoningEffort: "max" }
  };
}
function createProviderQianfanPlugin() {
  return {
    name: "leo-plugin-provider-qianfan",
    inject: ["providers"],
    async apply(ctx) {
      const registry = ctx.get("providers");
      try {
        await ctx.effect(() => registry.registerDriver(createQianfanDriver()));
      } catch (err) {
        throw new Error(`provider-qianfan: ${err.message}\uFF08\u9700\u8981 leo-plugin-provider \u2265 0.3.1\uFF09`);
      }
    }
  };
}
var plugin = createProviderQianfanPlugin();
var index_default = plugin;
export {
  ERNIE_THINKING,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL,
  QIANFAN_EFFORTS,
  QIANFAN_ERROR_CODES,
  QIANFAN_MODELS,
  QIANFAN_TOKEN_PLAN_BASE_URL,
  createProviderQianfanPlugin,
  createQianfanDriver,
  index_default as default,
  normalizeQianfanEffort,
  prepareQianfanBody,
  thinkingSpecOf
};
