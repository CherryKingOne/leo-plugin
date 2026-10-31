# leo-plugin-provider-spark

[leo-plugin-provider](../provider) 的讯飞星火子插件：接入[星辰 MaaS 平台](https://maas.xfyun.cn/doc/)上讯飞**自研**的星火模型。

需要 leo-agents ≥ 0.2.0、leo-plugin-provider ≥ 0.2.0（错误码分类需要 ≥ 0.3.1，自动写入 provider.json 需要 ≥ 0.3.0）。

## 安装与接入

```bash
leo plugin add provider
leo plugin add provider-spark
leo auth set spark          # 或 export SPARK_API_KEY=ak-...（也认 SPARK_API_PASSWORD）
leo -m spark/spark-x2.6
```

APIKey 在星辰 MaaS 控制台「API调用 / APIKEY管理」获取。

## 模型

只内置讯飞自研的模型，不请求平台的模型列表（平台上还有开源 / 第三方模型）：

| 模型 | Model | 上下文 | 输入 / 输出 |
| --- | --- | --- | --- |
| Spark-X2.6（默认） | `spark-x2.6` | 1M | 文本 / 文本 |
| Spark-X2.6-4B | `spark-x2.6-4b` | 1M | 文本 / 文本 |
| Spark-X2.6-Preview | `spark-x2.6-preview` | 256K | 文本 / 文本 |
| Spark-X2.5 | `spark-x2.5` | 256K | 文本 / 文本 |
| Spark-X2.5-4B | `spark-x2.5-4b` | 1M | 文本 / 文本 |
| Spark-X2.5-1.7B | `spark-x2.5-1.7b` | 1M | 文本 / 文本 |

文档没有给出最大输出长度和价格，需要时可在 provider.json 的 `models` 里补充。

## 思考模式

按 [Chat 接口文档](https://maas.xfyun.cn/doc/guide/3%E3%80%81API%20%E6%8E%A5%E5%8F%A3/3.1%20%E6%98%9F%E7%81%AB%E6%A8%A1%E5%9E%8B%20API/3.1.1%20Chat.html)，`thinking.type` 有三种取值，默认 `enabled`：

| 取值 | 含义 |
| --- | --- |
| `enabled` | 强制开启（默认） |
| `disabled` | 强制关闭 |
| `auto` | 由模型自行判断（星火扩展取值） |

- 思考内容（`reasoning_content`）在 leo 里以 💭 显示
- 星火**没有思考预算，也没有推理强度参数**：`--effort none` 等同关闭思考，其它强度不发送
- 优先级从高到低：交互中 `/think on|off`（会写回 provider.json）> 命令行 `--thinking`、`--effort none` > `.leo/config.json` 的 `agent.reasoning` > provider.json 的 `thinking` > 默认 `enabled`

## provider.json

装好后自动写入 `spark` 条目（项目里有 `.leo/provider.json` 写项目的，否则写 `~/.leo/provider.json`），`/model`、`/think` 切换后同步：

```jsonc
{
  "providers": {
    "spark": {
      "defaultModel": "spark-x2.6",
      "thinking": "enabled",     // enabled / disabled / auto，或 true / false
      // "webSearch": true,      // 可选：开启内置联网搜索工具 web_search
      // "user": "team_a"        // 可选：终端用户标识，只用 a-z A-Z 0-9 - _，勿填隐私信息
    }
  }
}
```

## 按文档处理的细节

- 输出上限用 `max_completion_tokens`（包含思考 token）；`max_tokens` 已废弃
- `temperature`（固定 1）、`top_p`（固定 0.95）不发送；`presence_penalty`、`frequency_penalty` 已废弃，不发送
- 消息 `content` 必填且只支持文本：助手的空内容发空字符串，非文本块去掉；请求里不回传 `reasoning_content`
- 工具最多 128 个
- 错误：HTTP 状态码加顶层 `{ code, message }`（流里也可能出现），按[错误码速查](https://maas.xfyun.cn/doc/guide/1%E3%80%81%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B/1.2%20%E9%94%99%E8%AF%AF%E7%A0%81%E9%80%9F%E6%9F%A5.html)分类：

| 错误码 | 处理 |
| --- | --- |
| 10013 / 10014 / 10313 / 10314（敏感内容）、10005 / 10305 / 10163 / 10404（参数） | 直接报错，不重试 |
| 10224（序列过长） | 按上下文超限（context_overflow）报告 |
| 11200 / 11221（未授权、套餐不含该模型）、11201（当日用量用完） | 直接报错，不重试 |
| 11202 / 11203 / 11210（QPS、并发、TPM 超限） | 限流，退避重试 |
| 10042、10011 等 5xx、10010 / 10110 / 10310（引擎繁忙） | 服务繁忙，退避重试 |
