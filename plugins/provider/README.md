# leo-plugin-provider

模型供应商**注册层**（大箱子）。leo-agents 0.2 起底座不再内置任何模型厂商，Agent 用到的模型全部由本插件接入：

```
Agent ⇄ llm 服务（底座，只有接口）
          ⇅
      provider（注册层：读配置、取密钥、选默认模型、统一调度）
        ├── provider-deepseek   DeepSeek 子插件（驱动 deepseek）
        ├── provider-longcat    LongCat（美团）子插件（驱动 longcat）
        ├── provider-xxx        以后的通义、Kimi……子插件
        └── openai-compatible   内置通用协议：没有子插件的兼容端点写 baseURL 即可
```

> 需要 leo-agents ≥ 0.2.0；实时模型列表的展示、思考与推理强度调整需要 leo-agents main 上的 0.2.0（2026-10-31 之后的提交）。在 0.1.x 上加载会直接报错：0.1.x 自带的供应商会和本插件冲突。

## 安装

```bash
leo plugin add provider            # 注册层，同时生成 ~/.leo/provider.json
leo plugin add provider-deepseek   # DeepSeek 子插件
leo plugin add provider-longcat    # LongCat（美团）子插件
leo auth set deepseek              # 保存密钥（或 export DEEPSEEK_API_KEY）
leo models                         # 实时列出各厂商的真实模型与详情
```

装了子插件的厂商自动接入（`autoDetect`），不用改配置：有密钥即可用；没密钥时 `leo models` / `leo doctor` 会列出来并提示 `leo auth set <id>`。

安装 leo-agents 0.2.0：

```bash
npm install -g github:CherryKingOne/leo-agents#feat/provider-plugin
```

## 配置 `provider.json`

用户级 `~/.leo/provider.json`，项目级 `.leo/provider.json` 覆盖用户级；支持注释，保存后自动重新接入（插件热加载）。`leo auth set` 改了 `credentials.json` 也会自动重新探测。

```jsonc
{
  // 默认模型；.leo/config.json 的 "model" 优先
  "model": "deepseek/deepseek-flash",
  "providers": {
    // 有子插件的厂商：写 id 即可，只填要改的字段（驱动特有字段见各子插件 README）
    "deepseek": { "reasoningEffort": "high" },

    // 没有子插件的厂商 / 自建服务：写 baseURL，走通用 OpenAI 兼容协议
    "qwen": { "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "apiKeyEnv": "DASHSCOPE_API_KEY", "models": ["qwen-plus"] },
    "vllm": { "baseURL": "http://localhost:8000/v1", "keyless": true, "models": ["Qwen/Qwen3-32B"] },

    // 同一厂商第二个账号：driver 指定驱动，密钥按 provider id 存（leo auth set deepseek-work）
    "deepseek-work": { "driver": "deepseek" }
  },
  "autoDetect": true
}
```

| 字段 | 说明 |
| --- | --- |
| `driver` | 使用的驱动，默认等于 provider id |
| `protocol`（旧写法 `type`） | 协议，默认取驱动声明的，再默认 `openai-compatible` |
| `enabled` | `false` 不接入 |
| `default` | 设为默认 provider |
| `baseURL` | 端点；有驱动时可省略（覆盖驱动默认值，例如走代理） |
| `apiKey` / `apiKeyEnv` | 密钥引用 `$ENV` / `!command`；推荐 `leo auth set <id>` |
| `models` / `defaultModel` | 内置模型列表（字符串或 `{ id, name, contextWindow, maxOutputTokens, pricing, inputModalities, reasoning }`）与默认模型；实时获取到的信息优先，这里的价格等接口不给的字段会沿用 |
| `fetchModels` | 从 `GET {baseURL}/models` 实时获取模型列表与详情，默认 `true`；端点不支持时设 `false` |
| `headers` | 额外请求头，值支持 `$ENV` / `!command` |
| `keyless` | 本地服务不需要密钥 |
| `maxTokensField` / `sendReasoning` / `connectTimeoutMs` / `idleTimeoutMs` | 协议细节，一般由驱动决定 |

**模型列表**：`leo models` / 交互 `/models` 会调用每个 provider 的 `GET {baseURL}/models`，显示真实模型 id 与接口给出的详情（认识 `name` / `display_name`、`context_window` / `context_length`、`max_output_tokens`、`input_modalities`、`effort.supported_levels` 等常见字段，驱动可用 `mapModel` 解析厂商扩展）；第一次调用模型时也会在后台获取一次，让上下文窗口按真实值计算。获取失败时退回内置列表并显示原因。

**思考与推理强度**：宿主统一的 `reasoning`（`--thinking` / `--effort`、`/think` / `/effort`、配置 `agent.reasoning`，leo-agents 0.2.0（main））交给驱动的 `prepare` 翻译；通用端点只在明确指定强度时发送 OpenAI 的 `reasoning_effort`。

**0.1.x 兼容**：写在 `.leo/config.json` 里的 `"providers"` 与 `"model"` 照常生效（优先级低于 provider.json）。0.1.x 内置的预设现在由子插件提供：例如 `"deepseek": {}` 需要装 `provider-deepseek`，没装时会提示安装，或给它写 `baseURL` 当作通用端点。

密钥优先级（由宿主 credentials 服务决定）：`--api-key` > 项目 `credentials.json` > 用户 `credentials.json` > 配置的 `apiKey` > 环境变量。

## provider.json 跟着用的东西走（0.3.0）

- **安装即填充**：装了子插件，provider.json 里该厂商没有条目或是 `{}` 时，自动写入默认模型、思考模式、推理强度，例如
  `"longcat": { "defaultModel": "LongCat-2.5-Preview", "thinking": "enabled", "reasoningEffort": "high" }`。写过字段的条目不动
- **切换即同步**：交互中 `/model` 写回顶层 `model` 与该厂商的 `defaultModel`；`/think on|off`、`/effort` 写回 `thinking` / `reasoningEffort`。命令行 `-m`、`--effort` 只作用于本次，不写回
- **写到哪**：项目里有 `.leo/provider.json` 就写它，否则写 `~/.leo/provider.json`。只改涉及的字段，注释保留
- `.leo/config.json` 里写了 `"model"` 时它仍然优先；不想自动写回：插件配置 `{ "persist": false }`

## 开发子插件（驱动）

子插件只用 `import type`，通过服务 `providers` 注册驱动；大多数 OpenAI 兼容厂商只需声明默认值：

```ts
import type { PluginDefinition } from 'leo-agents'

export default {
  name: 'leo-plugin-provider-moonshot',
  inject: ['providers'],
  async apply(ctx) {
    await ctx.effect(() =>
      ctx.get('providers').registerDriver({
        id: 'moonshot',
        name: 'Moonshot / Kimi',
        plugin: 'provider-moonshot',
        baseURL: 'https://api.moonshot.cn/v1',
        envKeys: ['MOONSHOT_API_KEY'],
        defaultModel: '<model>',
        models: [{ id: '<model>', contextWindow: 128_000 }],
        // 厂商特有参数：拿到通用请求体与 provider.json 里该 provider 的配置
        prepare: (body, { settings }) => body,
        // 可选：厂商业务错误码 → 错误类别（0.3.1），决定是否重试
        errorCodes: { '10013': 'invalid_request', '11202': 'rate_limit' },
        // 可选：provider.json 里没有该厂商时写入的默认条目（0.3.0）
        settingsTemplate: { defaultModel: '<model>' },
      }),
    )
  },
} satisfies PluginDefinition
```

- 协议不兼容的厂商：驱动实现 `create({ id, settings, apiKey, resolved })` 返回自己的 `LlmProvider`；或者用 `registerProtocol(name, factory)` 注册一个新协议，供多个厂商共用
- 通用协议认识 `error: { message, code }` 与顶层 `{ code, message }`（code 0 为成功）两种错误格式，HTTP 错误体和流里都会检查
- 抛错时带上 `Symbol.for('leo.error')` 标记和 `code`（`rate_limit` / `overloaded` / `timeout` / `network` / `auth` / `invalid_request` / `context_overflow`），宿主据此决定是否重试；本插件导出 `providerError()`
- 驱动注册 / 撤销、注册层热重载，都会整体重新同步，子插件先装后装都一样

服务 `providers`：`registerDriver(driver)`、`registerProtocol(name, factory)`、`drivers()`、`protocols()`、`status()`（每个 provider 的 `ready` / `no_key` / `waiting_driver` / `disabled` / `error` 与原因）。
