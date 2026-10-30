# scripts

| 脚本 | 作用 |
| --- | --- |
| `gen-registry.mjs [--check]` | 读取 `plugins/*/leo-plugin.json` 生成根目录 `registry.json`；`--check` 只校验是否最新 |
| `release.mjs <id> [--push]` | 构建插件单文件，提交到 `bundles` 分支的 `<id>/<version>/`，把下载地址与 sha256 写回清单并重新生成 registry |
| `new-plugin.mjs <id>` | 规划中：从 `plugins/_template` 复制出新插件 |
| `validate.mjs` | 规划中：校验清单 schema 与一致性，CI 中运行 |

## 发布流程

1. 提升 `plugins/<id>/package.json` 与 `leo-plugin.json` 的 `version`，更新 `CHANGELOG.md`
2. `node scripts/release.mjs <id> --push`
3. 提交并推送 main 上的 `leo-plugin.json` 与 `registry.json`

推送 main 后 `leo plugin add <id>` 即可安装新版本。已发布的版本不可修改，内容变化必须提升版本号。
