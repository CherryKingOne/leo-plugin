# 第三方声明

## skill-creator（内置技能）

`builtin/skill-creator/` 原样取自 [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
（提交 `ca45fc496a3436251f191354091d557da31c15b5`，2026-10-28），版权归 Anthropic, PBC，
按 Apache License 2.0 授权，许可全文见 `builtin/skill-creator/LICENSE.txt`（随技能一起释放到 `~/.leo/skills/.builtin/skill-creator/`）。

未做修改。其中的评测脚本（`scripts/run_eval.py`、`run_loop.py`、`improve_description.py`）调用 `claude` 命令行，需要本机装有 Claude Code 才能运行；起草、校验、打包技能的部分不依赖它。
