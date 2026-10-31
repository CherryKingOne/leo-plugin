# 更新日志

## 0.1.0 — 未发布

首个版本：模型供应商注册层的讯飞星火子插件（需要 leo-agents ≥ 0.2.0、leo-plugin-provider ≥ 0.2.0；错误码分类需要 ≥ 0.3.1）。

- 驱动 `spark`：`https://maas-api.cn-huabei-1.xf-yun.com/v2`（OpenAI Chat Completions 兼容），保存 APIKey（`leo auth set spark`、`SPARK_API_KEY` 或 `SPARK_API_PASSWORD`）即自动接入
- 只内置讯飞自研的 6 个模型：spark-x2.6（默认）/ spark-x2.6-4b / spark-x2.6-preview / spark-x2.5 / spark-x2.5-4b / spark-x2.5-1.7b；不请求平台模型列表（平台上还有非自研模型）
- 思考模式 `thinking: enabled | disabled | auto`，默认 enabled；`/think`、`--thinking`、`--effort none` 切换，provider.json 可设 `"thinking": "auto"`。星火没有思考预算与推理强度参数，其余强度不发送
- 按文档整理请求：输出上限用 `max_completion_tokens`；不发送固定值的 `temperature` / `top_p` 和已废弃的 penalty；消息只带文档支持的字段（不回传 `reasoning_content`，`content` 必填且只含文本）
- provider.json 可选 `webSearch`（内置联网搜索工具）、`user`（终端用户标识）；工具数量上限 128
- 错误码速查表映射成宿主错误类别：敏感内容、参数错误不重试，限流与引擎繁忙重试，当日用量用完不重试
- 安装后（provider ≥ 0.3.0）自动写入 provider.json：`"spark": { "defaultModel": "spark-x2.6", "thinking": "enabled" }`，`/model`、`/think` 切换后同步
