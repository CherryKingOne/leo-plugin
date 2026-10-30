# leo-plugin

[leo-agents](https://github.com/CherryKingOne/leo-agents) 官方插件仓库。**一个插件一个目录**，各自独立发布为 npm 包 `leo-plugin-<id>`。

## 插件列表

| 插件 | 包名 | 状态 | 说明 |
| --- | --- | --- | --- |
| [sub-agents](plugins/sub-agents) | `leo-plugin-sub-agents` | 实验性 0.2.0 | 把任务委派给独立上下文的子 Agent 执行并汇总结果 |

机器可读的索引见 [`registry.json`](registry.json)。

## 快速安装

```bash
leo plugin list               # 查看可安装的插件
leo plugin add sub-agents     # 装到当前项目（-g 装到 ~/.leo）
```

其他方式（npm、离线复制、代码中传入）见 [docs/install.md](docs/install.md)。

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
├── scripts/                  新建插件、生成索引、校验（规划中）
└── plugins/
    ├── _template/            新插件模板（可运行的最小示例）
    └── sub-agents/           子代理插件
```

## 许可

Apache-2.0
