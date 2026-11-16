# leo-plugin-agent-team

> 状态：**experimental**（0.1.0）

一支常驻的 Agent 团队：**Leader（项目协调者）、产品经理、产品设计、技术负责人、全栈开发、QA**。你把需求交给团队，Leader 按阶段推进：

```
需求（PRD）→ 设计 + 技术方案（并行）→ 开发 → 测试（QA，不通过打回开发）→ 交付验收
        ▲ 关卡              ▲ 关卡                                         ▲ 关卡
```

每到一个关卡团队暂停，由 Leader 向你汇报并提问；你批准（`/team approve`）或驳回（`/team reject <原因>`）后团队继续。

> ⚠️ **成本提醒**：一个团队项目会运行 6 个 Agent、几十到上百次模型调用（QA 打回会再多几轮）。建议：
> - 给产品、设计、QA 等角色配便宜的模型（角色文件或配置里写 `model`），开发和技术负责人用强模型；
> - 保留默认关卡，在 PRD 和技术方案阶段就纠正方向，避免整轮返工；
> - 设置宿主的 `maxTurnCostUsd` / `maxTurnTokens` 预算，或调小 `maxBounces`、`memberMaxSteps`。

与 [sub-agents](../sub-agents) 的区别：sub-agents 的子 Agent 做完一次任务就销毁；团队成员是**常驻 Agent**，整个项目期间保留各自的会话、记得之前做过的工作，项目状态写在磁盘上，换个会话也能继续。两者可以同时安装。

## 安装

```bash
leo plugin add agent-team            # 全局安装，自动生成 ~/.leo/team/<角色>.md 六个角色文件
leo plugin add agent-team --project  # 只装到当前项目：.leo/plugins/ 与 .leo/team/
```

改配置时在 `config.json` 里显式引用安装好的文件：

```jsonc
// ~/.leo/config.json（全局安装，路径相对 ~/.leo）
{ "plugins": [["./plugins/agent-team.bundle.js", { "gates": { "design": false }, "roles": { "qa": { "model": "deepseek/deepseek-flash" } } }]] }
```

需要 leo-agents ≥ 0.1.2（`agentFactory`、热加载）；`/team` 命令需要 ≥ 0.2.1（`commands` 服务），旧宿主上命令不注册，其余功能正常。其他安装方式见 [docs/install.md](../../docs/install.md)。

## 怎么用

在对话里直接说：

> 让团队帮我做一个待办应用：可以添加、完成、删除待办，数据存在本地。

主 Agent 调用 `team_start`，Leader 开始工作。CLI 里能看到进度（`… [leader] team_assign pm`、`… [pm] team_deliver`）。PRD 写完后团队暂停，主 Agent 转告 Leader 的总结和问题。你可以：

- 直接回复（“可以，但加上登录”），主 Agent 用 `team_reply` 转达；
- 或用命令：`/team approve 范围可以`、`/team reject 还要支持多人协作`。

### 为什么入口放在主 Agent

Leader 是团队里**唯一和你沟通的角色**，但你的对话对象仍是主 Agent（CLI、网关里的那个 Agent）。插件给主 Agent 两个工具：

| 工具 | 作用 |
| --- | --- |
| `team_start` | 新建项目，把需求交给 Leader，运行到团队暂停（等审批）或结束，返回 Leader 的汇报 |
| `team_reply` | 把你的决定转给 Leader 并继续：`approve`（批准关卡）、`reject`（驳回，需原因）、`message`（其他消息 / 回答问题）、`continue`（继续中断或暂停后的项目） |

这样不改变宿主的对话模型：主 Agent 只是传话，Leader 的汇报原样作为工具结果返回；团队运行期间的进度通过 `tool_update` 显示；`/team approve` 之类的命令通过命令结果的 `prompt` 让主 Agent 调用 `team_reply` 继续（进度同样可见）。Leader 和成员是插件创建的独立 Agent，主 Agent 看不到也调不了团队内部工具。

## 角色

| id | 角色 | 负责阶段 | 默认产出物 | 默认工具（宿主工具部分） |
| --- | --- | --- | --- | --- |
| `leader` | 项目协调者 | —（规划、分派、跟踪、汇报，不写代码） | `delivery.md` | `read_file`、`list_dir`、`grep` |
| `pm` | 产品经理 | requirements | `prd.md`（范围 + 验收标准） | 只读 + `web_fetch` |
| `designer` | 产品设计 / 原型设计 | design | `design.md`，可附 `prototype.html` | 只读 + `web_fetch` |
| `tech-lead` | 技术负责人 | design | `tech-plan.md`（选型、结构、接口、任务拆分）；开发阶段可被指派评审代码 | 只读 + `web_fetch` |
| `dev` | 全栈开发 | development | `dev-notes.md` | 只读 + `write_file`、`edit_file`、`bash`、`web_fetch` |
| `qa` | 测试工程师 | qa | `test-report.md`，必须给出 `verdict: pass / fail` | 只读 |

- **只有开发默认能写文件和执行命令。** QA 默认只读：需要跑测试时用 `team_ask` 请开发执行并贴出结果。想让 QA 自己跑，在 `qa.md` 的 `tools` 里加 `bash`（仍按你的审批设置询问）。
- 团队工具由插件按角色自动加上：Leader 有 `team_assign`、`team_board`、`team_artifact`、`team_request_approval`；成员有 `team_deliver`、`team_ask`、`team_task_update`、`team_artifact`（只读）。
- v0.1 只有一名开发：同一成员同时只做一件事（任务排队），不会有两个 Agent 同时写文件。

### 自定义角色

角色 = 内置默认 < `~/.leo/team/<id>.md` < 项目 `.leo/team/<id>.md` < 配置 `roles`，**逐字段覆盖**。文件格式与 sub-agents 的 `.leo/agents/*.md` 相同，文件名就是角色 id：

```md
---
name: 测试工程师                # 显示名
description: 按验收标准测试      # 写进 Leader 的成员列表
model: deepseek/deepseek-flash   # 可选：这个角色单独用的模型
tools: read_file, list_dir, grep, bash
maxSteps: 30
phase: qa                        # 负责的阶段：requirements / design / development / qa / delivery
artifact: test-report.md         # team_deliver 正文保存的文件名
# disabled: true                 # 删除这个角色（leader 不能删）
---
正文是角色的系统提示（不写则保留上一层的提示）。插件会在末尾追加团队协作说明。
```

- **删除角色**：文件里写 `disabled: true`，或配置 `"roles": { "designer": false }`。没有负责角色的阶段自动跳过（例如删掉设计和技术负责人，就直接从 PRD 进入开发）。
- **新增角色**：新的 id 即新角色，例如 `security.md` 写 `phase: qa`，QA 阶段就需要它也交付才算完成；不写 `phase` 是辅助角色，Leader 可随时指派。
- **热加载**：修改六个内置角色的文件（`team/leader.md` … `team/qa.md`）后，运行中的 leo 自动重新加载插件；正在运行的团队会被取消（状态已保存，`/team resume` 继续），成员用新的提示 / 模型、沿用原会话。**新增**的自定义角色文件需要 `/plugins reload`，或写进配置 `roles`（改配置会自动重新加载）。插件没有监听整个 `team/` 目录，因为项目状态也写在 `team/projects/` 下，监听它会让每次写盘都重新加载插件。

## 工作流与关卡

| 阶段 | 完成条件 | 默认关卡 |
| --- | --- | --- |
| requirements | 负责该阶段的角色（pm）都用 `team_deliver` 交付 | ✅ `requirements` |
| design | designer 与 tech-lead 都交付（可并行） | ✅ `design` |
| development | dev 交付 | ❌ `development` |
| qa | qa 交付且 `verdict: pass`；`fail` 打回开发 | ❌ `qa` |
| delivery | Leader 写 `delivery.md` 并调用 `team_request_approval` | ✅ `acceptance`（最终验收） |

- 阶段完成由插件根据交付**自动判定**（不靠 Leader 自觉），`team_assign` 的结果会告诉 Leader 阶段变化。到了关卡，团队暂停，Leader 不能再指派任务，只能用 `team_request_approval` 给你写总结和问题。
- **批准**：进入下一阶段（验收关卡批准 = 项目完成）。**驳回**（必须写原因）：重做当前阶段；最终验收被驳回则回到开发。原因会转告 Leader。
- **QA 打回**：每次 `fail` 回到开发阶段，Leader 把测试报告里的问题交给开发修复后再测。打回 `maxBounces`（默认 3）次后再失败，团队暂停交给你：批准 = 按现状交付（在交付说明里写明遗留问题），驳回 = 再修一轮（计数清零）。
- Leader 也可以随时用 `team_request_approval` 问你问题；直接回复（`team_reply` 的 `message`）即可。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/team status [项目id]` | 当前项目的阶段、等待的关卡、任务看板、产出物 |
| `/team list` | 所有团队项目 |
| `/team approve [意见]` | 批准当前关卡，并让主 Agent 继续运行团队 |
| `/team reject <原因>` | 驳回当前关卡，团队返工 |
| `/team stop [项目id]` | 停止团队：取消正在运行的 Leader 与成员 |
| `/team resume [项目id]` | 继续一个暂停、中断（Ctrl-C、超时、重启）或已停止的项目 |

不写项目 id 时作用于“当前项目”：最近更新的未完成项目。

## 项目数据

每个项目一个目录，默认在项目 `.leo/team/projects/<projectId>/`（没有项目 `.leo` 时在 `~/.leo/team/projects/`，可用 `dataDir` 改）：

```text
<projectId>/
├── state.json    阶段、状态、等待的关卡、QA 打回次数、成员会话 id、事件记录
├── board.json    任务看板（T1、T2…：角色、阶段、状态、结论、产出物、备注）
└── artifacts/    prd.md、design.md、prototype.html、tech-plan.md、dev-notes.md、test-report.md、delivery.md…
```

成员的会话 id 固定为 `team-<projectId>-<role>`。宿主持久化会话时（CLI 默认写 `.leo/sessions/`），新会话里 `/team resume` 后成员仍然记得之前的对话。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `model` | string | — | 团队默认模型；不填用发起团队的 Agent 的模型，再不行用宿主默认模型 |
| `roles` | object | `{}` | 角色覆盖 / 新增；值为 `false` 删除 |
| `loadRoleFiles` | boolean | `true` | 读取 `~/.leo/team/*.md` 与 `.leo/team/*.md` |
| `gates` | object | `{ requirements: true, design: true, development: false, qa: false, acceptance: true }` | 人工关卡 |
| `maxBounces` | number | `3` | QA 打回开发的最多次数 |
| `maxAskDepth` | number | `2` | `team_ask` 嵌套深度（A 问 B 为 1 层） |
| `maxAskRounds` | number | `3` | 每个成员每次任务最多提问次数 |
| `maxConcurrent` | number | `2` | 同时运行的成员上限（设计与技术方案并行） |
| `leaderMaxSteps` / `memberMaxSteps` | number | `60` / `40` | 每次运行的最大步数（角色的 `maxSteps` 优先） |
| `memberTimeoutMs` | number | `900000` | 成员单次任务超时 |
| `timeoutMs` | number | `3600000` | Leader 一次运行（从开始到暂停）的超时 |
| `maxOutputChars` | number | `20000` | 返回给主 Agent / Leader 的单段文本上限 |
| `dataDir` | string | — | 项目数据目录（绝对路径） |
| `hideInternalTools` | boolean | `true` | 团队以外的 Agent 的模型请求里不出现团队内部工具 |

## 提供的能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 工具（主 Agent） | `team_start`、`team_reply` | 发起团队；转达用户的决定并继续 |
| 工具（Leader） | `team_assign`、`team_board`、`team_artifact`、`team_request_approval` | 指派并等待结果；查看 / 维护看板；读写产出物；暂停并请用户决定 |
| 工具（成员） | `team_deliver`、`team_ask`、`team_task_update`、`team_artifact`（只读） | 提交产出物（QA 带 verdict）；向其他成员提问；报告进展 / 受阻 |
| 命令 | `/team` | 见上 |
| 服务 | `agentTeam` | `roles()`、`start({ requirement, title?, parentAgentId?, signal?, onProgress? })`、`reply({ decision, text?, projectId?, … })`、`approve(id?, note?)`、`reject(id?, reason)`、`stop(id?)`、`list()`、`get(id?)`、`status(id?)`、`current()` |
| 事件 | `agent-team/phase-started` | emit `{ projectId, phase }` |
| 事件 | `agent-team/phase-finished` | emit `{ projectId, phase }` |
| 事件 | `agent-team/bounced` | emit `{ projectId, bounces, maxBounces, reason }`，QA 打回 |
| 事件 | `agent-team/awaiting-approval` | emit `{ projectId, phase, kind, gate, question }`，团队暂停等用户（网关可据此推送） |
| 事件 | `agent-team/finished` | emit `{ projectId, status: 'finished' \| 'stopped' }` |

进度：`team_start` / `team_reply` 运行期间，Leader 与成员每次调用工具都经 `tool_update` 上报 `{ type: 'progress', message: '[pm] team_deliver', projectId, role, tool }`。

## 安全边界

- **不扩大权限**：成员的宿主工具 = 发起团队的 Agent 的工具集 ∩ 角色 `tools`（项目里记下发起时的工具集，恢复时沿用）。这不只是隐藏 schema：leo-agents 在执行时按 Agent 的工具筛选拒绝，插件也在 `tools/pre-execute` 最前面和 `tools/guard` 中兜底，模型“猜”工具名也调不到，也不会为越权调用弹审批。
- **团队内部工具只给团队**：`team_assign`、`team_deliver` 等只有对应角色的团队 Agent 能调用，其他 Agent 调用一律拒绝；默认也不出现在其他 Agent 的模型请求里。
- **审批照常**：成员写文件、执行命令走同一条工具管线，审批、守卫、审计都生效；成员的 `label` 是 `agent-team:<角色>`，CLI 审批提示会显示是哪个角色要执行。
- **产出物只写进项目数据目录**：`team_deliver` / `team_artifact` 的文件名不能含路径（`[A-Za-z0-9._-]`，不允许 `..`），只写 `<projectId>/artifacts/`，因此不声明 `fs.write`、不弹审批。写项目代码只能通过开发的 `write_file` / `edit_file` / `bash`。
- **有上限**：并发成员数、每个角色的步数、成员 / Leader 超时、QA 打回次数、提问深度与次数都有限制。提问不能问回提问链上的成员（防止 A 等 B、B 等 A 的死锁），也不能问正忙的成员。
- **可取消**：主 Agent 的这一轮被取消（Ctrl-C）时 Leader 和正在工作的成员一起取消，项目保持可恢复；`/team stop` 停止项目；插件卸载 / 热重载时取消运行中的团队。
- 工具声明权限 `agent.spawn`（与 sub-agents 相同），CLI 默认审批策略不拦截它。

## 已知限制

- 只有一名开发；多开发并行改代码（分支 / 工作区隔离）留待以后。
- Leader 的每轮汇报经主 Agent 转告，措辞可能被主 Agent 概括；原文在工具结果的 `details.report`。
- 新增的自定义角色文件不会自动热加载（见上）。
- 角色模板装进 `.leo/team/` 后就是你的文件，插件升级不会覆盖；想用新版内置提示，删掉对应文件即可。
- 只用 mock 模型做过测试，没有用真实模型跑过完整项目；真实模型下 Leader 是否严格按阶段推进取决于模型能力（阶段完成和关卡由插件强制，Leader 跳不过去）。

## 源码结构

```text
src/
├── index.ts          插件入口：读角色、注册服务 / 工具 / 命令、工具权限守卫、隐藏内部工具
├── config.ts         zod 配置、阶段、关卡
├── builtin-roles.ts  六个内置角色（与 templates/team/*.md 一致）
├── roles.ts          解析 .leo/team/<role>.md，逐层合并角色
├── team.ts           引擎：项目状态机、成员 Agent、指派 / 提问 / 交付、审批、停止、恢复
├── tools.ts          团队工具
├── commands.ts       /team 命令
├── prompts.ts        Leader / 成员的团队说明与工具描述
└── store.ts          项目目录：state.json、board.json、artifacts/
```

## 开发

```bash
npm run build -w plugins/agent-team     # tsc + 单文件 bundle dist/agent-team.bundle.js
npm test -w plugins/agent-team          # mock 模型脚本化测试
```
