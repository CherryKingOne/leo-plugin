# scripts

仓库任务已迁移到 Rust：`crates/leo-plugin-xtask`。

```bash
cargo run -p leo-plugin-xtask -- gen-registry   # 生成 registry.json
cargo run -p leo-plugin-xtask -- validate       # 校验清单一致性
```

原来的 `gen-registry.mjs` / `release.mjs` 已删除；发布流程见 `docs/install.md`。
