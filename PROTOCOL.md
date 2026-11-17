# leo 插件开发协议（Rust）

> 适用于 leo-agents ≥ 0.1.0。本协议是本仓库所有官方插件必须遵守的约定，也可以作为第三方插件的开发参考。
> 本仓库已从 TypeScript 重写为 Rust：插件是实现了 `leo_plugin_sdk::Plugin` 的 crate，宿主是 `leo-plugin-host`（子进程 + 换行分隔 JSON-RPC）或任何嵌入 `leo-plugin-sdk` 的 Rust 程序。

关键词约定：**必须**（MUST）= 不满足不予合并；**应当**（SHOULD）= 有充分理由才可例外；**可以**（MAY）= 可选。

---

## 1. 插件是什么

leo-agents 是“一切皆插件”的底座：内核只负责**服务注册、事件分发、可撤销副作用**，模型、工具、会话、上下文、Agent Loop 本身都是插件。一个插件就是一个实现了 [`Plugin`] 的类型，在 [`Plugin::apply`] 里通过 [`Context`] 注册能力。

宿主加载插件时会：

1. 用插件声明的 `config_schema`（JSON Schema）校验配置，失败返回 `plugin_config_invalid`。
2. 等待 `inject` 声明的服务全部就绪（未就绪时插件处于 `pending`）。
3. 调用 `apply(ctx, config)`。
4. 卸载插件、或它依赖的某个服务被替换时，自动执行 `ctx.dispose()`，撤销它通过 `ctx` 做过的所有注册；依赖被替换后会重新 `apply`。

插件是**热加载**的：leo 运行中，插件被安装、移除、更新，或插件声明的数据文件被修改时，宿主会在不重启的情况下卸载旧实例、加载新实例。因此每个插件都**必须**能被随时加载、卸载、重复加载。

## 2. 插件的导出形式

插件是一个 Rust crate（`crate-type = ["rlib"]`），在 `src/lib.rs` 中定义一个实现 [`Plugin`] 的类型，并在 `src/main.rs` 中通过 `leo_plugin_sdk::runtime::serve` 提供子进程入口。

```rust
use async_trait::async_trait;
use leo_plugin_sdk::{json, Context, Plugin, Result, Value};

pub struct MyPlugin;

#[async_trait]
impl Plugin for MyPlugin {
    fn name(&self) -> &str { "leo-plugin-example" }
    fn inject(&self) -> Vec<String> { vec!["tools".into()] }
    fn config_schema(&self) -> Value {
        json!({"type":"object","properties":{"maxDepth":{"type":"integer","minimum":1,"default":1}}})
    }
    async fn apply(&self, ctx: Context, config: Value) -> Result<()> {
        // 注册服务、工具、事件监听
        Ok(())
    }
}
```

| 字段 | 必须 | 说明 |
| --- | --- | --- |
| `name` | 是 | 插件名，官方插件**必须**等于 crate 名（`leo-plugin-<id>`），用于日志与诊断 |
| `inject` | 否 | 依赖的服务键。全部就绪才会 `apply`；任一被替换会自动重新 `apply` |
| `watch` | 否 | 热加载要关注的数据文件，相对 `.leo/` 的路径，`/` 结尾表示目录，如 `["mcp-servers.json"]`、`["agents/"]` |
| `config_schema` | 否 | 配置 JSON Schema。**应当**为每个字段提供默认值，使插件在无配置时也能运行 |
| `apply` | 是 | 入口，async |

`src/main.rs` 必须把插件交给运行时：

```rust
use std::sync::Arc;
use leo_plugin_sdk::runtime;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    runtime::serve(Arc::new(my_plugin::MyPlugin)).await
}
```

## 3. 运行时依赖规则

1. 插件**必须**依赖 `leo-plugin-sdk`（path 依赖），不得依赖宿主 `leo-agents`（它是 TypeScript 项目，Rust 插件不与其链接）。
2. 插件之间**不得**互相依赖对方的 crate；跨插件协作通过 `leo-plugin-sdk` 中的服务契约。
3. 需要 HTTP 的插件使用 `reqwest`（`rustls-tls`），不得使用阻塞式客户端在 async 上下文中调用。
4. 不得有平台特定 `.ts` / `package.json`；构建只使用 Cargo。

## 4. Context API（插件能做的全部事情）

`apply(ctx, config)` 中的 `ctx` 是插件作用域的 [`Context`]。通过它做的注册在卸载时**自动撤销**。

| 方法 | 用途 |
| --- | --- |
| `ctx.provide(key, Arc<T>)` / `ctx.get::<T>(key)` | 提供（或替换）/ 获取服务 |
| `ctx.provide_json` / `ctx.get_json` | JSON 值服务 |
| `ctx.has(key)` / `ctx.maybe(key)` | 判断服务是否存在 |
| `ctx.on(event, handler)` | 监听事件 |
| `ctx.emit(event, payload)` | 按事件声明的模式发布事件 |
| `ctx.waterfall` / `ctx.bail` / `ctx.serial` / `ctx.parallel` | 显式指定分发模式 |
| `ctx.effect(disposer)` | 包裹任意副作用；`disposer` 在卸载时按 LIFO 执行 |
| `ctx.fork()` / `ctx.fork_scope(tenant)` | 派生子作用域（tenant / agentId / sessionId） |
| `ctx.logger()` / `ctx.tenant()` / `ctx.signal()` | 日志、租户、插件生命周期取消信号 |

规则：

- 所有注册**必须**通过 `ctx` 完成；不通过 `ctx.provide/on/effect` 的副作用（定时器、子进程、文件句柄、全局状态）**必须**放进 `ctx.effect()` 并返回撤销 future，或监听 `ctx.signal()`。
- 模块顶层**不得**有副作用（不读文件、不发请求、启动定时器）。导入插件 crate 不应改变任何状态。
- 注册工具：`ctx.register_tool(Arc::new(tool)).await?`。
- 取消：遵守 `ctx.signal()` 与 `ToolContext::signal`，取消或超时时尽快停止并释放资源。

### 4.1 内置服务

| 服务键 | 提供方 | 说明 |
| --- | --- | --- |
| `sessions` | 核心 | 只追加会话日志 |
| `llm` | 核心 | 模型调用与 Provider 注册 |
| `tools` | 核心 | 工具注册表与受控执行管线 |
| `context` | 核心 | 系统提示片段、上下文构建与压缩 |
| `agentLoop` | 核心 | 创建 / 查找 Agent |
| `approval` | 可选 | 人工审批；不存在时 `ask` 决策一律拒绝 |
| `credentials` | 可选 | 密钥查找，`describe()` 不返回明文 |
| `leoPaths` | 可选 | 当前目录、项目根、项目 `.leo`、用户 `~/.leo` |

跨插件服务契约（定义在 `leo-plugin-sdk`）：

| 服务键 | 契约 | 提供方 / 使用方 |
| --- | --- | --- |
| `providers` | `ProvidersService` + `ProviderDriver` | provider / provider-* |
| `gateway` | `GatewayService` + `ChannelDriver` | gateway / gateway-qq、gateway-feishu、speakup |
| `interaction` | `InteractionService` + 人设 / 表情包类型 | interaction / interaction-* |

### 4.2 内置事件

| 事件 | 模式 | 用途 |
| --- | --- | --- |
| `llm/stream` | waterfall | 包裹每次模型调用：改写请求、替换事件流 |
| `context/transform` / `context/convert` | waterfall | 发送前改写消息 |
| `tools/pre-execute` | waterfall | 工具预检：返回 allow / deny / ask |
| `tools/guard` | bail | 不可绕过的拒绝底线 |
| `tools/execute` | waterfall | 包裹实际执行（超时、限流、沙箱代理） |
| `tools/post-execute` | waterfall | 结果后处理（脱敏、截断） |
| `agent/pre-step` | waterfall | step 前检查，可停止 turn |
| `agent/turn-stopping` | serial | turn 本应结束时决定是否继续 |
| `agent/event` | emit | 所有 AgentEvent 的旁路广播 |
| `usage/recorded` | emit | 每次模型调用的用量 |
| `session/appended` | emit | 会话日志追加 |
| `plugin/loaded` / `plugin/unloaded` / `plugin/failed` | emit | 宿主热加载 / 热卸载插件 |
| `plugin/notice` | emit | 插件**发出**的给用户看的一行提示 |

### 4.3 声明新的事件

插件新增的事件用 `ctx.define_event("id/action", EventDef::emit())` 声明分发模式。服务键用 camelCase；事件名用 `<插件 id>/<动作>`，避免与核心冲突。事件的分发模式是公共契约，发布后不得更改。

## 5. 工具协议

工具实现 [`Tool`]：

```rust
#[async_trait]
impl Tool for MyTool {
    fn name(&self) -> &str { "my_tool" }
    fn description(&self) -> &str { "写给模型看：做什么、何时用、返回什么。" }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"]})
    }
    fn permissions(&self) -> Option<Value> {
        Some(json!({"kind":"fs.write"}))
    }
    async fn execute(&self, args: Value, ctx: ToolContext) -> ToolResult {
        ToolResult::ok(/* ... */)
    }
}
```

官方插件额外要求：

- **命名**：`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`，snake_case。核心内置工具名（`read_file`、`write_file`、`edit_file`、`list_dir`、`grep`、`bash`、`web_fetch`）为保留名。
- **描述**：写给模型看。
- **参数**：JSON Schema，每个字段带 `description`。
- **权限**：有副作用的工具**必须**声明 `permissions`，新副作用类型加 `"sideEffect": true`，并写进 README。
- **取消**：遵守 `ToolContext::signal`。
- **失败**：业务失败返回 `ToolResult::error(...)`（`is_error = true`），不要 panic；panic 会被记为 `tool_error`。
- **输出**：控制长度，大输出截断并告知模型如何获取剩余部分。

## 6. 配置协议

用户在 `.leo/config.json` 中配置插件：

```jsonc
{
  "plugins": [
    "leo-plugin-sub-agents",                          // 使用默认配置
    ["leo-plugin-sub-agents", { "maxDepth": 1 }]     // 传入配置
  ]
}
```

- 插件配置**必须**用 `config_schema` 校验，错误要能指出具体字段。
- 通过 `.leo/plugins/` 自动发现的插件拿到的 config 是 `undefined`/`null`，插件**必须**能在无配置时以安全默认值运行。
- 配置中**不得**要求明文密钥。需要密钥时读取 `credentials` 服务，或接受 `$ENV` / `!command` 引用并用 `SecretResolver` 解析。
- 日志、错误信息、工具输出中**不得**出现密钥明文。

## 7. 热加载与配置文件

### 7.1 热加载

宿主监听 `~/.leo/` 与项目 `.leo/` 下的 `config.json`、`plugins/`，以及已加载插件 `watch` 声明的路径。变化时卸载旧实例、加载新实例；新实例失败时恢复旧实例。

为此插件**必须**：

1. **可完整撤销**：所有注册都通过 `ctx`（`provide`、`on`、`effect`、`register_tool`）。
2. **自己的资源自己交还**：子进程、网络连接、定时器、文件句柄放进 `ctx.effect(...)` 或监听 `ctx.signal()`。
3. **模块顶层无副作用**。
4. **数据文件写进 `watch`**：运行时读取的用户文件必须在 `apply` 里读取并声明在 `watch` 中。
5. **可以重复加载**：加载、卸载、再加载后的行为必须与首次加载一致；测试**必须**覆盖“卸载后注册被撤销、再次加载正常”。

### 7.2 配置文件模板（安装时自动初始化）

插件需要用户编辑的配置文件（如 mcp 的 `mcp-servers.json`）**必须**提供模板，并在 `leo-plugin.json` 的 `init.files` 中声明：

```jsonc
"init": {
  "files": [
    { "path": "mcp-servers.json", "template": "templates/mcp-servers.json", "description": "MCP 服务器列表" }
  ]
}
```

- `path` 相对 `.leo/`，不能越出 `.leo/`。模板放在插件的 `templates/` 目录。
- 模板**必须**开箱可用：不含密钥，示例默认注释掉，不启动任何外部进程。
- 模板路径**应当**同时出现在插件的 `watch` 中。

## 8. 安全基线

- 默认 fail closed：缺少审批服务、权限不明、配置不完整时拒绝执行，而不是放行。
- 不绕过核心工具管线：插件内部执行别的工具时**必须**通过 `tools` 服务的 `execute_batch`。
- 不扩大权限：插件创建的子 Agent、子任务**不得**拥有超过父 Agent 的工具与权限。
- 资源有上限：任何循环、递归、并发都**必须**有可配置的上限与合理默认值。

## 9. 插件清单 `leo-plugin.json`

每个插件目录**必须**包含 `leo-plugin.json`。字段规范见 [docs/manifest.md](docs/manifest.md)，JSON Schema 见 [schemas/leo-plugin.schema.json](schemas/leo-plugin.schema.json)。

## 10. 目录与文件约定

```text
plugins/<id>/
├── leo-plugin.json      插件清单（必须）
├── Cargo.toml           包名 = leo-plugin-<id>（必须）
├── README.md            用途、安装、配置、提供的能力、安全说明（必须）
├── CHANGELOG.md         版本记录
├── src/
│   ├── lib.rs           默认导出插件类型
│   └── main.rs          子进程入口
├── templates/           init.files 声明的配置文件模板
└── tests/
    └── *.rs             至少覆盖：加载、无配置运行、卸载后注册被撤销、再次加载正常
```

- `<id>` 用 kebab-case，与目录名、清单 `id`、crate 名后缀一致。
- 插件之间**不得**互相 import 源码；需要协作时通过服务契约。

## 11. 版本与兼容

- 插件遵循 semver。清单中的 `leo` 字段声明兼容的 leo-agents 版本范围。
- 改变工具名、参数、服务接口、事件载荷或配置字段语义属于破坏性变更，必须升主版本。

## 12. 合并检查清单

- [ ] 目录、清单 `id`、crate 名、插件 `name` 一致
- [ ] 依赖 `leo-plugin-sdk`，不依赖宿主或其他插件
- [ ] 无配置可运行，配置有 JSON Schema 校验
- [ ] 所有注册通过 `ctx`，副作用在 `ctx.effect` 中，可以热卸载、重复加载
- [ ] 运行时读取的数据文件声明在 `watch`；需要用户编辑的配置文件提供了 `init.files` 模板
- [ ] 有副作用的工具声明了 `permissions`，遵守 `signal`
- [ ] 不泄露密钥，不绕过工具管线，有资源上限
- [ ] README 写明安装、配置、提供的服务/事件/工具、安全说明
- [ ] `cargo test -p leo-plugin-<id>` 通过，`registry.json` 已重新生成