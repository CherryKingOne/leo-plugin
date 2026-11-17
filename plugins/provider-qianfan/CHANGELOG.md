# 更新日志

## 0.1.0 — 2026-11-17

首个版本：模型供应商注册层的百度千帆（文心 ERNIE）子插件（需要 leo-agents ≥ 0.2.0、leo-plugin-provider ≥ 0.3.1）。

- 驱动 `qianfan`：`https://qianfan.baidubce.com/v2`（OpenAI Chat Completions 兼容），保存 API Key（`leo auth set qianfan` 或 `QIANFAN_API_KEY`）即自动接入
- 只内置文心 ERNIE 旗舰文本模型：ernie-5.5-flash-preview（默认）/ ernie-light-dt-1.0 / ernie-5.1；不请求 `GET /v2/models`（会列出平台全部模型，含图像、视频、向量与其它厂商）
- 深度思考按模型处理：ernie-light-dt-1.0 用 `thinking` 开关、`reasoning_effort` low / high / max；ernie-5.5-flash-preview 只能开启、强度不可调，不发送关闭与强度；ernie-5.1 按普通文本模型，不发思考参数
- 思考开启时带工具调用的多轮回传 `reasoning_content`，关闭时去掉；助手消息 `null` 内容改成空字符串
- 千帆错误码映射：`tokens_too_long` / `characters_too_long` 记为上下文超长；`invalid_iam_token`、`account_overdue`、Coding / Token Plan 额度用完记为鉴权类（不重试）；`model_offline` 不重试
- 支持 Token Plan 个人版：provider.json 里把 `baseURL` 改成 `https://qianfan.baidubce.com/v2/tokenplan/personal`
- 安装后（provider ≥ 0.3.0）自动写入 provider.json：`"qianfan": { "defaultModel": "ernie-5.5-flash-preview", "thinking": "enabled", "reasoningEffort": "max" }`，`/model`、`/think`、`/effort` 切换后同步
