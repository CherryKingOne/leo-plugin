# Changelog

## 0.1.0（未发布）

首个版本。

- 常驻 Agent 团队：Leader（项目协调者）、产品经理、产品设计、技术负责人、全栈开发、QA；成员整个项目期间保留会话
- 工作流：需求（PRD）→ 设计 + 技术方案（并行）→ 开发 → 测试（不通过打回开发，`maxBounces` 默认 3）→ 交付验收；阶段完成由插件根据交付自动判定
- 人工关卡（默认 PRD 后、设计与技术方案后、最终验收）：`/team approve [意见]`、`/team reject <原因>`，或在对话里直接回复
- 主 Agent 工具 `team_start`、`team_reply`；Leader 工具 `team_assign`、`team_board`、`team_artifact`、`team_request_approval`；成员工具 `team_deliver`、`team_ask`、`team_task_update`
- `/team status|list|approve|reject|stop|resume`（leo-agents ≥ 0.2.1）
- 服务 `agentTeam`；事件 `agent-team/phase-started`、`phase-finished`、`bounced`、`awaiting-approval`、`finished`
- 角色：内置默认 < `~/.leo/team/<role>.md` < `.leo/team/<role>.md` < 配置 `roles`，逐字段覆盖；可增删角色、每个角色单独指定模型；安装时生成六个角色模板，修改后热加载
- 项目状态持久化在 `.leo/team/projects/<id>/`（state.json、board.json、artifacts/），新会话可恢复
- 安全：成员工具集 ⊆ 发起者工具集 ∩ 角色工具（预检 + 守卫强制），团队内部工具只给团队成员且对其他 Agent 隐藏；成员 `label` 为 `agent-team:<role>`；并发、步数、超时、打回次数、提问深度与次数有上限；取消逐级传递
