/**
 * stdio 传输：启动子进程，按行收发 JSON-RPC（各协议版本相同）。
 * 关闭顺序遵循规范：关闭 stdin → 等待退出 → SIGTERM → SIGKILL。
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { type JsonRpcMessage, parseMessages, TransportError } from '../jsonrpc.js'
import { StreamConnection } from './stream.js'

export interface StdioOptions {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** stderr 每行回调（服务器日志，不代表出错） */
  onStderr?(line: string): void
}

const STDERR_TAIL = 20
const GRACE_MS = 2_000

export class StdioConnection extends StreamConnection {
  readonly kind = 'stdio' as const
  private child?: ChildProcessWithoutNullStreams
  private readonly stderrTail: string[] = []
  private exited?: Promise<void>

  constructor(private readonly opts: StdioOptions) {
    super()
  }

  /** 启动进程；命令不存在等启动失败会抛出 */
  async start(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 下 npx 等是 .cmd，需要 shell
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    this.child = child
    this.exited = new Promise((resolve) => child.once('close', () => resolve()))

    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (line) for (const m of parseMessages(line)) this.dispatch(m)
      }
    })
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      err += chunk
      let nl: number
      while ((nl = err.indexOf('\n')) >= 0) {
        const line = err.slice(0, nl).trimEnd()
        err = err.slice(nl + 1)
        if (!line) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift()
        this.opts.onStderr?.(line)
      }
    })
    child.stdin.on('error', () => {}) // 进程退出后写入的 EPIPE 由 close 事件处理

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e) => reject(new TransportError(`failed to start "${this.opts.command}": ${e.message}`, { closed: true })))
    })
    child.once('close', (code, signal) => {
      const tail = this.diagnostics()
      this.terminate(new TransportError(`server process exited (${signal ?? `code ${code}`})${tail ? `\n${tail}` : ''}`, { closed: true }))
    })
  }

  protected async write(msg: JsonRpcMessage): Promise<void> {
    const child = this.child
    if (!child || this._closed || !child.stdin.writable) throw new TransportError('server process is not running', { closed: true })
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(msg)}\n`, (e) => (e ? reject(new TransportError(e.message, { closed: true })) : resolve()))
    })
  }

  diagnostics(): string {
    return this.stderrTail.length ? `stderr:\n${this.stderrTail.join('\n')}` : ''
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.terminate(new TransportError('connection closed', { closed: true }))
    if (child.exitCode !== null || child.signalCode !== null) return
    const wait = (ms: number) => Promise.race([this.exited!.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())])
    child.stdin.end()
    if (await wait(GRACE_MS)) return
    child.kill('SIGTERM')
    if (await wait(GRACE_MS)) return
    child.kill('SIGKILL')
    await wait(GRACE_MS)
  }
}
