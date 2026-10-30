# leo-plugin-template

> 新插件模板，不会发布。复制本目录开始开发：`cp -r plugins/_template plugins/<id>`，然后按 [PROTOCOL.md](../../PROTOCOL.md) 第 9 节修改。

每个插件的 README 必须包含以下几节：

## 用途

一两句话：解决什么问题，什么时候用。

## 安装

```bash
npm install leo-plugin-template
```

`.leo/config.json`：

```json
{ "plugins": [["leo-plugin-template", { "prefix": "echo: " }]] }
```

其他安装方式见 [docs/install.md](../../docs/install.md)。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prefix` | string | `""` | 回显前缀 |

## 提供的能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 工具 | `template_echo` | 原样返回输入文本 |

## 安全说明

本插件不读写文件、不执行命令、不访问网络。
