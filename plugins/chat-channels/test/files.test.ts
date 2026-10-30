import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeo } from 'leo-agents'
import { afterEach, describe, expect, it } from 'vitest'
import { parseChannelFile, stripJsonc } from '../src/files.js'
import { createChatChannelsPlugin } from '../src/index.js'

const offline = (async () => new Response('{}', { status: 503 })) as typeof fetch
const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe('机器人配置文件', () => {
  it('单个机器人：账号 id = 渠道；通用字段与渠道 options 分开', () => {
    expect(parseChannelFile('qq', { appId: '1', appSecret: '$S', allowFrom: ['u'], requireMention: false }, 'qq.json')).toEqual({
      qq: { channel: 'qq', options: { appId: '1', appSecret: '$S' }, allowFrom: ['u'], requireMention: false },
    })
  })

  it('多个机器人：bots 下的名称变成 <渠道>-<名称>', () => {
    const r = parseChannelFile('feishu', { bots: { main: { appId: 'a' }, test: { appId: 'b', enabled: false } } }, 'feishu.json')
    expect(Object.keys(r)).toEqual(['feishu-main', 'feishu-test'])
    expect(r['feishu-test']).toEqual({ channel: 'feishu', options: { appId: 'b' }, enabled: false })
    expect(() => parseChannelFile('feishu', { bots: { Bad_Name: {} } }, 'f.json')).toThrow(/kebab-case/)
  })

  it('JSONC 注释与尾随逗号', () => {
    expect(JSON.parse(stripJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,], }'))).toEqual({ a: 'http://x', b: [1] })
  })

  it('从目录加载 .leo/chat-channels/*.json；坏文件不影响其他机器人；插件配置同名优先', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-channels-'))
    dirs.push(dir)
    await writeFile(join(dir, 'qq.json'), '{\n  // QQ 机器人\n  "appId": "102", "appSecret": "$QQ_SECRET",\n}')
    await writeFile(join(dir, 'telegram.json'), JSON.stringify({ bots: { main: { botToken: '$A' }, test: { botToken: '$B', allowFrom: 'oops' } } }))
    await writeFile(join(dir, 'feishu.json'), '{ not json')
    await writeFile(join(dir, '_example.json'), '{}')
    await writeFile(join(dir, 'README.md'), '# ignored')

    const leo = await createLeo({
      logLevel: 'silent',
      plugins: [[createChatChannelsPlugin({ fetch: offline }), { botsDir: dir, accounts: { 'telegram-main': { channel: 'telegram', enabled: false } } }]],
    })
    const accounts = Object.fromEntries(leo.ctx.get('chatChannels').accounts().map((a) => [a.account, a]))
    expect(Object.keys(accounts).sort()).toEqual(['qq', 'telegram-main', 'telegram-test'])
    expect(accounts.qq!.channel).toBe('qq')
    expect(accounts['telegram-main']!.state).toBe('disabled') // 插件配置覆盖了文件
    expect(accounts['telegram-test']).toMatchObject({ state: 'failed' })
    expect(accounts['telegram-test']!.error).toMatch(/allowFrom/)
    await leo.dispose()
  })

  it('loadBotFiles=false 且无 botsDir 时不读目录', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [[createChatChannelsPlugin({ fetch: offline }), { loadBotFiles: false }]] })
    expect(leo.ctx.get('chatChannels').accounts()).toEqual([])
    await leo.dispose()
  })
})
