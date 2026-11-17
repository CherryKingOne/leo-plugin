# leo-plugin-provider-qianfan

模型供应商注册层（[leo-plugin-provider](../provider)）的 **百度千帆（文心 ERNIE）子插件**，注册驱动 `qianfan`。目前只接文心一言（ERNIE）的文本生成模型。

```bash
leo plugin add provider
leo plugin add provider-qianfan
leo auth set qianfan         # 或 export QIANFAN_API_KEY=...（千帆控制台 → 系统管理 → API Key，形如 bce-v3/ALTAK-...）
leo models qianfan           # 列出内置的 ERNIE 模型
```

不用写配置：装好并保存密钥就自动接入。模型写 `qianfan/<model>`，例如：

```bash
leo -m qianfan/ernie-light-dt-1.0
```

同时装了别的子插件时，想默认用文心，在 `.leo/config.json` 写 `"model": "qianfan/ernie-5.5-flash-preview"`。

## 模型

端点 `https://qianfan.baidubce.com/v2`（[文本生成 API](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)，OpenAI Chat Completions 兼容），鉴权 `Authorization: Bearer <API Key>`。模型按[千帆模型列表 · 文本生成 · ERNIE 系列旗舰模型](https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j)（2026-11-11）：

| 模型 | 上下文 / 最大输出 | 思考 | 推理强度 | 默认流控 |
| --- | --- | --- | --- | --- |
| `ernie-5.5-flash-preview`（默认） | 1M / 128K（文档写 1M，这里按 128K 预留输出） | 只能开启 | 固定 high | RPM 300、TPM 3000000 |
| `ernie-light-dt-1.0` | 1M / 128K | 可开可关 | high / max（默认 max） | RPM 60、TPM 1000000 |
| `ernie-5.1` | 128K（最大输入 119K）/ 64K | 自带思考，不可关 | 可用 `thinkingBudget` 限长 | RPM 60、TPM 150000 |

`GET /v2/models` 会列出平台上所有模型（含图像、视频、向量和其它厂商），所以插件不实时获取，只展示上面三个。想用千帆上的其它模型，在 provider.json 的 `models` 里手动加（思考参数按该模型声明的 `reasoning` 处理，没声明就原样发送）。

千帆按人民币 / 千 token 计价，内置信息不带价格；需要预算估算时在 provider.json 的 `models` 里补 `pricing`。

## 深度思考

按[深度思考文档](https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv)：

- 默认始终开启思考、强度取最大；只有人工关闭（`/think off`、`--thinking off`、provider.json）才关
- `ernie-light-dt-1.0`：每次请求明确发送 `thinking: { "type": "enabled" | "disabled" }`；开启时发送 `reasoning_effort`，默认 `max`。千帆只有 high / max 两档生效，宿主的 minimal / low / medium / high 按 high，xhigh / max 按 max
- `ernie-5.5-flash-preview`：只能开启、强度不可调。不传 `thinking` 时服务端不会思考，所以插件始终发送 `thinking: { "type": "enabled" }`，不发关闭与 `reasoning_effort`（`/think off` 对它无效）
- `ernie-5.1`：本身就思考，不认 `thinking` 开关和 `reasoning_effort`；provider.json 写了 `thinkingBudget`（≥ 100）时发送 `thinking_budget` 限制思维链长度，不写就是模型支持的最大长度
- 思考内容（`reasoning_content`）在 leo 里以 💭 显示。按千帆文档，只在本轮工具调用循环里回传 `reasoning_content`，之前轮次的不再回传；关闭思考时全部不传

调整方式，优先级从高到低：

| 方式 | 写法 |
| --- | --- |
| 交互中 | `/think on` / `/think off`、`/effort high`（会同步写回 provider.json） |
| 命令行 | `leo --thinking off`、`leo --effort high`（只作用于本次） |
| `.leo/config.json` | `"agent": { "reasoning": { "enabled": true, "effort": "max" } }` |
| `provider.json` | `"qianfan": { "thinking": "enabled", "reasoningEffort": "max" }` |

## 错误处理

按[千帆错误码](https://cloud.baidu.com/doc/qianfan-api/s/Om9b4yj3w)：

- `tokens_too_long` / `characters_too_long` → 上下文超长（宿主会压缩后重试）
- `invalid_iam_token`、`account_overdue`、Coding / Token Plan 额度用完或未订阅 → 鉴权类，不重试
- `invalid_model`、`model_offline` → 参数错误，不重试
- RPM / TPM 限流（429）重试，5xx 按过载重试

## provider.json

装好后自动写入 `qianfan` 条目（项目里有 `.leo/provider.json` 写项目的，否则写 `~/.leo/provider.json`）：

```jsonc
{
  "providers": {
    "qianfan": {
      "defaultModel": "ernie-5.5-flash-preview",
      "thinking": "enabled",        // 或 "disabled"、true / false（只对 ernie-light-dt-1.0 生效）
      "reasoningEffort": "max",     // none / high / max，默认 max（只对 ernie-light-dt-1.0 生效）
      "thinkingBudget": 8192,      // 可选，思维链最大长度 ≥ 100（只对 ernie-5.1 生效），不写为最大
      // Token Plan 个人版用专属 API Key 时改成：
      // "baseURL": "https://qianfan.baidubce.com/v2/tokenplan/personal"
    }
  }
}
```

需要 leo-agents ≥ 0.2.0、leo-plugin-provider ≥ 0.3.1（错误码映射）；自动写入与同步需要 leo-plugin-provider ≥ 0.3.0。
