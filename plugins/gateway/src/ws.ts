/**
 * 最小 WebSocket 服务端（RFC 6455），只为控制面 JSON 文本帧服务，不引入第三方依赖：
 * 握手、文本帧（含分片）、ping/pong、close；单帧上限 maxPayload，超出即关闭。
 * 不支持扩展（permessage-deflate）与二进制消息。
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WsConnection {
  send(text: string): void
  close(code?: number, reason?: string): void
  readonly closed: boolean
  remote: string
}

export interface WsHandlers {
  onMessage(conn: WsConnection, text: string): void
  onClose?(conn: WsConnection): void
}

/** 完成握手并开始收发；返回 false 表示不是合法的 WebSocket 升级请求（调用方应回 400） */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, handlers: WsHandlers, maxPayload = 4_194_304): boolean {
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') return false
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))

  let buf: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragmentSize = 0
  let closed = false

  const frame = (opcode: number, payload: Buffer) => {
    const len = payload.length
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    header[0] = 0x80 | opcode
    if (len < 126) header[1] = len
    else if (len < 65536) {
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    socket.write(Buffer.concat([header, payload]))
  }

  const conn: WsConnection = {
    remote: req.socket.remoteAddress ?? '',
    get closed() {
      return closed
    },
    send(text) {
      if (!closed) frame(0x1, Buffer.from(text, 'utf8'))
    },
    close(code = 1000, reason = '') {
      if (closed) return
      closed = true
      const r = Buffer.from(reason.slice(0, 120), 'utf8')
      const p = Buffer.alloc(2 + r.length)
      p.writeUInt16BE(code, 0)
      r.copy(p, 2)
      try {
        frame(0x8, p)
      } catch {}
      socket.end()
      handlers.onClose?.(conn)
    },
  }

  const parse = () => {
    while (buf.length >= 2) {
      const b0 = buf[0]!
      const b1 = buf[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(maxPayload)) return conn.close(1009, 'message too big')
        len = Number(big)
        off = 10
      }
      if (!masked) return conn.close(1002, 'client frames must be masked')
      if (len > maxPayload) return conn.close(1009, 'message too big')
      if (buf.length < off + 4 + len) return
      const mask = buf.subarray(off, off + 4)
      const payload = Buffer.alloc(len)
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i]! ^ mask[i % 4]!
      buf = buf.subarray(off + 4 + len)

      if (opcode === 0x8) return conn.close(1000)
      if (opcode === 0x9) {
        frame(0xa, payload)
        continue
      }
      if (opcode === 0xa) continue
      if (opcode === 0x2) return conn.close(1003, 'binary frames are not supported')
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1 && fragments.length) return conn.close(1002, 'unexpected text frame')
        if (opcode === 0x0 && !fragments.length) return conn.close(1002, 'unexpected continuation')
        fragments.push(payload)
        fragmentSize += payload.length
        if (fragmentSize > maxPayload) return conn.close(1009, 'message too big')
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf8')
          fragments = []
          fragmentSize = 0
          try {
            handlers.onMessage(conn, text)
          } catch {
            conn.close(1011, 'internal error')
          }
        }
        continue
      }
      return conn.close(1002, 'unknown opcode')
    }
  }

  socket.on('data', (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d
    if (buf.length > maxPayload + 14) return conn.close(1009, 'message too big')
    parse()
  })
  socket.on('close', () => {
    if (closed) return
    closed = true
    handlers.onClose?.(conn)
  })
  socket.on('error', () => socket.destroy())
  if (buf.length) parse()
  return true
}
