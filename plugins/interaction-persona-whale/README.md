# leo-plugin-interaction-persona-whale

互动层（[interaction](../interaction/)）的人设子插件：**鲸鱼娘·大肥鱼** 🐋

傲娇但很甜的鲸鱼娘口吻，自称「本鲸鱼娘」「本小姐」，思考过程用中文；保留完整编码助手能力，工具调用与输出质量不受人设影响。

```bash
leo plugin add interaction
leo plugin add interaction-persona-whale
```

装上即生效（`interaction.json` 的 `persona` 默认 `auto`）。`/persona off` 关闭，`/persona whale` 切回。和 [interaction-stickers-whale](../interaction-stickers-whale/) 一起装效果最好。

## 来源与许可

人设文本移植自社区插件 [dsh-whale-musume-persona](https://github.com/Kaalia0912/dsh-whale-musume-persona)（MIT），本子插件同样以 MIT 发布，见 [LICENSE](LICENSE)。与 DSH 版的区别：leo 没有 agent preset，人设由互动层作为系统提示词片段注入，不需要复制预设目录或合并 cordis 补丁。

这是独立的社区项目，不是 DeepSeek 官方功能。
