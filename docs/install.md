# 安装插件

官方插件支持四种安装方式。前两种适合大多数用户，后两种适合离线环境或在代码中嵌入 leo。

| 方式 | 适合 | 能否传配置 | 状态 |
| --- | --- | --- | --- |
| A. `leo plugin add <id>` | 命令行用户，一条命令装好 | 能 | 规划中（需 leo-agents 新增命令） |
| B. npm 安装 + 写配置 | 想手动控制版本 | 能 | 可用 |
| C. 复制单文件到 `.leo/plugins/` | 离线、不想用 npm | 不能（使用默认配置） | 可用（插件需提供 bundle） |
| D. 代码中传入 | 用 `createLeo` / `createLeoFromConfig` 开发应用 | 能 | 可用 |

下面以 `sub-agents` 为例。每个插件 README 的“安装”一节都按同样格式给出具体命令。

---

## A. 一条命令安装（规划中）

```bash
leo plugin add sub-agents             # 装到当前项目 .leo/
leo plugin add sub-agents --user      # 装到 ~/.leo/，所有项目可用
leo plugin add sub-agents@0.1.0       # 指定版本
leo plugin list                       # 已安装插件
leo plugin remove sub-agents
```

安装器的行为（供 leo-agents 实现时参考）：

1. 读取本仓库的 `registry.json`，按 `id` 找到插件与包名。
2. 在目标 `.leo/` 目录下执行 `npm install <package>@<version>`，依赖装进 `.leo/node_modules/`，不污染项目自己的 `package.json`。
3. 读取插件的 `leo-plugin.json`，把 `install.config` 中的条目追加到 `.leo/config.json` 的 `plugins` 数组（已存在则跳过）。
4. 如果清单声明了 `permissions` 中的新副作用类型，提示用户如何在审批配置中处理。
5. 打印插件 README 中的“配置”一节，告诉用户可调整哪些字段。

> 依赖 leo-agents 的配套改动：目前插件包名只从项目根目录（`.leo` 的上一级）的 `node_modules` 解析。实现本命令时，加载器需要额外从 `.leo/node_modules/` 与 `~/.leo/node_modules/` 解析。

## B. npm 安装 + 写配置

```bash
cd your-project
npm install leo-plugin-sub-agents
```

在 `.leo/config.json` 中加入：

```jsonc
{
  "plugins": [
    // 使用默认配置
    "leo-plugin-sub-agents"
    // 或者传入配置：
    // ["leo-plugin-sub-agents", { "maxDepth": 1 }]
  ]
}
```

说明：

- 包名按项目根目录（`.leo` 的上一级）解析，所以全局安装的 `leo` 也能加载项目里装的插件。
- 目前包名只从项目根目录的 `node_modules` 解析。想让所有项目都可用，暂时在 `~/.leo/config.json` 中用绝对路径引用插件入口文件，或使用方式 C 放进 `~/.leo/plugins/`。
- 运行 `leo doctor` 检查插件是否加载成功。

在 npm 发布之前，可以直接从 GitHub 安装：

```bash
npm install "github:CherryKingOne/leo-plugin#workspace=plugins/sub-agents"
```

> 注：npm 对 monorepo 子目录的 git 安装支持有限，正式使用请等待 npm 发布，或使用方式 C。

## C. 复制单文件到 `.leo/plugins/`

适合离线环境。支持此方式的插件会在发布页附带 `<id>.bundle.js`（依赖已打包，不依赖 `leo-agents` 运行时）。

```bash
mkdir -p .leo/plugins
cp sub-agents.bundle.js .leo/plugins/
```

`.leo/plugins/` 下的 `.js` / `.mjs` / `.ts` 文件会被自动加载，**不需要**写入 `config.json`，但也因此无法传配置，插件使用默认值运行。需要自定义配置时，改为在 `config.json` 中显式引用该文件：

```jsonc
{
  "plugins": [["./.leo/plugins/sub-agents.bundle.js", { "maxDepth": 1 }]]
}
```

同一个文件既被自动发现又被显式引用时只会加载一次，并使用显式配置。

## D. 在代码中使用

```ts
import { createLeoFromConfig } from 'leo-agents'
import subAgents from 'leo-plugin-sub-agents'

const app = await createLeoFromConfig({
  plugins: [[subAgents, { maxDepth: 1 }]],
})
```

或者使用底层 `createLeo`：

```ts
import { createLeo, deepseek } from 'leo-agents'
import subAgents from 'leo-plugin-sub-agents'

const leo = await createLeo({ plugins: [deepseek(), [subAgents, { maxDepth: 1 }]] })
```

## 加载顺序

`createLeoFromConfig` 按以下顺序加载插件，后加载的可以覆盖先加载的同名服务：

1. 用户级 `~/.leo/config.json` 的 `plugins`
2. `~/.leo/plugins/` 自动发现
3. 项目 `.leo/config.json` 的 `plugins`
4. 项目 `.leo/plugins/` 自动发现
5. 代码中传入的 `plugins`

## 卸载

- 方式 A：`leo plugin remove <id>`（规划中）
- 方式 B：从 `config.json` 删除条目，然后 `npm uninstall <package>`
- 方式 C：删除 `.leo/plugins/` 下的文件
