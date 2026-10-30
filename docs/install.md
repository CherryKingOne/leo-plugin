# 安装插件

官方插件支持四种安装方式。前两种适合大多数用户，后两种适合离线环境或在代码中嵌入 leo。

| 方式 | 适合 | 能否传配置 | 状态 |
| --- | --- | --- | --- |
| A. `leo plugin add <id>` | 命令行用户，一条命令装好 | 能 | 可用（leo-agents ≥ 9f19bc9） |
| B. npm 安装 + 写配置 | 想手动控制版本 | 能 | 插件发布到 npm 后可用 |
| C. 复制单文件到 `.leo/plugins/` | 离线、不想用 npm | 能（显式引用时） | 可用 |
| D. 代码中传入 | 用 `createLeo` / `createLeoFromConfig` 开发应用 | 能 | 可用 |

下面以 `sub-agents` 为例。

---

## A. 一条命令安装

```bash
leo plugin list                       # 已安装的插件 + 官方插件仓库里可安装的插件
leo plugin add sub-agents             # 装到当前项目 .leo/plugins/
leo plugin add sub-agents -g          # 装到 ~/.leo/plugins/，所有项目可用
leo plugin add sub-agents --npm       # 改用 npm 安装（插件发布到 npm 后）
leo plugin remove sub-agents [-g]
```

`leo plugin add <id>` 做了什么：

1. 读取本仓库的 [`registry.json`](../registry.json)（默认 `https://raw.githubusercontent.com/CherryKingOne/leo-plugin/main/registry.json`），按 `id` 找到插件。规划中（`planned`）的插件不能安装；`leo` 字段声明的版本要求不满足时拒绝安装。
2. 默认下载插件的单文件版本（`bundle.url`，存放在本仓库的 `bundles` 分支，按版本号分目录、发布后不可修改），**校验 sha256**，写到 `<scope>/plugins/<id>.bundle.js`。该目录下的文件会被自动加载。
3. 加 `--npm` 时改为 `npm install --prefix <scope> <package>@<version>`（依赖装进 `.leo/node_modules/`，不动项目自己的 `package.json`），并把包名追加到 `<scope>/config.json` 的 `plugins`（保留文件里的注释）。项目级安装会把 `.leo/node_modules/` 加进 `.gitignore`。`--npm` 也可以安装仓库外的任意 npm 包：`leo plugin add @acme/leo-plugin-x --npm`。

`<scope>` 是项目的 `.leo/`（默认）或 `~/.leo/`（`-g`）。

需要改配置时，在 `config.json` 里显式引用安装好的文件（同一文件只加载一次，使用显式配置）：

```jsonc
// .leo/config.json
{ "plugins": [["./.leo/plugins/sub-agents.bundle.js", { "maxConcurrent": 2 }]] }
// ~/.leo/config.json（相对 ~/.leo）
{ "plugins": [["./plugins/sub-agents.bundle.js", { "maxConcurrent": 2 }]] }
```

镜像或私有仓库：`--registry <url|路径>` 或环境变量 `LEO_PLUGIN_REGISTRY`。仓库格式见 [`schemas/registry.schema.json`](../schemas/registry.schema.json)，`bundle.url` 可以写相对地址（相对 registry.json）。

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

- 包名依次在 项目 `.leo/` → 项目根 → `~/.leo/` 的 `node_modules` 中解析（`~/.leo/config.json` 里的包先查 `~/.leo/`），所以全局安装的 `leo` 也能加载项目里装的插件。
- 运行 `leo doctor` 检查插件是否加载成功。
- 插件尚未发布到 npm 前，请使用方式 A 或 C。

## C. 复制单文件到 `.leo/plugins/`

适合离线环境。单文件版本在本仓库的 `bundles` 分支：`<id>/<version>/<id>.bundle.js`（依赖已打包，不依赖 `leo-agents` 运行时；sha256 见 `registry.json`）。

```bash
mkdir -p .leo/plugins
curl -fsSL -o .leo/plugins/sub-agents.bundle.js \
  https://raw.githubusercontent.com/CherryKingOne/leo-plugin/bundles/sub-agents/0.1.0/sub-agents.bundle.js
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

- 方式 A：`leo plugin remove <id>`（`-g` 对应全局安装）
- 方式 B：从 `config.json` 删除条目，然后 `npm uninstall <package>`
- 方式 C：删除 `.leo/plugins/` 下的文件
