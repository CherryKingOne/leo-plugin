/**
 * 互动层（leo-plugin-interaction）的公开契约：子插件按这里的结构注册人设与表情包。
 * 子插件不 import 本包（各自打成单文件），把需要的部分抄一份即可（见 interaction-persona-whale 的 contract.ts）。
 */
import type { Disposer } from 'leo-agents'

/** 人设：替换 Agent 的身份与说话方式，不改变工作准则 */
export interface PersonaDefinition {
  /** `^[a-z][a-z0-9_-]{0,31}$`，用于 `/persona <id>` 与 interaction.json 的 `persona` */
  id: string
  /** 展示名，例如「鲸鱼娘·大肥鱼」 */
  name: string
  description?: string
  /**
   * 人设提示词。可用占位符：`{{model}}`（当前模型）、`{{cwd}}`（工作目录）、`{{date}}`（今天，YYYY-MM-DD）
   */
  prompt: string
  /** 推荐搭配的表情包 id（展示用） */
  stickerPack?: string
  /** 注册它的插件（展示用） */
  plugin?: string
}

export type StickerVisibility = 'public' | 'agent'

/** 一张表情在某个角色（variant）下的素材 */
export interface StickerAsset {
  /** 图片地址（http(s) / data URL / 本机绝对路径），聊天平台与 Web 用 */
  image?: string
  /** 终端字符画：每个元素一行（含 ANSI 颜色）；可以是函数，用到时再生成 / 解压 */
  ansi?: string[] | (() => string[] | undefined)
}

export interface StickerDefinition {
  /** 包内唯一，`^[a-z0-9][a-z0-9_-]{0,47}$` */
  id: string
  /** 表情上的文案，例如「测试通过！」 */
  text: string
  /** public：用户与 Agent 都能发；agent：只有 Agent 能发的彩蛋。默认 public */
  visibility?: StickerVisibility
  /** 适合使用的语境（写进提示词，帮助模型挑选） */
  triggers?: string[]
  /** 各角色的素材，键为 variant id */
  assets: Record<string, StickerAsset>
}

export interface StickerVariant {
  id: string
  name: string
}

/** 表情包 */
export interface StickerPack {
  /** `^[a-z][a-z0-9_-]{0,31}$` */
  id: string
  name: string
  /** 角色列表（同一张表情的不同画风），至少一个 */
  variants: StickerVariant[]
  /** 默认角色，缺省为第一个 */
  defaultVariant?: string
  stickers: StickerDefinition[]
  /** 版权 / 来源说明（`/stickers` 里展示） */
  credits?: string
  plugin?: string
}

/** 解析后的一张表情 */
export interface ResolvedSticker {
  /** 发送用的引用：包内 id；多个包有同名表情时为 `<pack>:<id>` */
  ref: string
  pack: StickerPack
  sticker: StickerDefinition
}

/** 服务 `interaction` */
export interface InteractionRegistry {
  registerPersona(persona: PersonaDefinition): Disposer
  registerStickerPack(pack: StickerPack): Disposer
  personas(): PersonaDefinition[]
  stickerPacks(): StickerPack[]
  /** 当前生效的人设（`persona: "auto"` 时为第一个注册的） */
  activePersona(): PersonaDefinition | undefined
  /** 切换人设：id / "auto" / "off"；persist 为 true 时写回 interaction.json */
  setPersona(id: string, opts?: { persist?: boolean }): Promise<PersonaDefinition | undefined>
  /** 按引用查找表情（`id` 或 `<pack>:<id>`） */
  findSticker(ref: string): ResolvedSticker | undefined
  /** 全部表情（按包的注册顺序） */
  stickers(): ResolvedSticker[]
}
