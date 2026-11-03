# leo-plugin-skills

**技能**（[Agent Skills](https://github.com/anthropics/skills)，`SKILL.md`）：一份针对某类任务的操作说明，可以带参考文档和脚本。本插件把**内置技能**和**用户安装的外部技能**分开管理，系统提示里只放目录，模型用到时再加载正文。

```bash
leo plugin add skills     # 生成 ~/.leo/skills.json 和 ~/.leo/skills/（空的外部技能目录）
leo                       # 输入 /skills 看看
```

只用 leo-agents 已有的接口（`context` 提示片段、`tools`、`commands`、`leoPaths`），不改核心。`/skill`、`/skills` 命令需要 leo-agents ≥ 0.2.1；更早的版本只有模型自动加载。

## 内置与外部分开（参考 deer-flow）

| 类别 | 位置 | 谁管 |
| --- | --- | --- |
| 内置 | `~/.leo/skills/.builtin/<名字>/` | 随插件发布，启动时释放；只读，插件升级时整个覆盖 |
| 外部 · 项目级 | `<项目>/.leo/skills/<名字>/` | 你装的，只在这个项目可用 |
| 外部 · 额外目录 | `skills.json` 的 `paths`，如 `~/.claude/skills` | 你自己的目录，插件只读 |
| 外部 · 用户级 | `~/.leo/skills/<名字>/` | 你装的，所有项目可用 |

- 插件启动时建好 `~/.leo/skills/`（和项目已有 `.leo` 时的 `.leo/skills/`），一开始是空的，之后按自己的需要安装技能
- 同名时上面的赢：**项目 > 额外目录 > 用户 > 内置**。想改内置技能，把它复制到 `~/.leo/skills/<同名>/` 再改
- 内置技能目前只有 [skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)（Anthropic 为 Claude Code 写的「创建技能的技能」，Apache-2.0，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）。不想要：`/skills disable skill-creator`，或 `"builtin": false` 关掉全部内置技能

## 按需加载（参考 pi 与 DeepSeek Harness）

1. 系统提示里只有目录：每个技能的名字和描述（`<available_skills>`），不放正文、不放路径
2. 任务对得上某个描述时，模型调用 `skill` 工具（`name`）拿到完整说明、技能目录的绝对路径和里面的文件清单
3. 说明里提到的参考文件，模型再用 `skill`（`name` + `file`）读；读不到技能目录以外的文件。脚本用 bash 按绝对路径运行（照常经过审批策略）
4. 你也可以手动触发：`/skill <名字> [任务]`，说明直接交给 Agent，接着做你写的任务

改了 `SKILL.md`、装了或删了技能，下一轮对话就生效，不用重启。

`SKILL.md` 的 frontmatter：

| 字段 | 说明 |
| --- | --- |
| `name` | 必需。小写字母、数字、连字符，最长 64；不写就用目录名 |
| `description` | 必需。做什么、什么时候用——模型靠它决定要不要加载 |
| `disable-model-invocation: true` | 不进目录，模型不能自己加载，只能 `/skill` 手动触发 |
| `user-invocable: false` | 只能模型加载，不能 `/skill` 手动触发 |
| `license` | 可选，`/skills info` 里显示 |

其他字段（`allowed-tools`、`metadata` 等）忽略，不影响加载。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/skills` | 列出技能、来源（内置 / 用户 / 项目）、禁用状态、被覆盖的同名技能和格式错误 |
| `/skills add <来源> [技能名…] [--project] [--all] [--force]` | 安装到 `~/.leo/skills/`（`--project` 装到项目）。来源可以是本地目录、git 仓库，或 GitHub 子目录，如 `https://github.com/anthropics/skills/tree/main/skills/pdf`。来源里有多个技能时要写技能名或 `--all` |
| `/skills remove <名字> [--project]` | 删除外部技能；内置技能不能删 |
| `/skills disable <名字>` / `enable <名字>` | 写进 `skills.json` 的 `disabled`（`--project` 写项目级） |
| `/skills info <名字>` | 来源、目录、许可、文件 |
| `/skill <名字> [任务]` | 手动触发 |

在聊天渠道（QQ、飞书、Telegram）里默认只能看列表和 `/skill` 触发；安装、删除、启停只能在终端里做，除非 `skills.json` 里设 `"remoteManage": true`。

## 配置 `skills.json`

`~/.leo/skills.json`（项目里的 `.leo/skills.json` 覆盖它；`disabled`、`paths` 两级合并），改完自动生效：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `builtin` | `true` | 启用内置技能 |
| `disabled` | `[]` | 禁用的技能名 |
| `paths` | `[]` | 额外的技能目录，相对路径按项目根解析，支持 `~` |
| `maxDescriptionChars` | `500` | 目录里每条描述最多多少字 |
| `remoteManage` | `false` | 允许在聊天渠道里安装、删除、启停技能 |

## 服务

插件提供 `skills` 服务（`ctx.get('skills')`）：`snapshot()` 返回生效的技能、被覆盖的技能和格式错误，`find(name)` 按名字找，`dirs` 是用户、项目、内置三个目录。

## 开发

内置技能的源文件在 `builtin/<名字>/`。插件发布成单个 JS 文件，所以 `npm run build` 先运行 `scripts/gen-builtin.mjs`，把它们打包进 `src/builtin.generated.ts`；只支持文本文件。加新的内置技能：放进 `builtin/`，重新构建。
