/**
 * 读取机器人配置目录 `chat-channels/`：
 *
 *   ~/.leo/chat-channels/<渠道>.json      用户级
 *   <项目>/.leo/chat-channels/<渠道>.json 项目级（同名机器人覆盖用户级）
 *
 * 文件名就是渠道 id（qq.json、feishu.json、telegram.json …），内容是这个渠道的机器人配置，支持 JSONC 注释。
 *
 * 单个机器人：直接写这个渠道的机器人配置，账号 id = 渠道 id
 *   { "appId": "102xxx", "appSecret": "$QQ_BOT_SECRET" }
 *
 * 多个机器人：放在 bots 下，账号 id = `<渠道>-<名称>`
 *   { "bots": { "main": { ... }, "test": { ... } } }
 *
 * 机器人对象里的 enabled / allowFrom / allowChats / requireMention / autoReply 是注册层的通用字段，
 * 其余字段全部作为该渠道的 options，由渠道自己的 schema 校验。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountInput } from './config.js'

const COMMON_KEYS = ['enabled', 'allowFrom', 'allowChats', 'requireMention', 'autoReply'] as const
const ID = /^[a-z][a-z0-9-]{0,63}$/

export interface FileAccount {
  account: AccountInput
  file: string
}

/** 去掉 JSONC 的注释与尾随逗号（字符串内容保持不变） */
export function stripJsonc(text: string): string {
  let src = ''
  for (let i = 0, inStr = false; i < text.length; ) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inStr) {
      src += ch
      if (ch === '\\') {
        src += next ?? ''
        i += 2
        continue
      }
      if (ch === '"') inStr = false
      i++
    } else if (ch === '"') {
      inStr = true
      src += ch
      i++
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
    } else {
      src += ch
      i++
    }
  }
  let out = ''
  for (let i = 0, inStr = false; i < src.length; i++) {
    const ch = src[i]!
    if (inStr) {
      out += ch
      if (ch === '\\') out += src[++i] ?? ''
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    if (ch === ',') {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j]!)) j++
      if (src[j] === '}' || src[j] === ']') continue
    }
    out += ch
  }
  return out
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 把文件里的一个机器人对象拆成 通用字段 + 渠道 options */
export function toAccount(channel: string, bot: Record<string, unknown>): AccountInput {
  const options: Record<string, unknown> = {}
  const account: Record<string, unknown> = { channel, options }
  for (const [k, v] of Object.entries(bot)) {
    if ((COMMON_KEYS as readonly string[]).includes(k)) account[k] = v
    else options[k] = v
  }
  return account as AccountInput
}

/** 解析一个渠道文件的内容，返回 账号 id → 账号配置 */
export function parseChannelFile(channel: string, data: unknown, file: string): Record<string, AccountInput> {
  if (!isObject(data)) throw new Error(`${file}: must be a JSON object`)
  if (!('bots' in data)) return { [channel]: toAccount(channel, data) }
  const bots = data.bots
  if (!isObject(bots)) throw new Error(`${file}: "bots" must be an object`)
  const out: Record<string, AccountInput> = {}
  for (const [name, bot] of Object.entries(bots)) {
    const id = `${channel}-${name}`
    if (!ID.test(id)) throw new Error(`${file}: bot name "${name}" must be kebab-case`)
    if (!isObject(bot)) throw new Error(`${file}: bots.${name} must be an object`)
    out[id] = toAccount(channel, bot)
  }
  return out
}

async function readDir(dir: string, onError: (file: string, err: Error) => void): Promise<Record<string, FileAccount>> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    onError(dir, err as Error)
    return {}
  }
  const out: Record<string, FileAccount> = {}
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('_') || name.startsWith('.')) continue
    const channel = name.slice(0, -'.json'.length)
    const file = join(dir, name)
    try {
      if (!ID.test(channel)) throw new Error(`file name must be a kebab-case channel id (e.g. qq.json)`)
      const data = JSON.parse(stripJsonc(await readFile(file, 'utf8')))
      for (const [id, account] of Object.entries(parseChannelFile(channel, data, file))) out[id] = { account, file }
    } catch (err) {
      onError(file, err as Error)
    }
  }
  return out
}

/** 按 用户级 → 项目级 → 自定义目录 的顺序读取，后者覆盖前者 */
export async function loadBotFiles(dirs: (string | undefined)[], onError: (file: string, err: Error) => void): Promise<Record<string, FileAccount>> {
  const out: Record<string, FileAccount> = {}
  for (const dir of dirs) if (dir) Object.assign(out, await readDir(dir, onError))
  return out
}
