// 假 MCP HTTP 服务器：
//   kind 'modern'     2026-07-28 Streamable HTTP（无会话、校验镜像头）
//   kind 'legacy'     2025-11-25 Streamable HTTP（Mcp-Session-Id，SSE 响应）
//   kind 'sse'        2024-11-05 HTTP+SSE（GET /sse → endpoint 事件，POST /messages）
import { createServer as createHttp } from 'node:http'
import { createServer } from './server-core.mjs'

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)) })

export async function startHttpServer(kind, { sse = false } = {}) {
  const requests = []
  const sessions = new Map()
  const modernServer = createServer({ era: 'modern' })
  const sseClients = new Map()
  let sessionSeq = 0

  const http = createHttp(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const body = req.method === 'POST' ? await readBody(req) : ''
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body })

    if (kind === 'modern') {
      if (req.method !== 'POST') return void res.writeHead(405).end()
      const msg = JSON.parse(body)
      const pv = req.headers['mcp-protocol-version']
      const bodyPv = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion']
      if (!pv || !bodyPv) return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32020, message: 'missing MCP-Protocol-Version' } }))
      if (pv !== bodyPv || req.headers['mcp-method'] !== msg.method) return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: 'Header mismatch' } }))
      if (msg.method === 'tools/call' && req.headers['mcp-name'] !== msg.params.name) return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: 'Mcp-Name mismatch' } }))
      if (msg.method === 'tools/call' && msg.params.name === 'region' && msg.params.arguments?.region !== undefined && req.headers['mcp-param-region'] !== msg.params.arguments.region) {
        return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: 'Mcp-Param-Region mismatch' } }))
      }
      if (sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const out = await modernServer.handle(msg, { headers: req.headers, notify: (n) => res.write(`data: ${JSON.stringify(n)}\n\n`) })
        if (out?.error?.code === -32022) { /* 已开流则仍在流内返回 */ }
        res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`)
        return
      }
      const out = await modernServer.handle(msg, { headers: req.headers, notify() {} })
      const status = out?.error?.code === -32022 ? 400 : 200
      return void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    }

    if (kind === 'legacy') {
      if (req.method === 'DELETE') {
        sessions.delete(req.headers['mcp-session-id'])
        return void res.writeHead(200).end()
      }
      if (req.method === 'GET') return void res.writeHead(405).end()
      const msg = JSON.parse(body)
      let sid = req.headers['mcp-session-id']
      if (msg.method === 'initialize') {
        sid = `s${++sessionSeq}`
        sessions.set(sid, createServer({ era: 'legacy' }))
      } else if (!sid || !sessions.has(sid)) {
        const code = sid ? 404 : 400
        return void res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } }))
      }
      const server = sessions.get(sid)
      if (msg.id === undefined || msg.result !== undefined || msg.error !== undefined) {
        await server.handle(msg)
        return void res.writeHead(202, { 'mcp-session-id': sid }).end()
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': sid })
      const out = await server.handle(msg, { headers: req.headers, notify: (n) => res.write(`event: message\ndata: ${JSON.stringify(n)}\n\n`) })
      res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`)
      return
    }

    // 2024-11-05 HTTP+SSE
    if (url.pathname === '/sse' && req.method === 'GET') {
      const id = `c${++sessionSeq}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`)
      sseClients.set(id, { res, server: createServer({ era: 'legacy' }) })
      req.on('close', () => sseClients.delete(id))
      return
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const c = sseClients.get(url.searchParams.get('sessionId'))
      if (!c) return void res.writeHead(404).end('no session')
      res.writeHead(202).end('Accepted')
      const msg = JSON.parse(body)
      const out = await c.server.handle(msg, { headers: req.headers, notify: (n) => c.res.write(`event: message\ndata: ${JSON.stringify(n)}\n\n`) })
      if (out) c.res.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`)
      return
    }
    res.writeHead(404).end('not found')
  })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  const { port } = http.address()
  return {
    url: kind === 'sse' ? `http://127.0.0.1:${port}/sse` : `http://127.0.0.1:${port}/mcp`,
    requests,
    sessions,
    close: () => new Promise((r) => { for (const c of sseClients.values()) c.res.end(); http.closeAllConnections?.(); http.close(() => r()) }),
  }
}
