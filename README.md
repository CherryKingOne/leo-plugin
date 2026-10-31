# leo-plugin

[leo-agents](https://github.com/CherryKingOne/leo-agents) 官方插件仓库。**一个插件一个目录**，各自独立发布为 npm 包 `leo-plugin-<id>`。


> 各插件版本与 leo-agents 版本的对应关系、发布时间和更新说明见 [COMPATIBILITY.md](COMPATIBILITY.md)。

## 插件列表

| 插件 | 包名 | 状态 | 说明 |
| --- | --- | --- | --- |
| [mcp](plugins/mcp) | `leo-plugin-mcp` | 实验性 0.1.0 | 接入外部 MCP 服务器的工具（stdio / HTTP），兼容 MCP 2026-07-28（MCP 2.0）与旧版握手协议 |
| [sub-agents](plugins/sub-agents) | `leo-plugin-sub-agents` | 实验性 0.1.0 | 把任务委派给独立上下文的子 Agent 执行并汇总结果 |
| [gateway](plugins/gateway) | `leo-plugin-gateway` | 实验性 0.2.0（已发布 0.1.1） | 消息网关（注册层）：接入 Telegram / 飞书 / QQ，按会话路由给 Agent，授权配对、聊天内审批、主动投递，HTTP / WebSocket / OpenAI 兼容控制面（配合 `leo serve` 常驻运行） |
| [gateway-qq](plugins/gateway-qq) | `leo-plugin-gateway-qq` | 实验性 0.2.2 | 网关的 QQ 子插件：QQ 官方机器人驱动，手机 QQ 扫码绑定，顶替网关内置 QQ 驱动 |
| [gateway-feishu](plugins/gateway-feishu) | `leo-plugin-gateway-feishu` | 实验性 0.2.3 | 网关的飞书子插件：飞书扫码一键创建应用，扫码人自动成为管理员，顶替网关内置飞书驱动 |
| [provider](plugins/provider) | `leo-plugin-provider` | 实验性 0.3.1 | 模型供应商注册层：子插件注册驱动，统一读配置、取密钥、接入 Agent；自带通用 OpenAI 兼容协议（需要 leo-agents ≥ 0.2.0） |
| [provider-deepseek](plugins/provider-deepseek) | `leo-plugin-provider-deepseek` | 实验性 0.3.0 | 模型供应商的 DeepSeek 子插件：deepseek-flash / deepseek-v4-pro，思考模式与工具调用，旧模型名自动改写 |
| [provider-longcat](plugins/provider-longcat) | `leo-plugin-provider-longcat` | 实验性 0.1.0 | 模型供应商的 LongCat（美团）子插件：LongCat-2.5-Preview，思考模式与工具调用，推理强度换算成思考预算 |
| [provider-spark](plugins/provider-spark) | `leo-plugin-provider-spark` | 实验性 0.1.0 | 模型供应商的讯飞星火子插件：Spark-X2.6 / X2.5 系列（讯飞自研），思考模式 enabled / disabled / auto 与工具调用 |

机器可读的索引见 [`registry.json`](registry.json)。

## 快速安装

```bash
leo plugin list                    # 查看可安装的插件
leo plugin add mcp                 # 全局安装（~/.leo，所有项目可用），自动生成 ~/.leo/mcp-servers.json
leo plugin add sub-agents          # 全局安装，自动生成示例子 Agent ~/.leo/agents/explorer.md
leo plugin add gateway             # 全局安装，自动生成 ~/.leo/gateway.json；填好机器人后 leo serve 常驻运行
leo plugin add mcp --project       # 只装到当前项目：.leo/plugins/ 与 .leo/mcp-servers.json
leo plugin remove mcp              # 卸载全局（默认）；--project 卸项目，--all 都卸，--purge 连配置一起删
```

默认全局安装；`--project`（`--local` / `-l`）装到当前项目，两处都装时项目里的生效。插件带配置文件模板时安装后自动初始化到对应的 `.leo/`（已有文件保留），没有就跳过；`--no-init` 跳过，`--init-from <路径>` 用你自己的模板。正在运行的 leo 会自动热加载新装、更新或删除的插件，修改 `mcp-servers.json`、`agents/*.md` 也立即生效，不用重启。需要 leo-agents `feat/global-plugin-install` 分支及以后。

四种安装方式（一条命令、npm、复制单文件、代码中传入）见 [docs/install.md](docs/install.md)。

## 开发插件

1. 阅读 [PROTOCOL.md](PROTOCOL.md)：插件的导出形式、可用的服务与事件、工具与配置规则、安全基线、合并检查清单。
2. 复制模板：`cp -r plugins/_template plugins/<id>`，按协议第 9 节改名。
3. 写好 `leo-plugin.json`（规范见 [docs/manifest.md](docs/manifest.md)）。
4. `npm install` 后在插件目录运行 `npm run typecheck && npm test`。

## 目录结构

```text
leo-plugin/
├── README.md                 本文件：插件列表与快速开始
├── PROTOCOL.md               插件开发协议（必读）
├── registry.json             官方插件索引，由脚本生成
├── package.json              npm workspaces 根
├── tsconfig.base.json        各插件共享的 TS 配置
├── docs/
│   ├── install.md            安装方式
│   └── manifest.md           leo-plugin.json 清单规范
├── schemas/
│   ├── leo-plugin.schema.json  清单 JSON Schema
│   └── registry.schema.json    索引 JSON Schema
├── scripts/                  发布单文件（release.mjs）、生成索引（gen-registry.mjs）
└── plugins/
    ├── _template/            新插件模板（可运行的最小示例）
    ├── mcp/                  MCP 客户端插件
    ├── sub-agents/           子代理插件
    ├── gateway/              消息网关插件
    ├── gateway-qq/           网关的 QQ 子插件（扫码绑定）
    ├── gateway-feishu/       网关的飞书子插件（扫码创建应用）
    ├── provider/             模型供应商注册层
    ├── provider-deepseek/    模型供应商的 DeepSeek 子插件
    ├── provider-longcat/     模型供应商的 LongCat 子插件
    └── provider-spark/       模型供应商的讯飞星火子插件
```

## 许可

Apache-2.0
