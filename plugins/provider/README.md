# leo-plugin-provider

模型供应商**注册层**（大箱子）。leo-agents 0.2 起底座不再内置任何模型厂商，Agent 用到的模型全部由本插件接入：

```
Agent ⇄ llm 服务（底座，只有接口）
          ⇅
      provider（注册层：读配置、取密钥、选默认模型、统一调度）
        ├── provider-deepseek   DeepSeek 子插件（驱动 deepseek）
        ├── provider-xxx        以后的通义、Kimi……子插件
        └── openai-compatible   内置通用协议：没有子插件的兼容端点写 baseURL 即可
```

> 需要 leo-agents ≥ 0.2.0（开发中：`feat/provider-plugin` 分支）。在 0.1.x 上加载会直接报错：0.1.x 自带的供应商会和本插件冲突。

## 安装

```bash
leo plugin add provider            # 注册层，同时生成 ~/.leo/provider.json
leo plugin add provider-deepseek   # DeepSeek 子插件
leo auth set deepseek              # 保存密钥（或 export DEEPSEEK_API_KEY）
leo models                         # ● deepseek  DeepSeek  默认模型 deepseek-flash
```

装了子插件的厂商自动接入（`autoDetect`），不用改配置：有密钥即可用；没密钥时 `leo models` / `leo doctor` 会列出来并提示 `leo auth set <id>`。

### 本地测试（未发布时）

```bash
# leo-agents：git checkout feat/provider-plugin && npm install && npm link
# leo-plugin：git checkout feat/provider-plugin && npm install && npm run build -w plugins/provider -w plugins/provider-deepseek
mkdir -p ~/.leo/plugins
cp plugins/provider/dist/provider.bundle.js plugins/provider-deepseek/dist/provider-deepseek.bundle.js ~/.leo/plugins/
cp plugins/provider/templates/provider.json ~/.leo/provider.json   # 可选
leo auth set deepseek && leo models
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
| `models` / `defaultModel` | 模型列表（字符串或 `{ id, contextWindow, maxOutputTokens, pricing }`）与默认模型 |
| `headers` | 额外请求头，值支持 `$ENV` / `!command` |
| `keyless` | 本地服务不需要密钥 |
| `maxTokensField` / `sendReasoning` / `connectTimeoutMs` / `idleTimeoutMs` | 协议细节，一般由驱动决定 |

**0.1.x 兼容**：写在 `.leo/config.json` 里的 `"providers"` 与 `"model"` 照常生效（优先级低于 provider.json）。0.1.x 内置的预设现在由子插件提供：例如 `"deepseek": {}` 需要装 `provider-deepseek`，没装时会提示安装，或给它写 `baseURL` 当作通用端点。

密钥优先级（由宿主 credentials 服务决定）：`--api-key` > 项目 `credentials.json` > 用户 `credentials.json` > 配置的 `apiKey` > 环境变量。

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
      }),
    )
  },
} satisfies PluginDefinition
```

- 协议不兼容的厂商：驱动实现 `create({ id, settings, apiKey, resolved })` 返回自己的 `LlmProvider`；或者用 `registerProtocol(name, factory)` 注册一个新协议，供多个厂商共用
- 抛错时带上 `Symbol.for('leo.error')` 标记和 `code`（`rate_limit` / `overloaded` / `timeout` / `network` / `auth` / `invalid_request` / `context_overflow`），宿主据此决定是否重试；本插件导出 `providerError()`
- 驱动注册 / 撤销、注册层热重载，都会整体重新同步，子插件先装后装都一样

服务 `providers`：`registerDriver(driver)`、`registerProtocol(name, factory)`、`drivers()`、`protocols()`、`status()`（每个 provider 的 `ready` / `no_key` / `waiting_driver` / `disabled` / `error` 与原因）。
