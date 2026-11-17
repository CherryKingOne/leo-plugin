# leo-plugin

[leo-agents](https://github.com/CherryKingOne/leo-agents) 官方插件仓库。**一个插件一个目录**，每个插件是一个独立的 Rust crate（包名 `leo-plugin-<id>`）。

> 本仓库已从 TypeScript 完整重写为 Rust：不再包含任何 `.ts` / `package.json`，插件实现位于各 `plugins/<id>/src/*.rs`，共享运行时位于 `crates/leo-plugin-sdk`。目录结构保持不变。

各插件版本与 leo-agents 版本的对应关系、发布时间和更新说明见 [COMPATIBILITY.md](COMPATIBILITY.md)。Rust 插件开发协议见 [PROTOCOL.md](PROTOCOL.md) 与 [docs/rust-plugin.md](docs/rust-plugin.md)。

## 插件列表

| 插件 | Crate | 状态 | 说明 |
| --- | --- | --- | --- |
| [mcp](plugins/mcp) | `leo-plugin-mcp` | 实验性 0.1.1 | 接入外部 MCP 服务器的工具（stdio / HTTP），兼容 MCP 2026-07-28（MCP 2.0）与旧版握手协议 |
| [sub-agents](plugins/sub-agents) | `leo-plugin-sub-agents` | 实验性 0.1.1 | 把任务委派给独立上下文的子 Agent 执行并汇总结果 |
| [gateway](plugins/gateway) | `leo-plugin-gateway` | 实验性 0.3.1 | 消息网关（注册层）：接入 Telegram / 飞书 / QQ，按会话路由给 Agent，授权配对、聊天内审批、主动投递，表情 / 图片消息与插件命令，HTTP / WebSocket / OpenAI 兼容控制面 |
| [gateway-qq](plugins/gateway-qq) | `leo-plugin-gateway-qq` | 实验性 0.3.1 | 网关的 QQ 子插件：QQ 官方机器人驱动，手机 QQ 扫码绑定，顶替网关内置 QQ 驱动 |
| [gateway-feishu](plugins/gateway-feishu) | `leo-plugin-gateway-feishu` | 实验性 0.3.0 | 网关的飞书子插件：飞书扫码一键创建应用，扫码人自动成为管理员，顶替网关内置飞书驱动 |
| [provider](plugins/provider) | `leo-plugin-provider` | 实验性 0.3.1 | 模型供应商注册层：子插件注册驱动，统一读配置、取密钥、接入 Agent；自带通用 OpenAI 兼容协议 |
| [provider-deepseek](plugins/provider-deepseek) | `leo-plugin-provider-deepseek` | 实验性 0.3.0 | 模型供应商的 DeepSeek 子插件：deepseek-flash / deepseek-v4-pro，思考模式与工具调用，旧模型名自动改写 |
| [provider-longcat](plugins/provider-longcat) | `leo-plugin-provider-longcat` | 实验性 0.1.0 | 模型供应商的 LongCat（美团）子插件：LongCat-2.5-Preview，思考模式与工具调用，推理强度换算成思考预算 |
| [provider-spark](plugins/provider-spark) | `leo-plugin-provider-spark` | 实验性 0.1.0 | 模型供应商的讯飞星火子插件：Spark-X2.6 / X2.5 系列，思考模式 enabled / disabled / auto 与工具调用 |
| [interaction](plugins/interaction) | `leo-plugin-interaction` | 实验性 0.1.1 | 互动层（注册层）：人设与表情包由子插件注册，Agent 按对话语境用 send_sticker 自动发表情；/persona、/sticker、/stickers |
| [interaction-persona-whale](plugins/interaction-persona-whale) | `leo-plugin-interaction-persona-whale` | 实验性 0.1.0 | 互动层的人设子插件：鲸鱼娘·大肥鱼（移植自 dsh-whale-musume-persona） |
| [interaction-stickers-whale](plugins/interaction-stickers-whale) | `leo-plugin-interaction-stickers-whale` | 实验性 0.1.0 | 互动层的表情包子插件：鲸鱼娘表情 24 张 × 蓝 / 黑两套角色（移植自 dsh-stickers） |
| [speakup](plugins/speakup) | `leo-plugin-speakup` | 实验性 0.1.1 | 主动搭话：对方一阵子没来找时，Agent 在私聊里主动找对方说几句，经网关作为主动消息发出 |
| [skills](plugins/skills) | `leo-plugin-skills` | 实验性 0.1.0 | 技能（SKILL.md）：内置技能与用户安装的外部技能分开管理；系统提示只放目录，`skill` 工具按需加载 |
| [agent-team](plugins/agent-team) | `leo-plugin-agent-team` | 实验性 0.1.0 | Agent 团队：Leader、产品经理、产品设计、技术负责人、全栈开发、QA 组成常驻团队，按 PRD → 设计 + 技术方案 → 开发 → 测试 → 交付推进 |
| [trajectory](plugins/trajectory) | `leo-plugin-trajectory` | 实验性 0.1.0 | 轨迹观测：会话 → turn → 模型调用 → 工具 → 子会话的树，本机网页实时查看耗时、TTFT、用量、重试与错误 |
| [context](plugins/context) | `leo-plugin-context` | 实验性 0.1.0 | 上下文观测：每次请求的上下文组成、离窗口和自动压缩多远、跨会话用量 / 成本与工具洞察。独立本机网页（18792）+ `/context` |

机器可读的索引见 [`registry.json`](registry.json)（由 `cargo run -p leo-plugin-xtask -- gen-registry` 生成）。

## 工作区结构

```text
leo-plugin/
├── Cargo.toml                 工作区根（members = crates/* + plugins/*）
├── Cargo.lock
├── rust-toolchain.toml
├── PROTOCOL.md                Rust 插件开发协议
├── README.md                  本文件
├── COMPATIBILITY.md           版本兼容表
├── docs/
│   ├── rust-plugin.md         Rust 插件开发指南（SDK 契约）
│   ├── install.md             构建与安装
│   └── manifest.md            leo-plugin.json 清单规范
├── schemas/                   清单 / 索引 JSON Schema
├── crates/
│   ├── leo-plugin-sdk/        共享运行时：Plugin / Context / Tool / 事件 / 服务契约
│   ├── leo-plugin-host/       以子进程方式加载插件并派发工具调用的宿主
│   └── leo-plugin-xtask/      仓库任务：生成 registry.json、校验清单
└── plugins/
    ├── _template/             新插件模板（可运行的最小示例）
    ├── mcp/  sub-agents/  gateway/  gateway-qq/  gateway-feishu/
    ├── provider/  provider-deepseek/  provider-longcat/  provider-spark/
    ├── interaction/  interaction-persona-whale/  interaction-stickers-whale/
    ├── skills/  speakup/  agent-team/  trajectory/  context/
```

## 构建与测试

```bash
cargo build --workspace
cargo test --workspace
cargo run -p leo-plugin-xtask -- gen-registry   # 重新生成 registry.json
cargo run -p leo-plugin-xtask -- validate       # 校验清单一致性
```

单个插件：

```bash
cargo check -p leo-plugin-mcp
cargo test  -p leo-plugin-mcp
```

## 运行插件

每个插件 crate 都带一个二进制入口（`src/main.rs`），使用换行分隔的 JSON-RPC 协议在 stdio 上通信：

```bash
cargo build -p leo-plugin-template
echo '{"id":1,"method":"apply","params":{"config":{}}}' | ./target/debug/leo-plugin-template
```

宿主 `leo-plugin-host` 可以启动插件、发送 `apply`、列出并调用工具：

```bash
cargo run -p leo-plugin-host -- ./target/debug/leo-plugin-template
cargo run -p leo-plugin-host -- ./target/debug/leo-plugin-template --tool template_echo '{"text":"hi"}'
```

插件也可以在进程内直接使用（测试、嵌入宿主）：

```rust
let ctx = leo_plugin_sdk::Context::root(std::sync::Arc::new(leo_plugin_sdk::NullLogger));
ctx.ensure_basic_tools();
plugin.apply(ctx.clone(), serde_json::Value::Null).await?;
```

## 开发插件

1. 阅读 [PROTOCOL.md](PROTOCOL.md) 与 [docs/rust-plugin.md](docs/rust-plugin.md)：插件契约、Context API、工具与服务规则、安全基线。
2. 复制模板：`cp -r plugins/_template plugins/<id>`，按协议改名（目录、`Cargo.toml`、`leo-plugin.json`、`Plugin::name`）。
3. 写好 `leo-plugin.json`（规范见 [docs/manifest.md](docs/manifest.md)）。
4. `cargo test -p leo-plugin-<id>`。

## 目录结构约定

```text
plugins/<id>/
├── leo-plugin.json      插件清单（必须）
├── Cargo.toml           包名 = leo-plugin-<id>（必须）
├── README.md            用途、安装、配置、提供的能力、安全说明（必须）
├── CHANGELOG.md         版本记录
├── src/
│   ├── lib.rs           Plugin / Tool 实现
│   └── main.rs          子进程入口（runtime::serve）
├── templates/           安装时自动初始化的配置文件模板
└── tests/               集成测试：加载、无配置运行、卸载撤销、再次加载
```

插件之间**不得**互相 import 源码；需要协作时通过 `crates/leo-plugin-sdk` 中的服务契约（`ProvidersService`、`GatewayService`、`InteractionService`、`ToolsService` 等）交换句柄。

## License

Apache-2.0