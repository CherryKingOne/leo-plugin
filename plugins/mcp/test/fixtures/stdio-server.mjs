#!/usr/bin/env node
// 假 MCP stdio 服务器。用法：node stdio-server.mjs <modern|legacy|dual> [--silent-probe] [--exit-on-unknown] [--page=N]
import { createInterface } from 'node:readline'
import { createServer } from './server-core.mjs'

const era = process.argv[2] ?? 'dual'
const silentProbe = process.argv.includes('--silent-probe') // legacy：不回应未初始化前的未知请求
const exitOnUnknown = process.argv.includes('--exit-on-unknown') // legacy：收到 initialize 前的请求直接退出
const page = Number((process.argv.find((a) => a.startsWith('--page=')) ?? '--page=0').slice(7))
const server = createServer({ era, pageSize: page })
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`)
process.stderr.write(`fake server starting (${era})\n`)

let initSeen = false
const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') initSeen = true
  if (era === 'legacy' && !initSeen && msg.id !== undefined) {
    if (exitOnUnknown) process.exit(3)
    if (silentProbe) return
  }
  if (msg.method === 'tools/call' && msg.params?.name === 'crash') process.exit(1)
  if (msg.method === 'tools/call' && msg.params?.name === 'ping_me') {
    // legacy：服务器主动发 ping，再返回结果
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' })
  }
  const res = await server.handle(msg, { notify: send })
  if (res) send(res)
})
rl.on('close', () => process.exit(0))
