# 更新日志

## 0.1.0 — 2026-11-03

首个版本（实验性）：技能（Agent Skills，`SKILL.md`）管理与按需加载。参考 deer-flow 把内置技能与用户安装的技能分开管理，加载方式参考 pi 与 DeepSeek Harness。只用 leo-agents 已有接口，不改核心。

- 内置技能随插件发布，启动时释放到 `~/.leo/skills/.builtin/`，只读、升级时覆盖；目前内置 [skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)（Anthropic，Apache-2.0）
- 外部技能放 `~/.leo/skills/`（用户级）和 `<项目>/.leo/skills/`（项目级），插件启动时建好空目录；`skills.json` 的 `paths` 可加额外目录（如 `~/.claude/skills`）
- 同名优先级：项目 > paths > 用户 > 内置，用户可以用同名技能替换内置技能
- 渐进加载：系统提示只放名字和描述；模型用 `skill` 工具加载正文和技能目录，`file` 参数读技能里的参考文件（不能跳出技能目录）
- frontmatter 支持 `disable-model-invocation`（只能手动触发）与 `user-invocable: false`（只能模型加载）
- 命令（需要 leo-agents ≥ 0.2.1）：`/skill <名字> [任务]` 手动触发；`/skills` 列表；`/skills add <git 地址|本地路径> [技能名…] [--project] [--all] [--force]`；`/skills remove|enable|disable|info <名字>`。聊天渠道里默认只能看列表和触发，不能安装、删除、启停（`remoteManage`）
- 改了技能文件下一轮就生效，不用重启
