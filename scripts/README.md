# scripts

仓库维护脚本（规划中，下一步实现）：

| 脚本 | 作用 |
| --- | --- |
| `new-plugin.mjs <id>` | 从 `plugins/_template` 复制出新插件，并替换 id / 包名 |
| `gen-registry.mjs` | 读取 `plugins/*/leo-plugin.json` 生成根目录 `registry.json`，并刷新各插件 README 的“安装”一节 |
| `validate.mjs` | 校验清单 schema 与一致性（见 docs/manifest.md），CI 中运行 |
