import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeoFromConfig } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import subAgents, { parseAgentMarkdown } from '../src/index.js'

describe('parseAgentMarkdown', () => {
  it('解析 front matter 与正文', () => {
    const { name, profile } = parseAgentMarkdown(
      `---
name: explorer
description: "只读调研"   # 注释
model: deepseek/deepseek-chat
tools: read_file, grep
maxSteps: 20
---
你是只读调研助手。
`,
      'file',
    )
    expect(name).toBe('explorer')
    expect(profile).toEqual({ description: '只读调研', model: 'deepseek/deepseek-chat', tools: ['read_file', 'grep'], maxSteps: 20, systemPrompt: '你是只读调研助手。' })
  })

  it('支持 [a, b] 与多行列表，名字默认取文件名', () => {
    expect(parseAgentMarkdown('---\ndescription: d\ntools: [a, "b"]\n---\n', 'x').profile.tools).toEqual(['a', 'b'])
    const r = parseAgentMarkdown('---\ndescription: d\ntools:\n  - a\n  - b\n---\n', 'reviewer')
    expect(r).toEqual({ name: 'reviewer', profile: { description: 'd', tools: ['a', 'b'] } })
  })

  it('缺少 description 或 front matter 时报错', () => {
    expect(() => parseAgentMarkdown('---\nmodel: m\n---\n', 'x')).toThrow()
    expect(() => parseAgentMarkdown('just text', 'x')).toThrow(/front matter/)
  })
})

describe('从 .leo/agents 与 ~/.leo/agents 加载', () => {
  it('优先级：general < 用户 < 项目 < 配置；无效文件被跳过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-sub-'))
    const home = join(root, 'home')
    await mkdir(join(home, 'agents'), { recursive: true })
    await mkdir(join(root, '.leo', 'agents'), { recursive: true })
    await writeFile(join(home, 'agents', 'explorer.md'), '---\ndescription: from user\n---\n')
    await writeFile(join(home, 'agents', 'writer.md'), '---\ndescription: user writer\n---\n')
    await writeFile(join(root, '.leo', 'agents', 'explorer.md'), '---\ndescription: from project\ntools: read_file\n---\nproject prompt')
    await writeFile(join(root, '.leo', 'agents', 'broken.md'), 'no front matter')
    await writeFile(join(root, '.leo', 'config.json'), JSON.stringify({ tools: { builtin: false }, logLevel: 'silent' }))

    const app = await createLeoFromConfig({
      cwd: root,
      userDir: home,
      env: {},
      plugins: [[subAgents, { agents: { writer: { description: 'from config' } } }]],
    })
    const profiles = app.leo.ctx.get('subAgents').profiles()
    expect(Object.keys(profiles).sort()).toEqual(['explorer', 'general', 'writer'])
    expect(profiles.explorer).toMatchObject({ description: 'from project', tools: ['read_file'], systemPrompt: 'project prompt' })
    expect(profiles.writer?.description).toBe('from config')
    expect(app.leo.ctx.get('tools').get('task')?.description).toContain('explorer: from project')
    await app.dispose()
  })

  it('loadAgentFiles: false 时不读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-sub-'))
    await mkdir(join(root, '.leo', 'agents'), { recursive: true })
    await writeFile(join(root, '.leo', 'agents', 'explorer.md'), '---\ndescription: x\n---\n')
    await writeFile(join(root, '.leo', 'config.json'), JSON.stringify({ tools: { builtin: false }, logLevel: 'silent' }))
    const app = await createLeoFromConfig({ cwd: root, userDir: join(root, 'home'), env: {}, plugins: [[subAgents, { loadAgentFiles: false }]] })
    expect(Object.keys(app.leo.ctx.get('subAgents').profiles())).toEqual(['general'])
    await app.dispose()
  })
})

describe('--init 模板', () => {
  it('templates/agents/explorer.md 是合法的子 Agent 定义', async () => {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(new URL('../templates/agents/explorer.md', import.meta.url), 'utf8')
    const { name, profile } = parseAgentMarkdown(text, 'explorer')
    expect(name).toBe('explorer')
    expect(profile.tools).toEqual(['read_file', 'list_dir', 'grep'])
    expect(profile.systemPrompt).not.toContain('leo plugin add')
  })
})
