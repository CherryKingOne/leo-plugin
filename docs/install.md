# 构建与安装

本仓库是 Rust 工作区，插件以 crate 形式提供。根目录 `Cargo.toml` 的 `members` 列出所有 `plugins/*` 与 `crates/*`。

## 构建

```bash
cargo build --workspace            # 构建全部插件与工具
cargo build --release --workspace  # 发布构建
cargo test --workspace             # 运行全部测试
```

单个插件：

```bash
cargo build -p leo-plugin-mcp
cargo test  -p leo-plugin-mcp
```

## 运行插件（子进程）

每个插件 crate 都带一个二进制入口，通过换行分隔的 JSON-RPC 在 stdio 上通信：

```bash
cargo build -p leo-plugin-template
echo '{"id":1,"method":"describe","params":{}}' | ./target/debug/leo-plugin-template
```

`leo-plugin-host` 可以启动插件、发送 `apply`、列出并调用工具：

```bash
cargo run -p leo-plugin-host -- ./target/debug/leo-plugin-template
cargo run -p leo-plugin-host -- ./target/debug/leo-plugin-template --tool template_echo '{"text":"hi"}'
```

请求方法：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `describe` | `{}` | 插件名、inject、watch、config_schema |
| `apply` | `{config}` | `{name}` |
| `list_tools` | `{}` | 工具定义数组 |
| `call_tool` | `{name, arguments}` | `{output, isError, terminate}` |
| `emit` | `{event, payload}` | 事件结果 |
| `dispose` | `{}` | `null` |
| `ping` | `{}` | `"pong"` |

## 在代码中嵌入

```rust
use std::sync::Arc;
use leo_plugin_sdk::{runtime::apply_plugin, Context, NullLogger, Plugin};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let plugin: Arc<dyn Plugin> = Arc::new(leo_plugin_sub_agents::SubAgentsPlugin::default());
    let (ctx, tools) = apply_plugin(&plugin).await?;
    for tool in tools.list() {
        println!("{}", tool.name);
    }
    ctx.dispose().await;
    Ok(())
}
```

也可以手动构建上下文：

```rust
let ctx = Context::root(Arc::new(NullLogger));
ctx.ensure_basic_tools();
plugin.apply(ctx.clone(), serde_json::Value::Null).await?;
```

## 加载顺序

宿主按以下顺序加载插件，后加载的可以覆盖先加载的同名服务：

1. 用户级 `~/.leo/config.json` 的 `plugins`
2. `~/.leo/plugins/` 自动发现
3. 项目 `.leo/config.json` 的 `plugins`
4. 项目 `.leo/plugins/` 自动发现
5. 代码中传入的 `plugins`

## 配置文件

插件从 `.leo/` 读取自己的配置（如 `mcp-servers.json`、`provider.json`、`gateway.json`）。路径由 `leo_plugin_sdk::LeoPaths::detect()` 解析：`~/.leo`（或 `$LEO_HOME`）为用户目录，项目根由 `.leo/` 或 `.git` 向上查找。`leo-plugin.json` 的 `init.files` 声明安装时自动初始化的模板。

## 热加载

宿主监听 `~/.leo/` 与项目 `.leo/` 下的 `config.json`、`plugins/` 和插件声明的 `watch` 数据文件。安装、更新、删除插件或修改这些文件后，通常一秒内自动生效：新工具从 Agent 的下一步起可用，删除的插件撤销它注册的全部工具和服务。新版本加载失败时保留旧版本。

## 仓库任务

```bash
cargo run -p leo-plugin-xtask -- gen-registry   # 生成 registry.json
cargo run -p leo-plugin-xtask -- validate       # 校验清单一致性
```

## 发布

发布单文件与模板由 `leo-plugin-xtask` 负责（原计划中的 `scripts/release.mjs` 已被 Rust 实现取代）。将构建产物与 `init` 模板发布到仓库的 `bundles` 分支，并把地址与 sha256 写入 `registry.json`。