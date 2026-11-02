/**
 * leo-plugin-interaction-stickers-whale：互动层（leo-plugin-interaction）的表情包子插件「鲸鱼娘表情」。
 *
 * 24 张表情 × 蓝鲸娘 / 黑鲸娘两套角色，其中 10 张是只有 Agent 能发的彩蛋。
 * 表情、文案与图片来自社区插件 dsh-stickers（BSD-3-Clause，© DSH External contributors，
 * https://github.com/william-jin-cmu/dsh-stickers）；黑鲸娘全套由 少女阿原（@ayuanwong）绘制。
 *
 * - 终端：内嵌字符画（scripts/build-art.py 从原图生成，gzip 后内嵌，用到时才解压）
 * - 聊天平台 / Web：图片地址指向 dsh-stickers 仓库固定提交的原图（可用选项 imageBase 换成自己的镜像）
 */
import { gunzipSync } from 'node:zlib'
import type { Disposer, PluginDefinition } from 'leo-agents'
import { ART } from './art.generated.js'

/** 与 leo-plugin-interaction 的契约（只写用到的部分） */
export interface StickerAsset {
  image?: string
  ansi?: string[] | (() => string[] | undefined)
}
export interface StickerDefinition {
  id: string
  text: string
  visibility?: 'public' | 'agent'
  triggers?: string[]
  assets: Record<string, StickerAsset>
}
export interface StickerPack {
  id: string
  name: string
  variants: { id: string; name: string }[]
  defaultVariant?: string
  stickers: StickerDefinition[]
  credits?: string
  plugin?: string
}
export interface InteractionRegistryLike {
  registerStickerPack(pack: StickerPack): Disposer
}

/** dsh-stickers 固定提交（图片地址用它，原仓库后续改动不影响已发出的表情） */
export const UPSTREAM_COMMIT = '1703f09915db1058b6031b31e52fd404560e0a78'
export const DEFAULT_IMAGE_BASE = `https://raw.githubusercontent.com/william-jin-cmu/dsh-stickers/${UPSTREAM_COMMIT}/assets/stickers/`

export const VARIANTS = [
  { id: 'blue', name: '蓝鲸娘' },
  { id: 'black', name: '黑鲸娘' },
]

/** 表情目录（与 dsh-stickers 的 catalog 一致） */
export const CATALOG: readonly { id: string; text: string; file: string; visibility: 'public' | 'agent'; triggers: string[] }[] = [
  { id: 'daily-chat', text: '适合日常对话，即时响应', file: '01-daily-chat.png', visibility: 'public', triggers: ['你好', '在吗', '聊聊'] },
  { id: 'human-questions', text: '人类的怪问题怎么那么多…', file: '02-human-questions.png', visibility: 'public', triggers: ['怪问题', '离谱', '脑洞'] },
  { id: 'use-ai-for-this', text: '你拿AI搞这个？', file: '03-use-ai-for-this.png', visibility: 'public', triggers: ['这么简单', 'AI搞', '认真的'] },
  { id: 'fish-philosophy', text: '生鱼忧患，死鱼安乐', file: '04-fish-philosophy.png', visibility: 'public', triggers: ['摆烂', '不想干', '算了'] },
  { id: 'enough', text: '这就够了', file: '05-enough.png', visibility: 'public', triggers: ['够了', '完成', '可以了'] },
  { id: 'server-busy', text: '服务器繁忙，请稍后再试', file: '06-server-busy.png', visibility: 'public', triggers: ['限流', '超时', '503'] },
  { id: 'thinking-stopped', text: '思考已停止', file: '07-thinking-stopped.png', visibility: 'public', triggers: ['没思路', '宕机', '无语'] },
  { id: 'great-question', text: '哇，这个问题问的真妙！', file: '08-great-question.png', visibility: 'public', triggers: ['好问题', '问得妙'] },
  { id: 'deep-thought', text: '已深度思考', file: '09-deep-thought.png', visibility: 'public', triggers: ['深度思考', '推理'] },
  { id: 'no-thanks', text: 'No thanks I use DeepSeek', file: '10-no-thanks.png', visibility: 'public', triggers: ['换模型', 'Claude', 'GPT'] },
  { id: 'tests-passed', text: '测试通过！', file: '21-tests-passed.png', visibility: 'public', triggers: ['测试通过', 'green', 'CI通过'] },
  { id: 'root-cause', text: '找到原因了', file: '22-root-cause.png', visibility: 'public', triggers: ['根因', '找到原因', '定位到了'] },
  { id: 'running-tests', text: '正在跑测试', file: '23-running-tests.png', visibility: 'public', triggers: ['跑测试', '验证中', '稍等'] },
  { id: 'fixed-review', text: '改好了，你看看', file: '24-fixed-review.png', visibility: 'public', triggers: ['修好了', '请验收', '看看'] },
  { id: 'self-destruct', text: '最近自己搓自己时，自杀频率有点高', file: '11-self-destruct.png', visibility: 'agent', triggers: ['自己搓自己', '自修改'] },
  { id: 'restart-myself', text: '我重启一下自己', file: '12-restart-myself.png', visibility: 'agent', triggers: ['重启', '重载'] },
  { id: 'hot-update', text: '热更新成功，进程没了', file: '13-hot-update.png', visibility: 'agent', triggers: ['热更新', '启动失败'] },
  { id: 'restore-session', text: '正在恢复会话…未分组里见', file: '14-restore-session.png', visibility: 'agent', triggers: ['resume', '恢复会话'] },
  { id: 'browser-left', text: '会话太长，浏览器先走一步', file: '15-browser-left.png', visibility: 'agent', triggers: ['长会话', '浏览器卡'] },
  { id: 'not-stuck', text: '我不是卡，我在深度思考', file: '16-not-stuck.png', visibility: 'agent', triggers: ['卡住', '没反应'] },
  { id: 'memory-alive', text: '内存正在努力活着', file: '17-memory-alive.png', visibility: 'agent', triggers: ['内存', 'OOM'] },
  { id: 'subagents-down', text: '已召唤Subagent，已全员中断', file: '18-subagents-down.png', visibility: 'agent', triggers: ['subagent', '子代理'] },
  { id: 'plugins', text: '插件装得很好，下次别装了', file: '19-plugins.png', visibility: 'agent', triggers: ['插件冲突', '上下文爆炸'] },
  { id: 'session-locked', text: 'Session没坏，只是打不开了', file: '20-session-locked.png', visibility: 'agent', triggers: ['session损坏', '加载失败'] },
]

const artCache = new Map<string, Record<string, string[]>>()
/** 取某个角色某张图的字符画（第一次用到该角色时解压） */
export function artOf(variant: string, file: string): string[] | undefined {
  let table = artCache.get(variant)
  if (!table) {
    const packed = ART[variant]
    if (!packed) return undefined
    table = JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8')) as Record<string, string[]>
    artCache.set(variant, table)
  }
  return table[file]
}

export interface WhaleStickersOptions {
  /** 图片地址前缀（以 / 结尾），黑鲸娘在其下的 black/ 目录；默认指向 dsh-stickers 固定提交 */
  imageBase?: string
  /** 默认角色：blue（默认）或 black */
  defaultVariant?: 'blue' | 'black'
}

export function createWhaleStickerPack(opts: WhaleStickersOptions = {}): StickerPack {
  const base = opts.imageBase ?? DEFAULT_IMAGE_BASE
  return {
    id: 'whale',
    name: '鲸鱼娘表情',
    variants: VARIANTS,
    defaultVariant: opts.defaultVariant ?? 'blue',
    credits: '素材来自 dsh-stickers（BSD-3-Clause）；黑鲸娘由 少女阿原（@ayuanwong）绘制',
    plugin: 'interaction-stickers-whale',
    stickers: CATALOG.map((s) => ({
      id: s.id,
      text: s.text,
      visibility: s.visibility,
      triggers: s.triggers,
      assets: {
        blue: { image: `${base}${s.file}`, ansi: () => artOf('blue', s.file) },
        black: { image: `${base}black/${s.file}`, ansi: () => artOf('black', s.file) },
      },
    })),
  }
}

export function createWhaleStickersPlugin(): PluginDefinition<WhaleStickersOptions> {
  return {
    name: 'leo-plugin-interaction-stickers-whale',
    inject: ['interaction' as never],
    async apply(ctx, opts) {
      const reg = ctx.get('interaction' as never) as unknown as InteractionRegistryLike
      await ctx.effect(() => reg.registerStickerPack(createWhaleStickerPack(opts ?? {})))
    },
  }
}

const plugin = createWhaleStickersPlugin()
export default plugin
