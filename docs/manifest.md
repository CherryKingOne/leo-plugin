# 插件清单 `leo-plugin.json`

每个插件目录必须有一份 `leo-plugin.json`。它是插件的“身份证”：`scripts/gen-registry.mjs` 用它生成根目录的 `registry.json`，安装器（`leo plugin add`）用它决定装什么、怎么写配置，插件 README 的“安装”一节也由它生成。

JSON Schema：[`schemas/leo-plugin.schema.json`](../schemas/leo-plugin.schema.json)

## 示例

```json
{
  "$schema": "../../schemas/leo-plugin.schema.json",
  "id": "sub-agents",
  "package": "leo-plugin-sub-agents",
  "version": "0.1.0",
  "status": "stable",
  "description": "子代理：把任务委派给独立上下文的子 Agent 执行并汇总结果",
  "keywords": ["agent", "delegation"],
  "leo": ">=0.1.0",
  "entry": "./dist/index.js",
  "bundle": "./dist/sub-agents.bundle.js",
  "inject": ["agentLoop", "tools"],
  "provides": {
    "services": ["subAgents"],
    "tools": ["task"],
    "events": ["sub-agents/finished"]
  },
  "permissions": ["agent.spawn"],
  "install": {
    "config": "leo-plugin-sub-agents",
    "example": ["leo-plugin-sub-agents", { "maxDepth": 1 }]
  }
}
```

## 字段

| 字段 | 必须 | 说明 |
| --- | --- | --- |
| `id` | 是 | kebab-case，等于目录名 |
| `package` | 是 | npm 包名，等于 `leo-plugin-<id>`，也等于插件对象的 `name` |
| `version` | 是 | 与 `package.json` 一致 |
| `status` | 是 | `planned` 规划中 / `experimental` 实验 / `stable` 稳定 / `deprecated` 废弃 |
| `description` | 是 | 一句话说明，会显示在索引与 `leo plugin list` 中 |
| `keywords` | 否 | 检索用 |
| `leo` | 是 | 兼容的 leo-agents 版本范围（semver），与 `peerDependencies` 一致 |
| `entry` | 是 | 包内入口文件（ESM，默认导出插件） |
| `bundle` | 否 | 单文件构建产物，提供则支持“复制到 `.leo/plugins/`”安装 |
| `inject` | 否 | 依赖的服务，与插件对象的 `inject` 一致 |
| `provides.services` | 否 | 提供的服务键 |
| `provides.tools` | 否 | 注册的工具名 |
| `provides.events` | 否 | 新声明的事件名 |
| `permissions` | 否 | 工具声明的权限类型（`fs.write`、`process.exec`、`net.fetch`、`agent.spawn` 等），安装器据此提示审批配置 |
| `install.config` | 是 | 写入 `.leo/config.json` `plugins` 数组的默认条目 |
| `install.example` | 否 | 带配置的示例条目，显示在 README 与安装提示中 |

## 一致性检查

`scripts/validate.mjs`（规划中）会在 CI 中检查：

- `id` = 目录名，`package` = `leo-plugin-<id>` = `package.json#name`
- `version` = `package.json#version`
- `leo` = `package.json#peerDependencies.leo-agents`
- `provides.tools` 不与核心保留工具名冲突
- 构建产物中没有对 `leo-agents` 的运行时 import
