# 版本对照表

leo-agents（底座）与 leo-plugin（插件）各自发版。这张表回答两个问题：

- 我装的是某个 leo-agents 版本，该装哪些插件、哪个版本？
- 某个插件的某个版本，什么时候发的、改了什么、需要什么？

> 维护约定：每次发布插件（`cargo run -p leo-plugin-xtask -- release <id> --push`）或 leo-agents 打 tag 后，同步更新本文件对应的行。时间为北京时间（UTC+8）。
>
> 本仓库已从 TypeScript 重写为 Rust：插件以 crate 形式提供，表格中的“插件版本”与 `leo-plugin.json` 的 `version` 保持一致。

## 一、快速对照：leo-agents 版本 → 可用插件

| leo-agents | 发布时间 | 可用插件（推荐版本） | 不可用 / 受限 | 备注 |
| --- | --- | --- | --- | --- |
| [0.2.3](https://github.com/CherryKingOne/leo-agents/releases/tag/0.2.3) | 2026-11-17 | 同 0.2.2，另加 context 0.1.0（精确组成） | — | 只新增：`llm/request.breakdown`（System 片段与来源插件、每个工具定义、消息、窗口与预留）、`PromptSection.owner` |
| [0.2.2](https://github.com/CherryKingOne/leo-agents/releases/tag/0.2.2) | 2026-11-17 | 同 0.2.1，另加 trajectory 0.1.0（完整计时） | — | 只新增：会话日志 `tool/start` / `tool/end`、`llm/response.startedAt/firstTokenAt`（TTFT）、`session/meta`（`AgentOptions.sessionMeta`）、`SessionStore.list()` |
| [0.2.1](https://github.com/CherryKingOne/leo-agents/releases/tag/0.2.1) | 2026-11-02 | 同 0.2.0，推荐 gateway 0.3.1、gateway-qq 0.3.1、gateway-feishu 0.3.0、interaction 0.1.1、interaction-persona-whale 0.1.0、interaction-stickers-whale 0.1.0、speakup 0.1.1、skills 0.1.0、trajectory 0.1.0 | trajectory 的工具开始时间、历史 TTFT、日志里的父子关系（需要 0.2.2） | 新增 `commands` 服务（插件斜杠命令）与展示块 `display`：interaction 的 `/persona`、`/sticker`、`/stickers` 与终端画表情、网关转发插件命令从这版开始可用 |
| [0.2.0](https://github.com/CherryKingOne/leo-agents/releases/tag/0.2.0) | 2026-10-31 | provider 0.3.1、provider-deepseek 0.3.0、provider-longcat 0.1.0、provider-spark 0.1.0、gateway 0.3.1、gateway-qq 0.3.1、gateway-feishu 0.3.0、interaction 0.1.1、interaction-persona-whale 0.1.0、interaction-stickers-whale 0.1.0、mcp 0.1.1、sub-agents 0.1.1 | interaction 的斜杠命令与终端画表情、网关转发插件命令（需要 0.2.1） | **破坏性变更**：底座不再内置模型厂商，必须装 `provider` 加至少一个厂商子插件（deepseek / longcat / spark）才能对话 |
| 0.1.2 | 2026-10-31 | gateway 0.2.3、gateway-qq 0.2.2、gateway-feishu 0.2.3、mcp 0.1.1、sub-agents 0.1.1 | provider 全系列（要求 ≥ 0.2.0） | 模型厂商仍内置在底座（`.leo/config.json` 的 `providers`）；`leo serve` / `agentFactory` / `plugin/notice` / `remove --purge` 从这版开始，网关常驻运行需要它 |
| 0.1.1 | 2026-10-31 | mcp 0.1.1、sub-agents 0.1.1、gateway 0.1.1 ~ 0.2.3（仅交互式 `leo` 中运行） | provider 全系列；gateway-qq 扫码后的 `--purge` 重扫 | 新增 `leo plugin add/remove`、安装即初始化配置模板、修改配置热加载 |
| 0.1.0 | 2026-10-30 | mcp 0.1.0、sub-agents 0.1.0（手动写进 `config.json` 的 `plugins`） | provider 全系列；`leo plugin add` 一键安装；热加载 | 首个版本：插件内核、Agent Loop、内置 OpenAI 兼容 Provider、`leo` 命令行 |

## 二、leo-agents 版本说明

| 版本 | 发布时间 | 提交 | 更新说明 |
| --- | --- | --- | --- |
| 0.2.0 | 2026-10-31 | `044f472` | 模型供应商插件化（移除内置厂商预设与 OpenAI 兼容实现，改由 leo-plugin 的 provider 系列提供）；真实模型列表 `leo models`；思考模式与推理强度（`--thinking`、`--effort`、`/think`、`/effort`、`/models`、`/model`）；`llm/selected`、`plugin/data-written` 事件 |
| 0.1.2 | 2026-10-31 | `d91e040` | `leo serve` 后台常驻；`agentFactory` 服务；`plugin/notice` 事件；`leo plugin remove --purge` 按 `purge.credentials` 清理凭据 |
| 0.1.1 | 2026-10-31 | `4af5b68` | 插件安装与管理（`leo plugin add/remove/list`，从 registry 下载单文件版本）；安装即生成配置模板；插件声明 `watch` 后改配置自动热加载 |
| 0.1.0 | 2026-10-30 | `78cf43f` | 首个版本：插件内核、通用 Agent Loop、OpenAI 兼容 Provider、`.leo` 配置与 `leo` 命令行 |

## 三、插件版本明细

“需要”一列：清单 `leo` 字段写的是最低声明；括号里是实际用到全部功能所需的版本。所有版本的单文件 bundle 都已上传到 `bundles` 分支，`leo plugin add <id>` 默认装最新版。

### 模型供应商（leo-agents ≥ 0.2.0）

#### provider：模型供应商注册层

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.3.1 | 2026-10-31 | leo-agents ≥ 0.2.0 | 识别顶层 `{ code, message }` 业务错误（讯飞星火等），流里非 0 `code` 会报错；驱动新增 `errorCodes`（厂商错误码 → 是否重试）；中文上下文超限识别 |
| 0.3.0 | 2026-10-31 | leo-agents ≥ 0.2.0（切换写回需要 `044f472` 起的 `llm/selected`） | provider.json 跟着用的东西走：安装子插件自动填充默认条目，`/model`、`/think`、`/effort` 切换写回；保留 JSONC 注释与排版 |
| 0.2.0 | 2026-10-31 | leo-agents ≥ 0.2.0 | 实时模型列表 `GET /models`；`fetchModels`、`mapModel`；统一 `request.reasoning` 交给驱动翻译 |
| 0.1.0 | 2026-10-31 | leo-agents ≥ 0.2.0 | 首个版本：`providers` 服务（子插件注册驱动 / 协议），内置 `openai-compatible` 协议，任意兼容端点写 `baseURL` 即可 |

#### provider-deepseek：DeepSeek

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.3.0 | 2026-10-31 | provider ≥ 0.2.0（自动填充 provider.json 需要 ≥ 0.3.0） | 提供 provider.json 默认条目：`deepseek-flash`、思考开、`reasoningEffort: high`，切换后同步 |
| 0.2.0 | 2026-10-31 | provider ≥ 0.2.0 | 对照官方文档：实时模型列表，修正上下文 1048576 / 最大输出 393216，推理强度档位 |
| 0.1.0 | 2026-10-31 | provider ≥ 0.1.0 | 首个版本：驱动 `deepseek`，模型 `deepseek-flash` / `deepseek-v4-pro`，思考+工具时回传 `reasoning_content` |

#### provider-longcat：LongCat（美团）

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-10-31 | provider ≥ 0.2.0（自动填充需要 ≥ 0.3.0） | 首个版本：LongCat-2.5-Preview（1M 上下文），思考模式与工具调用，推理强度换算成思考预算（low 8192 ~ max 262144） |

#### provider-spark：讯飞星火

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-10-31 | provider ≥ 0.2.0（自动填充需要 ≥ 0.3.0，错误码分类需要 ≥ 0.3.1） | 首个版本：只内置讯飞自研的 spark-x2.6 / x2.6-4b / x2.6-preview / x2.5 / x2.5-4b / x2.5-1.7b；`thinking` enabled / disabled / auto；可选内置联网搜索；错误码速查表映射 |

### 消息网关

#### gateway：消息网关注册层

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.3.1 | 2026-11-02 | 同 0.3.0 | 内置 QQ 驱动发图改为本机下载后二进制直传，修复平台拉图超时（850027） |
| 0.3.0 | 2026-11-02 | leo-agents ≥ 0.1.0（常驻运行需要 0.1.2；转发插件命令需要 0.2.1） | 图片消息（Telegram / QQ / 飞书），Agent 发的表情发到聊天里，转发插件斜杠命令，`sendImage` |
| 0.2.3 | 2026-10-31 | leo-agents ≥ 0.1.0（常驻运行需要 0.1.2） | 飞书默认由子插件 gateway-feishu 提供，`builtin` 默认只留 telegram；缺飞书驱动时提示安装 |
| 0.2.2 | 2026-10-31 | 同上 | 驱动可直接授权用户（`authorize`），`/whoami` 区分管理员与已授权 |
| 0.2.1 | 2026-10-31 | 同上 | 配置模板按注册层用法重写（QQ 交给 gateway-qq 扫码）；缺驱动提示更具体，3 秒宽限期 |
| 0.2.0 | 2026-10-31 | 同上 | 网关改为注册层：插件驱动可顶替同 id 的内置驱动，卸载后自动恢复 |
| 0.1.1 | 2026-10-31 | 同上（提示输出需要 0.1.2 的 `plugin/notice`） | 启动时显示控制面与接口地址；渠道连接状态逐行提示 |
| 0.1.0 | 2026-10-31 | leo-agents ≥ 0.1.0 | 首个版本：Telegram、飞书 / Lark、QQ 官方机器人；每个聊天一个 leo 会话；授权、审批、控制面 |

#### gateway-qq：QQ 渠道（扫码绑定）

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.3.1 | 2026-11-02 | gateway ≥ 0.2.0（发图片需要 ≥ 0.3.0） | 发图改为本机下载后二进制直传（5MB 内），失败再退回 URL 上传，修复平台拉图超时（850027） |
| 0.3.0 | 2026-11-02 | gateway ≥ 0.2.0（发图片需要 ≥ 0.3.0） | 图片消息：单聊 / 群上传富媒体后发送，频道发图片地址 |
| 0.2.2 | 2026-10-31 | gateway ≥ 0.2.0（扫码人自动成为管理员需要 ≥ 0.2.2） | 扫码的 QQ 号自动成为网关管理员（`authorizeScanner`，默认开） |
| 0.2.1 | 2026-10-31 | gateway ≥ 0.2.0 | `qrConsole` 默认 `auto`：`leo serve` 下终端直接打印二维码 |
| 0.2.0 | 2026-10-31 | gateway ≥ 0.2.0（`--purge` 重扫需要 leo-agents 0.1.2） | 首个版本：QQ 官方机器人驱动，手机 QQ 扫码绑定，安装后顶替内置 `qq` 驱动 |

#### gateway-feishu：飞书 / Lark 渠道（扫码创建应用）

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.3.0 | 2026-11-02 | gateway ≥ 0.2.0（发图片需要 ≥ 0.3.0） | 图片消息：上传拿 image_key 后发送，按地址缓存 |
| 0.2.3 | 2026-10-31 | gateway ≥ 0.2.0（扫码人自动成为管理员需要 ≥ 0.2.2） | 首个版本：飞书 / Lark 驱动（长连接或 webhook），扫码一键创建智能体应用，安装后顶替内置驱动 |

### 工具扩展

#### mcp：MCP 服务器工具

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.1.1 | 2026-10-31 | leo-agents ≥ 0.1.0（热加载、自动初始化需要 0.1.1） | 修改 `mcp-servers.json` 自动重连；安装时自动生成配置模板 |
| 0.1.0 | 2026-10-31 | leo-agents ≥ 0.1.0 | 首个版本：MCP 工具注册为 `mcp__<server>__<tool>`，配置兼容 Claude / Cursor 的 `mcpServers` 格式 |

#### sub-agents：子 Agent

| 版本 | 发布时间 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| 0.1.1 | 2026-10-31 | leo-agents ≥ 0.1.0（热加载、自动初始化需要 0.1.1） | 新增或修改 `agents/*.md` 自动生效；安装时自动生成示例 |
| 0.1.0 | 2026-10-31 | leo-agents ≥ 0.1.0 | 首个版本：`task` 工具、`subAgents` 服务、`agents/*.md` 定义子 Agent |

### 互动层（2026-11-02 发布）

| 插件 | 版本 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| interaction | 0.1.1 | 同 0.1.0 | 表情提示词要求必须调用 `send_sticker`，修复部分模型只写「（发送了一张……）」不调用工具 |
| interaction | 0.1.0 | leo-agents ≥ 0.2.0（斜杠命令与终端画表情需要 0.2.1） | 首个版本：人设与表情包注册层，`send_sticker` 让 Agent 按语境自动发表情，`/persona`、`/sticker`、`/stickers` |
| interaction-persona-whale | 0.1.0 | interaction ≥ 0.1.0 | 首个版本：鲸鱼娘·大肥鱼人设（移植自 dsh-whale-musume-persona，MIT） |
| interaction-stickers-whale | 0.1.0 | interaction ≥ 0.1.0 | 首个版本：鲸鱼娘表情 24 张 × 蓝 / 黑角色，终端字符画 + 图片（移植自 dsh-stickers，BSD-3-Clause） |

### 主动搭话（2026-11-02 发布）

| 插件 | 版本 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| speakup | 0.1.1 | 同 0.1.0 | 默认更积极：空闲 60 分钟、间隔 30 ~ 120 分钟、每天最多 10 次（原 120 分钟、90 ~ 240 分钟、3 次） |
| speakup | 0.1.0 | leo-agents ≥ 0.1.2、gateway ≥ 0.3.0（`/speakup` 命令需要 leo-agents ≥ 0.2.1） | 首个版本：对方一阵子没来找时 Agent 主动在私聊里找对方说话，问了话没回会追一句；清醒时段、空闲时长、每天次数、时区可配；不改网关与渠道驱动 |

### 技能（2026-11-03 发布）

| 插件 | 版本 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| skills | 0.1.0 | leo-agents ≥ 0.1.2（`/skill`、`/skills` 命令需要 leo-agents ≥ 0.2.1） | 首个版本：内置技能（skill-creator）释放到 `~/.leo/skills/.builtin/`，外部技能放 `~/.leo/skills/` 与项目 `.leo/skills/`；系统提示只放目录，`skill` 工具按需加载；`/skills add` 从 git 或本地安装；不改核心 |

### Agent 团队（2026-11-17 发布）

| 插件 | 版本 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| agent-team | 0.1.0 | leo-agents ≥ 0.1.2（`/team` 命令需要 ≥ 0.2.1） | 首个版本：常驻团队（Leader、产品经理、产品设计、技术负责人、全栈开发、QA），PRD → 设计 + 技术方案 → 开发 → QA（打回）→ 交付，人工关卡 `/team approve` / `/team reject`，项目状态持久化可恢复；不改核心 |

### 轨迹观测（2026-11-17 发布）

| 插件 | 版本 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| trajectory | 0.1.0 | leo-agents ≥ 0.2.1（完整计时需要 leo-agents ≥ 0.2.2） | 首个版本：会话日志只读投影成 turn → step → 工具 → 子会话的树；本机网页（账本、时间线、详情、SSE 实时跟随）与 JSON API，默认 `http://127.0.0.1:18791/`，非本机地址必须设令牌；`/trace`、`/trace open`、`/trace export`、`/trace list`；服务 `trajectory`；不注册工具。0.2.1 上：step 耗时取事件时间、工具耗时取结果自报值（开始时间推算）、TTFT 只有运行期间现场测得、子会话靠 sub-agents 结果与 agent-team 会话命名挂上；0.2.2 上直接用 `tool/start` / `tool/end`、`firstTokenAt`、`session/meta`、`sessions.list()` |

### 上下文观测（2026-11-17 发布）

| 插件 | 版本 | 需要 | 更新说明 |
| --- | --- | --- | --- |
| context | 0.1.0 | leo-agents ≥ 0.2.1（精确的 System 片段、插件注入来源、工具定义与窗口需要 leo-agents ≥ 0.2.3） | 首个版本，参考 dsh-context：每次请求的上下文组成、当前占用与离自动压缩多远、逐请求趋势、上下文事件、上下文浏览器、用量 / 成本 / 耗时、工具 / 文件 / 命令 / 技能；跨会话洞察；独立网页 `http://127.0.0.1:18792/`（与 trajectory 分开），非本机地址必须设令牌；`/context`；服务 `contextInsight`；不注册工具。0.2.3 以前按同口径推算并标出 |

## 四、插件依赖关系

```
leo-agents
├── provider ─┬─ provider-deepseek
│             ├─ provider-longcat
│             └─ provider-spark
├── gateway ──┬─ gateway-qq
│             ├─ gateway-feishu
│             └─ speakup（只用网关的接口，与渠道无关）
├── interaction ┬─ interaction-persona-whale
│               └─ interaction-stickers-whale
├── skills（只用核心接口，与其他插件无关）
├── mcp
├── sub-agents
├── agent-team（只用核心接口，与 sub-agents 并存）
├── trajectory（只读核心会话日志；认得 sub-agents、agent-team 的子会话，但不依赖它们）
└── context（只读核心会话日志；与 trajectory 互不依赖，各用各的端口）
```

子插件不会自动装上注册层，需要先装：`leo plugin add provider && leo plugin add provider-spark`。
