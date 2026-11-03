# 技能（leo-plugin-skills）

这个目录放你自己安装的技能，每个技能一个子目录，里面有 SKILL.md：

```
skills/
└── my-skill/
    ├── SKILL.md        必需：frontmatter 写 name 和 description，下面是正文
    ├── references/     可选：参考文档，用到时再读
    └── scripts/        可选：脚本
```

SKILL.md 开头：

```markdown
---
name: my-skill
description: 做什么、什么时候用（模型靠这句话判断要不要加载）
---
```

安装：在 leo 里输入 `/skills add <git 地址|本地路径> [技能名]`，例如
`/skills add https://github.com/anthropics/skills/tree/main/skills/pdf`。
也可以直接把技能文件夹复制进来。查看：`/skills`。手动触发：`/skill <名字> [任务]`。

`.builtin/` 是插件自带的内置技能，升级时会被覆盖，不要在里面改。
