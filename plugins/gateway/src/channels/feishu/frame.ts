/**
 * 飞书长连接的帧格式（pbbp2.Frame，protobuf）。只实现用到的字段，避免引入 protobuf 依赖。
 *
 * message Header { required string key = 1; required string value = 2; }
 * message Frame {
 *   required uint64 SeqID = 1; required uint64 LogID = 2;
 *   required int32 service = 3; required int32 method = 4;   // method 0 = 控制帧（ping/pong），1 = 数据帧（事件）
 *   repeated Header headers = 5;
 *   optional string payload_encoding = 6; optional string payload_type = 7;
 *   optional bytes payload = 8; optional string LogIDNew = 9;
 * }
 */

export const FRAME_CONTROL = 0
export const FRAME_DATA = 1

export interface Frame {
  seqId: bigint
  logId: bigint
  service: number
  method: number
  headers: Record<string, string>
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  logIdNew?: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function varint(out: number[], v: bigint): void {
  let x = BigInt.asUintN(64, v)
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80)
    x >>= 7n
  }
  out.push(Number(x))
}

function bytesField(out: number[], field: number, data: Uint8Array): void {
  varint(out, BigInt((field << 3) | 2))
  varint(out, BigInt(data.length))
  for (const b of data) out.push(b)
}

function varintField(out: number[], field: number, v: bigint): void {
  varint(out, BigInt(field << 3))
  varint(out, v)
}

export function encodeFrame(f: Frame): Uint8Array {
  const out: number[] = []
  varintField(out, 1, f.seqId)
  varintField(out, 2, f.logId)
  varintField(out, 3, BigInt(f.service))
  varintField(out, 4, BigInt(f.method))
  for (const [key, value] of Object.entries(f.headers)) {
    const h: number[] = []
    bytesField(h, 1, enc.encode(key))
    bytesField(h, 2, enc.encode(value))
    bytesField(out, 5, Uint8Array.from(h))
  }
  if (f.payloadEncoding !== undefined) bytesField(out, 6, enc.encode(f.payloadEncoding))
  if (f.payloadType !== undefined) bytesField(out, 7, enc.encode(f.payloadType))
  if (f.payload !== undefined) bytesField(out, 8, f.payload)
  if (f.logIdNew !== undefined) bytesField(out, 9, enc.encode(f.logIdNew))
  return Uint8Array.from(out)
}

class Reader {
  pos = 0
  constructor(readonly buf: Uint8Array) {}
  get done() {
    return this.pos >= this.buf.length
  }
  varint(): bigint {
    let shift = 0n
    let result = 0n
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('truncated varint')
      const b = this.buf[this.pos++]!
      result |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return result
      shift += 7n
      if (shift > 70n) throw new Error('varint too long')
    }
  }
  bytes(): Uint8Array {
    const len = Number(this.varint())
    if (this.pos + len > this.buf.length) throw new Error('truncated bytes')
    const b = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return b
  }
  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 2) this.bytes()
    else if (wire === 1) this.pos += 8
    else if (wire === 5) this.pos += 4
    else throw new Error(`unsupported wire type ${wire}`)
  }
}

function decodeHeader(buf: Uint8Array): [string, string] {
  const r = new Reader(buf)
  let key = ''
  let value = ''
  while (!r.done) {
    const tag = Number(r.varint())
    const field = tag >> 3
    if (field === 1 && (tag & 7) === 2) key = dec.decode(r.bytes())
    else if (field === 2 && (tag & 7) === 2) value = dec.decode(r.bytes())
    else r.skip(tag & 7)
  }
  return [key, value]
}

export function decodeFrame(buf: Uint8Array): Frame {
  const r = new Reader(buf)
  const f: Frame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: {} }
  while (!r.done) {
    const tag = Number(r.varint())
    const field = tag >> 3
    const wire = tag & 7
    switch (field) {
      case 1:
        f.seqId = r.varint()
        break
      case 2:
        f.logId = r.varint()
        break
      case 3:
        f.service = Number(BigInt.asIntN(32, r.varint()))
        break
      case 4:
        f.method = Number(BigInt.asIntN(32, r.varint()))
        break
      case 5: {
        const [k, v] = decodeHeader(r.bytes())
        f.headers[k] = v
        break
      }
      case 6:
        f.payloadEncoding = dec.decode(r.bytes())
        break
      case 7:
        f.payloadType = dec.decode(r.bytes())
        break
      case 8:
        f.payload = r.bytes().slice()
        break
      case 9:
        f.logIdNew = dec.decode(r.bytes())
        break
      default:
        r.skip(wire)
    }
  }
  return f
}
