# 更新日志

## 0.1.1 — 2026-11-02

- 表情提示词明确：发表情必须调用 `send_sticker`，只在文字里写「（发送了一张……表情）」用户看不到。修复部分模型（如 spark-x2.6）在聊天渠道只描述不调用、表情发不出去的问题

## 0.1.0 — 2026-11-02

首个版本（实验性）：互动层注册层。

- 服务 `interaction`：子插件注册人设（`registerPersona`）与表情包（`registerStickerPack`），卸载时自动撤销
- 人设：当前人设作为 agent 层系统提示词片段注入，支持 `{{model}}` / `{{cwd}}` / `{{date}}`；`persona` 为 `auto`（第一个安装的人设）/ 人设 id / `off`
- 表情：`send_sticker` 工具 + 表情提示词，Agent 按对话语境自动发；每轮上限、彩蛋开关、默认角色；工具结果带 `display`（终端字符画 + 图片地址），不进模型上下文
- 命令：`/persona`（切换并写回 interaction.json，保留注释）、`/sticker`、`/stickers`（需要 leo-agents 的 commands 服务）
- 配置 `interaction.json`（JSONC，用户级 + 项目级 + 插件选项），安装时生成模板，修改后热加载
