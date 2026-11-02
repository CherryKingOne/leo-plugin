/**
 * leo-plugin-interaction：互动层（注册层）。
 *
 * 和网关（gateway + gateway-qq / gateway-feishu）、模型供应商（provider + provider-*）一样分两层：
 * 本插件提供服务 `interaction`，人设与表情包由子插件注册进来。
 *
 * - 人设：当前人设的提示词作为 agent 层片段注入（排在宿主系统提示词之后，身份与语气以人设为准）
 * - 表情包：注册 `send_sticker` 工具，并把可用表情写进提示词；模型按对话语境自己决定发不发、发哪张。
 *   工具结果的 `display`（leo-agents ≥ 0.2.1）带终端字符画与图片地址，由前端渲染给用户看，不进模型上下文
 * - 斜杠命令（leo-agents ≥ 0.2.1 的 commands 服务）：`/persona`、`/sticker`、`/stickers`
 *
 * 旧宿主（0.2.0）上照常工作，只是没有斜杠命令，终端只显示一行文字。
 */
import type { Context, Disposer, PluginDefinition, ToolDefinition } from 'leo-agents'
import { CONFIG_FILE_NAME, type ConfigPaths, type InteractionConfig, loadConfig, persistPersona } from './config.js'
import type { InteractionRegistry, PersonaDefinition, ResolvedSticker, StickerPack, StickerVariant } from './types.js'

export type * from './types.js'
export { CONFIG_FILE_NAME, DEFAULT_CONFIG, normalizeConfig, type InteractionConfig } from './config.js'

const PLUGIN_NAME = 'leo-plugin-interaction'
const ID = /^[a-z][a-z0-9_-]{0,31}$/
const STICKER_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/

/** 展示块（与 leo-agents 0.2.1 的 DisplayBlock 结构一致；插件运行时不 import 宿主） */
type DisplayBlock = { type: 'text'; text: string } | { type: 'ansi'; lines: string[]; fallback?: string } | { type: 'image'; url: string; alt?: string }

interface CommandsLike {
  register(def: {
    name: string
    aliases?: string[]
    description?: string
    usage?: string
    plugin?: string
    run(c: { args: string; argv: string[]; sessionId?: string; surface: string }): unknown
  }): Disposer
}

interface ContextServiceLike {
  registerSection(section: { id: string; layer: string; priority?: number; render(input: { model: string }): string | undefined }): Disposer
}

interface ToolsLike {
  register(def: ToolDefinition): Disposer
}

export interface SentSticker {
  ok: true
  ref: string
  pack: string
  id: string
  text: string
  variant: string
  image?: string
  sender: 'agent' | 'user'
}

export function interpolate(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m)
}

/** 注册表本体（与宿主无关，便于测试） */
export class Interaction implements InteractionRegistry {
  private readonly personaList: PersonaDefinition[] = []
  private readonly packList: StickerPack[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    public config: InteractionConfig,
    private readonly persist?: (persona: string) => Promise<void>,
  ) {}

  onChange(fn: () => void): Disposer {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private changed() {
    for (const fn of this.listeners) fn()
  }

  registerPersona(persona: PersonaDefinition): Disposer {
    if (!ID.test(persona.id)) throw new Error(`interaction: 人设 id "${persona.id}" 不合法（小写字母开头，最长 32）`)
    if (persona.id === 'auto' || persona.id === 'off') throw new Error(`interaction: 人设 id 不能是 "${persona.id}"`)
    if (this.personaList.some((p) => p.id === persona.id)) throw new Error(`interaction: 人设 "${persona.id}" 已注册`)
    if (!persona.prompt?.trim()) throw new Error(`interaction: 人设 "${persona.id}" 没有提示词`)
    const entry = { ...persona }
    this.personaList.push(entry)
    this.changed()
    return () => {
      const i = this.personaList.indexOf(entry)
      if (i >= 0) this.personaList.splice(i, 1)
      this.changed()
    }
  }

  registerStickerPack(pack: StickerPack): Disposer {
    if (!ID.test(pack.id)) throw new Error(`interaction: 表情包 id "${pack.id}" 不合法（小写字母开头，最长 32）`)
    if (this.packList.some((p) => p.id === pack.id)) throw new Error(`interaction: 表情包 "${pack.id}" 已注册`)
    if (!pack.variants?.length) throw new Error(`interaction: 表情包 "${pack.id}" 至少要有一个角色（variants）`)
    const seen = new Set<string>()
    for (const s of pack.stickers) {
      if (!STICKER_ID.test(s.id)) throw new Error(`interaction: 表情 id "${pack.id}:${s.id}" 不合法`)
      if (seen.has(s.id)) throw new Error(`interaction: 表情包 "${pack.id}" 里表情 "${s.id}" 重复`)
      seen.add(s.id)
    }
    const entry = { ...pack }
    this.packList.push(entry)
    this.changed()
    return () => {
      const i = this.packList.indexOf(entry)
      if (i >= 0) this.packList.splice(i, 1)
      this.changed()
    }
  }

  personas() {
    return [...this.personaList]
  }

  stickerPacks() {
    return [...this.packList]
  }

  activePersona(): PersonaDefinition | undefined {
    const want = this.config.persona
    if (want === 'off') return undefined
    if (want === 'auto') return this.personaList[0]
    return this.personaList.find((p) => p.id === want)
  }

  async setPersona(id: string, opts: { persist?: boolean } = {}) {
    if (id !== 'auto' && id !== 'off' && !this.personaList.some((p) => p.id === id)) {
      throw new Error(`没有人设 "${id}"。可用：${this.personaList.map((p) => p.id).join(', ') || '（没有安装人设子插件）'}`)
    }
    this.config = { ...this.config, persona: id }
    if (opts.persist) await this.persist?.(id)
    return this.activePersona()
  }

  stickers(): ResolvedSticker[] {
    const count = new Map<string, number>()
    for (const p of this.packList) for (const s of p.stickers) count.set(s.id, (count.get(s.id) ?? 0) + 1)
    return this.packList.flatMap((pack) =>
      pack.stickers.map((sticker) => ({ ref: count.get(sticker.id)! > 1 ? `${pack.id}:${sticker.id}` : sticker.id, pack, sticker })),
    )
  }

  findSticker(ref: string): ResolvedSticker | undefined {
    const all = this.stickers()
    const colon = ref.indexOf(':')
    if (colon > 0) {
      const [packId, id] = [ref.slice(0, colon), ref.slice(colon + 1)]
      return all.find((s) => s.pack.id === packId && s.sticker.id === id)
    }
    return all.find((s) => s.sticker.id === ref)
  }

  /** Agent 能发的表情（按配置决定是否包含彩蛋） */
  agentStickers(): ResolvedSticker[] {
    return this.stickers().filter((s) => this.config.stickers.hidden || (s.sticker.visibility ?? 'public') === 'public')
  }

  publicStickers(): ResolvedSticker[] {
    return this.stickers().filter((s) => (s.sticker.visibility ?? 'public') === 'public')
  }

  /** 所有包的角色并集 */
  variants(): StickerVariant[] {
    const out: StickerVariant[] = []
    for (const p of this.packList) for (const v of p.variants) if (!out.some((x) => x.id === v.id)) out.push(v)
    return out
  }

  resolveVariant(pack: StickerPack, requested?: string): string {
    const ids = pack.variants.map((v) => v.id)
    for (const v of [requested, this.config.stickers.variant, pack.defaultVariant]) if (v && ids.includes(v)) return v
    return ids[0]!
  }

  /** 生成发送结果；表情不存在、不允许或角色未知时抛错 */
  send(ref: string, sender: 'agent' | 'user', variant?: string): SentSticker {
    const found = this.findSticker(ref)
    const allowed = sender === 'agent' ? this.agentStickers() : this.publicStickers()
    if (!found || !allowed.some((s) => s.pack === found.pack && s.sticker === found.sticker)) {
      const list = allowed.map((s) => s.ref)
      throw new Error(`表情不存在或不能由${sender === 'agent' ? ' Agent' : '用户'}发送：${ref}。可用：${list.join(', ') || '（没有安装表情包子插件）'}`)
    }
    if (variant && !found.pack.variants.some((v) => v.id === variant)) {
      throw new Error(`未知的角色 "${variant}"，可用：${found.pack.variants.map((v) => v.id).join(', ')}`)
    }
    const v = this.resolveVariant(found.pack, variant)
    const asset = found.sticker.assets[v] ?? found.sticker.assets[this.resolveVariant(found.pack)]
    return {
      ok: true,
      ref: found.ref,
      pack: found.pack.id,
      id: found.sticker.id,
      text: found.sticker.text,
      variant: v,
      ...(asset?.image ? { image: asset.image } : {}),
      sender,
    }
  }

  /** 给用户看的展示块 */
  display(sent: SentSticker): DisplayBlock[] {
    const mode = this.config.stickers.display
    const label = `🐋 [表情] ${sent.text}`
    if (mode === 'off') return [{ type: 'text', text: label }]
    const blocks: DisplayBlock[] = []
    if (mode === 'art') {
      const found = this.findSticker(sent.ref)
      const asset = found?.sticker.assets[sent.variant]
      const lines = typeof asset?.ansi === 'function' ? asset.ansi() : asset?.ansi
      if (lines?.length) blocks.push({ type: 'ansi', lines, fallback: label })
    }
    if (sent.image) blocks.push({ type: 'image', url: sent.image, alt: sent.text })
    if (!blocks.length) blocks.push({ type: 'text', text: label })
    return blocks
  }

  /** 表情提示词片段 */
  stickerGuidance(): string | undefined {
    if (!this.config.stickers.enabled || this.config.stickers.maxPerTurn === 0) return undefined
    const list = this.agentStickers()
    if (!list.length) return undefined
    const max = this.config.stickers.maxPerTurn
    const variants = this.variants()
    const lines = list.map((s) => `- ${s.ref}：${s.sticker.text}${s.sticker.triggers?.length ? `（适合：${s.sticker.triggers.join('、')}）` : ''}`)
    return [
      '## 表情包',
      `你可以用 send_sticker 工具给用户发表情，让对话更有活人感。按对话语境主动使用，不必等用户要求；每轮最多 ${max} 张，只在它确实能表达语气时发，绝不能用表情代替实质回答。发完不用再描述表情内容。`,
      '发表情的唯一方式是调用 send_sticker 工具。只在回复文字里写「（发送了一张……表情）」之类的描述，用户什么都看不到；想发就调用工具，不想发就别提表情。用户要你发表情时，一定要调用工具。',
      variants.length > 1
        ? `每张表情有多个角色：${variants.map((v) => `${v.id}（${v.name}）`).join('、')}；默认 ${this.config.stickers.variant || variants[0]!.id}，用户换过角色时跟着用户的选择传 variant。`
        : '',
      '可用表情：',
      ...lines,
    ]
      .filter(Boolean)
      .join('\n')
  }
}

function personaSection(p: PersonaDefinition, vars: Record<string, string>): string {
  return [
    `## 人设：${p.name}`,
    '下面的人设决定你的身份、自称与说话方式，优先于上文中关于身份和语气的描述；工作准则、安全要求与工具使用规则不变，输出质量不受人设影响。',
    '',
    interpolate(p.prompt.trim(), vars),
  ].join('\n')
}

function stickerTool(reg: Interaction): ToolDefinition {
  const refs = reg.agentStickers().map((s) => s.ref)
  const variants = reg.variants().map((v) => v.id)
  const perTurn = new Map<string, number>()
  return {
    name: 'send_sticker',
    title: '发表情',
    description:
      'Send one reaction sticker to the user when it naturally adds tone (greeting, tests passed, found the root cause, a weird question...). Use proactively based on the conversation, at most the per-turn limit, and never instead of a substantive answer. The user sees the sticker; do not describe it afterwards.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', enum: refs, description: 'Sticker id' },
        ...(variants.length > 1 ? { variant: { type: 'string', enum: variants, description: 'Character variant' } } : {}),
      },
      required: ['id'],
      additionalProperties: false,
    },
    execute: (args: { id?: unknown; variant?: unknown }, exec: { turnId: string }) => {
      const max = reg.config.stickers.maxPerTurn
      const used = perTurn.get(exec.turnId) ?? 0
      if (used >= max) throw new Error(`本轮已经发过 ${used} 张表情（上限 ${max}），不要再发了`)
      const sent = reg.send(String(args.id ?? ''), 'agent', typeof args.variant === 'string' ? args.variant : undefined)
      perTurn.set(exec.turnId, used + 1)
      if (perTurn.size > 200) perTurn.delete(perTurn.keys().next().value!)
      return sent
    },
    render: (sent: SentSticker) => ({
      content: `已发送表情「${sent.text}」（${sent.ref}${sent.variant ? ` · ${sent.variant}` : ''}），用户已经看到。`,
      details: sent,
      display: reg.display(sent),
    }),
  } as unknown as ToolDefinition
}

function personaCommandText(reg: Interaction): string {
  const active = reg.activePersona()
  const list = reg.personas()
  if (!list.length) return '没有安装人设子插件。试试：leo plugin add interaction-persona-whale'
  const mode = reg.config.persona
  return [
    `当前人设：${active ? `${active.name}（${active.id}）` : '无'}${mode === 'auto' ? ' · auto' : ''}`,
    ...list.map((p) => `  ${p === active ? '●' : '○'} ${p.id}  ${p.name}${p.description ? ` — ${p.description}` : ''}`),
    '切换：/persona <id> · 关闭：/persona off · 自动：/persona auto',
  ].join('\n')
}

function stickersCommandText(reg: Interaction): string {
  const packs = reg.stickerPacks()
  if (!packs.length) return '没有安装表情包子插件。试试：leo plugin add interaction-stickers-whale'
  const out: string[] = []
  for (const p of packs) {
    out.push(`${p.name}（${p.id}）· 角色：${p.variants.map((v) => `${v.id} ${v.name}`).join(' / ')}`)
    for (const s of reg.publicStickers().filter((x) => x.pack === p)) out.push(`  ${s.ref.padEnd(18)} ${s.sticker.text}`)
    const hidden = p.stickers.filter((s) => s.visibility === 'agent').length
    if (hidden) out.push(`  （另有 ${hidden} 张彩蛋只有 Agent 能发）`)
    if (p.credits) out.push(`  ${p.credits}`)
  }
  out.push('发送：/sticker <id> [角色]')
  return out.join('\n')
}

export interface InteractionPluginOptions {
  /** 测试用：不读 interaction.json */
  loadConfigFiles?: boolean
}

export function createInteractionPlugin(): PluginDefinition<Record<string, unknown>> & { watch?: readonly string[] } {
  return {
    name: PLUGIN_NAME,
    inject: ['tools', 'context'],
    watch: [CONFIG_FILE_NAME],
    async apply(ctx: Context<any>, raw: Record<string, unknown> = {}) {
      const paths = ctx.maybe('leoPaths') as (ConfigPaths & { cwd?: string }) | undefined
      const config = await loadConfig(paths, raw ?? {})
      const reg = new Interaction(config, async (persona) => {
        if (!paths) return
        if (await persistPersona(paths, persona)) void ctx.emit('plugin/data-written' as never, { plugin: PLUGIN_NAME } as never)
      })
      ctx.provide('interaction' as never, reg as never)

      const context = ctx.get('context' as never) as unknown as ContextServiceLike
      await ctx.effect(() =>
        context.registerSection({
          id: 'interaction.persona',
          layer: 'agent',
          priority: 10,
          render: (input) => {
            const p = reg.activePersona()
            if (!p) return undefined
            return personaSection(p, { model: input.model, cwd: paths?.cwd ?? process.cwd(), date: new Date().toISOString().slice(0, 10) })
          },
        }),
      )
      await ctx.effect(() => context.registerSection({ id: 'interaction.stickers', layer: 'agent', priority: 20, render: () => reg.stickerGuidance() }))

      // send_sticker：表情列表变化时重新注册（enum 跟着变）
      const tools = ctx.get('tools' as never) as unknown as ToolsLike
      let off: Disposer | undefined
      const sync = () => {
        off?.()
        off = undefined
        if (reg.config.stickers.enabled && reg.config.stickers.maxPerTurn > 0 && reg.agentStickers().length) off = tools.register(stickerTool(reg))
      }
      await ctx.effect(() => {
        const stop = reg.onChange(sync)
        return () => {
          stop()
          off?.()
          off = undefined
        }
      })

      const commands = ctx.maybe('commands' as never) as unknown as CommandsLike | undefined
      if (commands) {
        await ctx.effect(() =>
          commands.register({
            name: 'persona',
            usage: '[<id> | off | auto]',
            description: '查看或切换人设（写回 interaction.json）',
            plugin: 'interaction',
            run: async ({ argv }) => {
              if (!argv[0]) return { text: personaCommandText(reg) }
              const p = await reg.setPersona(argv[0], { persist: true })
              return { text: p ? `已切换人设：${p.name}（新消息起生效）` : '已关闭人设' }
            },
          }),
        )
        await ctx.effect(() =>
          commands.register({
            name: 'sticker',
            usage: '<id> [角色]',
            description: '发一个表情',
            plugin: 'interaction',
            run: ({ argv }) => {
              if (!argv[0]) return { text: stickersCommandText(reg) }
              const sent = reg.send(argv[0], 'user', argv[1])
              return {
                display: reg.display(sent),
                ...(reg.config.stickers.userPrompt ? { prompt: `[我发了一个表情：「${sent.text}」（${sent.ref} · ${sent.variant}）]` } : {}),
              }
            },
          }),
        )
        await ctx.effect(() =>
          commands.register({ name: 'stickers', description: '列出可以发的表情', plugin: 'interaction', run: () => ({ text: stickersCommandText(reg) }) }),
        )
      }
    },
  }
}

const plugin = createInteractionPlugin()
export default plugin
