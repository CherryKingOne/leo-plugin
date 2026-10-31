// src/index.ts
var SPARK_BASE_URL = "https://maas-api.cn-huabei-1.xf-yun.com/v2";
var SPARK_DEFAULT_MODEL = "spark-x2.6";
var SPARK_MAX_TOOLS = 128;
var K256 = 262144;
var M1 = 1048576;
var REASONING = { supported: true, canDisable: true, defaultEnabled: true };
var model = (id, name, contextWindow) => ({
  id,
  name,
  contextWindow,
  inputModalities: ["text"],
  outputModalities: ["text"],
  reasoning: REASONING,
  ownedBy: "iFLYTEK"
});
var SPARK_MODELS = [
  model("spark-x2.6", "Spark-X2.6", M1),
  model("spark-x2.6-4b", "Spark-X2.6-4B", M1),
  model("spark-x2.6-preview", "Spark-X2.6-Preview", K256),
  model("spark-x2.5", "Spark-X2.5", K256),
  model("spark-x2.5-4b", "Spark-X2.5-4B", M1),
  model("spark-x2.5-1.7b", "Spark-X2.5-1.7B", M1)
];
var SPARK_ERROR_CODES = {
  // 400
  "10005": "invalid_request",
  // 输入格式不正确
  "10305": "invalid_request",
  "10013": "invalid_request",
  // 输入内容包含敏感内容
  "10313": "invalid_request",
  "10014": "invalid_request",
  // 输出内容包含敏感内容
  "10314": "invalid_request",
  "10163": "invalid_request",
  // 部分参数不支持
  "10224": "context_overflow",
  // 序列过长
  "10404": "invalid_request",
  // model_id 不正确
  "10042": "overloaded",
  // 服务器内部错误（稍后重试）
  // 403
  "11200": "auth",
  // APIKEY 没有对应授权
  "11221": "auth",
  // 使用套餐不允许的模型
  // 429
  "11201": "auth",
  // 当日使用量达到上限
  "11202": "rate_limit",
  // QPS 超限
  "11203": "rate_limit",
  // 并发路数或 TPM 超限
  "11210": "rate_limit",
  // TPM 超限
  // 500 / 503
  "10020": "overloaded",
  "10041": "overloaded",
  "10011": "overloaded",
  "10012": "overloaded",
  "10912": "overloaded",
  "10222": "overloaded",
  "10223": "overloaded",
  "10051": "overloaded",
  // 与后端引擎连接超时
  "10110": "overloaded",
  // 引擎并发路数不足
  "10010": "overloaded",
  // 引擎排队较多
  "10310": "overloaded"
};
var configError = (message) => Object.assign(new Error(message), { name: "LeoError", code: "invalid_request", [/* @__PURE__ */ Symbol.for("leo.error")]: true });
function settingsOf(s) {
  const out = {};
  if (s.thinking === true) out.thinking = "enabled";
  else if (s.thinking === false) out.thinking = "disabled";
  else if (s.thinking === "enabled" || s.thinking === "disabled" || s.thinking === "auto") out.thinking = s.thinking;
  else if (s.thinking !== void 0) throw configError('spark: "thinking" must be "enabled" / "disabled" / "auto" (or true / false) in provider.json');
  if (s.webSearch !== void 0) {
    if (typeof s.webSearch !== "boolean") throw configError('spark: "webSearch" must be true / false in provider.json');
    out.webSearch = s.webSearch;
  }
  if (s.user !== void 0) {
    if (typeof s.user !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(s.user)) {
      throw configError('spark: "user" may only contain a-z, A-Z, 0-9, "-" and "_" (at most 512 characters) in provider.json');
    }
    out.user = s.user;
  }
  return out;
}
function textOnly(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => !!p && typeof p === "object" && p.type === "text").map((p) => p.text).join("");
  }
  return "";
}
function prepareSparkBody(body, input) {
  const s = settingsOf(input.settings);
  const out = { ...body };
  const r = input.request.reasoning;
  let type;
  if (r?.enabled !== void 0) type = r.enabled ? "enabled" : "disabled";
  else if (r?.effort === "none") type = "disabled";
  type ??= s.thinking ?? "enabled";
  out.thinking = { type };
  for (const k of ["temperature", "top_p", "presence_penalty", "frequency_penalty", "reasoning_effort", "thinking_budget"]) delete out[k];
  if (out.max_tokens !== void 0) {
    out.max_completion_tokens ??= out.max_tokens;
    delete out.max_tokens;
  }
  if (s.user) out.user = s.user;
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      const { reasoning_content: _r, reasoning: _r2, ...rest } = m;
      const next = { ...rest };
      if (Array.isArray(next.content) && next.content.every((p) => p?.type === "text")) {
      } else next.content = textOnly(next.content);
      return next;
    });
  }
  if (s.webSearch) {
    const tools = Array.isArray(out.tools) ? [...out.tools] : [];
    if (!tools.some((t) => t?.type === "web_search")) tools.push({ type: "web_search", web_search: { enable: true } });
    out.tools = tools;
  }
  if (Array.isArray(out.tools) && out.tools.length > SPARK_MAX_TOOLS) {
    throw configError(`spark: at most ${SPARK_MAX_TOOLS} tools per request, got ${out.tools.length}`);
  }
  return out;
}
function createSparkDriver() {
  return {
    id: "spark",
    name: "\u8BAF\u98DE\u661F\u706B",
    plugin: "provider-spark",
    baseURL: SPARK_BASE_URL,
    envKeys: ["SPARK_API_KEY", "SPARK_API_PASSWORD"],
    defaultModel: SPARK_DEFAULT_MODEL,
    models: SPARK_MODELS,
    maxTokensField: "max_completion_tokens",
    // 文档的请求消息没有 reasoning_content，不回传历史思考
    sendReasoning: false,
    // 文档没有模型列表接口（平台上还有非自研模型），只用内置列表
    fetchModels: false,
    prepare: prepareSparkBody,
    errorCodes: SPARK_ERROR_CODES,
    // provider ≥ 0.3.0：provider.json 里没有 spark 条目时写入，/model、/think 切换后同步
    settingsTemplate: { defaultModel: SPARK_DEFAULT_MODEL, thinking: "enabled" }
  };
}
function createProviderSparkPlugin() {
  return {
    name: "leo-plugin-provider-spark",
    inject: ["providers"],
    async apply(ctx) {
      const registry = ctx.get("providers");
      try {
        await ctx.effect(() => registry.registerDriver(createSparkDriver()));
      } catch (err) {
        throw new Error(`provider-spark: ${err.message}\uFF08\u9700\u8981 leo-plugin-provider \u2265 0.2.0\uFF09`);
      }
    }
  };
}
var plugin = createProviderSparkPlugin();
var index_default = plugin;
export {
  SPARK_BASE_URL,
  SPARK_DEFAULT_MODEL,
  SPARK_ERROR_CODES,
  SPARK_MAX_TOOLS,
  SPARK_MODELS,
  createProviderSparkPlugin,
  createSparkDriver,
  index_default as default,
  prepareSparkBody
};
