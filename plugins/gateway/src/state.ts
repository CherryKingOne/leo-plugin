/**
 * 网关的持久状态（`<stateDir>/state.json`）：
 * - 会话路由表：会话键 → leo 会话 id（历史本身在 leo 的会话存储里），重启后同一个聊天继续同一段对话
 * - 已配对用户、待批准的配对请求
 *
 * 写入是原子的（临时文件 + rename），并做了合并写；文件权限 0600（含平台用户 id）。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChatType, PairingRequest, SessionSource } from './types.js'

export interface SessionRecord {
  sessionId: string
  origin: SessionSource
  createdAt: number
  updatedAt: number
  turns: number
}

interface StateFile {
  version: 1
  sessions: Record<string, SessionRecord>
  paired: Record<string, { name?: string; pairedAt: number; by?: string }>
  pending: PairingRequest[]
}

const empty = (): StateFile => ({ version: 1, sessions: {}, paired: {}, pending: [] })

export class GatewayState {
  private data: StateFile = empty()
  private writing: Promise<void> = Promise.resolve()
  private dirty = false
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly file: string | undefined) {}

  static fileIn(dir: string): string {
    return join(dir, 'state.json')
  }

  async load(): Promise<void> {
    if (!this.file) return
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StateFile>
      this.data = { ...empty(), ...parsed, version: 1 }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${this.file}: ${(err as Error).message}`)
    }
  }

  // —— 会话 ——
  session(key: string): SessionRecord | undefined {
    return this.data.sessions[key]
  }
  sessions(): [string, SessionRecord][] {
    return Object.entries(this.data.sessions)
  }
  putSession(key: string, rec: SessionRecord): void {
    this.data.sessions[key] = rec
    this.save()
  }
  touchSession(key: string, turns = 0): void {
    const rec = this.data.sessions[key]
    if (!rec) return
    rec.updatedAt = Date.now()
    rec.turns += turns
    this.save()
  }
  deleteSession(key: string): boolean {
    if (!this.data.sessions[key]) return false
    delete this.data.sessions[key]
    this.save()
    return true
  }

  // —— 配对 ——
  isPaired(user: string): boolean {
    return Boolean(this.data.paired[user])
  }
  pairedUsers(): string[] {
    return Object.keys(this.data.paired)
  }
  pair(user: string, name: string | undefined, by: string | undefined): void {
    this.data.paired[user] = { ...(name ? { name } : {}), pairedAt: Date.now(), ...(by ? { by } : {}) }
    this.data.pending = this.data.pending.filter((p) => p.user !== user)
    this.save()
  }
  unpair(user: string): boolean {
    if (!this.data.paired[user]) return false
    delete this.data.paired[user]
    this.save()
    return true
  }
  pending(now = Date.now()): PairingRequest[] {
    const before = this.data.pending.length
    this.data.pending = this.data.pending.filter((p) => p.expiresAt > now)
    if (this.data.pending.length !== before) this.save()
    return [...this.data.pending]
  }
  /** 为用户取得（或新建）配对码；超过账号上限时返回 undefined */
  requestPairing(input: { user: string; userName?: string; account: string; chatId: string }, ttlMs: number, maxPerAccount: number): PairingRequest | undefined {
    const now = Date.now()
    const live = this.pending(now)
    const existing = live.find((p) => p.user === input.user)
    if (existing) return existing
    if (live.filter((p) => p.account === input.account).length >= maxPerAccount) return undefined
    const req: PairingRequest = { code: pairingCode(), ...input, createdAt: now, expiresAt: now + ttlMs }
    this.data.pending.push(req)
    this.save()
    return req
  }
  takePairing(code: string): PairingRequest | undefined {
    const norm = code.trim().toUpperCase()
    const req = this.pending().find((p) => p.code === norm)
    if (!req) return undefined
    this.data.pending = this.data.pending.filter((p) => p !== req)
    this.save()
    return req
  }

  // —— 写盘 ——
  private save(): void {
    if (!this.file) return
    this.dirty = true
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 50)
    this.timer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const file = this.file
    if (!file || !this.dirty) return this.writing
    this.dirty = false
    const body = `${JSON.stringify(this.data, null, 2)}\n`
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, body, { mode: 0o600 })
      await rename(tmp, file)
    })
    return this.writing.catch(() => {})
  }
}

/** 6 位配对码，去掉易混淆字符 */
function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(6)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

/**
 * 会话键：`<channel>:<account>:<chatType>:<chatId>[:t<threadId>][:u<userId>]`
 * - 私聊：每个聊天一个会话
 * - 群聊 / 频道：默认每个用户一个会话（groupPerUser），可改为整个群共享
 * - 话题：默认整个话题共享（threadPerUser=false）
 * 不要手动拼接会话键，统一用这个函数。
 */
export function sessionKey(src: Pick<SessionSource, 'channel' | 'account' | 'chatType' | 'chatId' | 'threadId' | 'userId'>, opts: { groupPerUser: boolean; threadPerUser: boolean }): string {
  const esc = (s: string) => s.replace(/[:\s]/g, '_')
  let key = `${esc(src.channel)}:${esc(src.account)}:${src.chatType}:${esc(src.chatId)}`
  if (src.threadId) key += `:t${esc(src.threadId)}`
  if (isShared(src.chatType, src.threadId, opts) === false && src.chatType !== 'direct') key += `:u${esc(src.userId)}`
  return key
}

/** 多人共享的会话（群里多个人共用一个上下文）：消息前面要加发送者名字 */
export function isShared(chatType: ChatType, threadId: string | undefined, opts: { groupPerUser: boolean; threadPerUser: boolean }): boolean {
  if (chatType === 'direct') return false
  if (threadId) return !opts.threadPerUser
  return !opts.groupPerUser
}

/** 会话键 → 合法的 leo 会话 id（文件名安全），带随机后缀保证 /new 之后是新会话 */
export function newSessionId(key: string): string {
  const base = key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  return `gw-${base}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}
