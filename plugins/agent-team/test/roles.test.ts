import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { createLeo, createLeoFromConfig } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import agentTeam, { BUILTIN_ROLES, parseRoleMarkdown, resolveRoles } from '../src/index.js'
import { roleOf, setup, tmp, writeRole } from './helpers.js'

const limits = { leaderMaxSteps: 60, memberMaxSteps: 40 }
const pluginDir = new URL('..', import.meta.url).pathname

describe('角色 Markdown', () => {
  it('解析 front matter 与正文', () => {
    const { id, profile } = parseRoleMarkdown(
      `---
  # 注释行
name: 安全审查
description: 审查安全问题   # 行尾注释
model: deepseek/deepseek-flash
tools:
  - read_file
  - grep
maxSteps: 12
phase: qa
artifact: security.md
---
你是安全审查员。`,
      'security',
    )
    expect(id).toBe('security')
    expect(profile).toEqual({
      name: '安全审查',
      description: '审查安全问题',
      model: 'deepseek/deepseek-flash',
      tools: ['read_file', 'grep'],
      maxSteps: 12,
      phase: 'qa',
      artifact: 'security.md',
      systemPrompt: '你是安全审查员。',
    })
    expect(parseRoleMarkdown('---\ntools: [a, b]\ndisabled: true\n---\n', 'x').profile).toEqual({ tools: ['a', 'b'], disabled: true })
    expect(() => parseRoleMarkdown('no front matter', 'x')).toThrow(/front matter/)
    expect(() => parseRoleMarkdown('---\nphase: nope\n---\n', 'x')).toThrow()
    expect(() => parseRoleMarkdown('---\ndescription: x\n---\n', 'Bad Name')).toThrow(/invalid role id/)
  })

  it('templates/team/*.md 与内置角色一致', async () => {
    for (const [id, builtin] of Object.entries(BUILTIN_ROLES)) {
      const text = await readFile(join(pluginDir, 'templates', 'team', `${id}.md`), 'utf8')
      const { profile } = parseRoleMarkdown(text, id)
      expect(profile, id).toEqual(builtin)
    }
    const manifest = JSON.parse(await readFile(join(pluginDir, 'leo-plugin.json'), 'utf8'))
    expect(manifest.init.files.map((f: { path: string }) => f.path)).toEqual((agentTeam as { watch?: string[] }).watch)
  })
})

describe('角色合并', () => {
  it('内置 < 全局文件 < 项目文件 < 配置，字段级覆盖；可删除、可新增；leader 不能删', () => {
    const roles = resolveRoles(
      [
        { source: '~/.leo/team/pm.md', roles: { pm: { model: 'global-model', maxSteps: 5 } } },
        { source: '.leo/team/pm.md', roles: { pm: { model: 'project-model' } } },
        { source: '.leo/team/qa.md', roles: { qa: { disabled: true } } },
        { source: 'config', roles: { designer: false, leader: false, security: { description: '安全审查', phase: 'qa', tools: ['read_file'] } } },
      ],
      limits,
    )
    expect(Object.keys(roles)).toEqual(['leader', 'pm', 'tech-lead', 'dev', 'security'])
    expect(roles.pm).toMatchObject({ model: 'project-model', maxSteps: 5, phase: 'requirements', artifact: 'prd.md', name: '产品经理' })
    expect(roles.pm!.source).toEqual(['builtin', '~/.leo/team/pm.md', '.leo/team/pm.md'])
    expect(roles.security).toMatchObject({ name: 'security', phase: 'qa', tools: ['read_file'], maxSteps: 40 })
    expect(roles.leader!.maxSteps).toBe(60)
  })

  it('从 ~/.leo/team 与项目 .leo/team 读取；无效文件跳过；项目覆盖全局', async () => {
    const root = await tmp()
    const userDir = join(root, 'home')
    const projectDir = join(root, 'proj', '.leo')
    await writeRole(userDir, 'pm', '---\nmodel: global\nmaxSteps: 7\n---\n')
    await writeRole(projectDir, 'pm', '---\nmodel: project\n---\n项目 PM 提示')
    await writeRole(projectDir, 'designer', '---\ndisabled: true\n---\n')
    await writeRole(projectDir, 'broken', 'not a role file')
    await mkdir(join(projectDir, 'team', 'projects', 'p1'), { recursive: true })
    await writeFile(join(projectDir, 'team', 'projects', 'p1', 'state.json'), '{}')
    const leo = await createLeo({
      logLevel: 'silent',
      plugins: [{ name: 'paths', apply: (ctx) => void ctx.provide('leoPaths' as never, { cwd: root, userDir, projectDir } as never) }, agentTeam],
    })
    const roles = leo.ctx.get('agentTeam').roles()
    expect(Object.keys(roles)).toEqual(['leader', 'pm', 'tech-lead', 'dev', 'qa'])
    expect(roles.pm).toMatchObject({ model: 'project', maxSteps: 7, systemPrompt: '项目 PM 提示' })
    await leo.dispose()
  })

  it('loadRoleFiles: false 时不读文件', async () => {
    const root = await tmp()
    await writeRole(root, 'pm', '---\nmodel: file\n---\n')
    const leo = await createLeo({
      logLevel: 'silent',
      plugins: [{ name: 'paths', apply: (ctx) => void ctx.provide('leoPaths' as never, { cwd: root, userDir: root } as never) }, [agentTeam, { loadRoleFiles: false }]],
    })
    expect(leo.ctx.get('agentTeam').roles().pm!.model).toBeUndefined()
    await leo.dispose()
  })

  it('角色文件的提示、模型、工具用于成员', async () => {
    const root = await tmp()
    await writeRole(root, 'pm', '---\nmodel: pm-model\ntools: read_file\n---\n你是挑剔的 PM。')
    const { leo, mock, team } = await setup({}, { paths: { userDir: root } })
    await team().start({ requirement: 'x' })
    const pmReq = mock.requests.find((q) => roleOf(q) === 'pm')!
    expect(pmReq.model).toBe('pm-model')
    expect(pmReq.system).toContain('你是挑剔的 PM。')
    expect((pmReq.tools ?? []).map((t) => t.name).filter((n) => !n.startsWith('team_'))).toEqual(['read_file'])
    await leo.dispose()
  })
})

describe('热加载（真实宿主 createLeoFromConfig）', () => {
  it('修改 .leo/team/<role>.md 后插件自动重新加载；写项目状态不会触发重新加载', async () => {
    const root = await tmp()
    const projectDir = join(root, '.leo')
    const userDir = join(root, 'home')
    await mkdir(join(projectDir, 'plugins'), { recursive: true })
    await mkdir(userDir, { recursive: true })
    await writeFile(join(projectDir, 'config.json'), JSON.stringify({ tools: { builtin: false } }))
    // 与发布时相同的方式打成单文件，放进 .leo/plugins/ 自动发现
    await build({
      entryPoints: [join(pluginDir, 'src', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['leo-agents'],
      outfile: join(projectDir, 'plugins', 'agent-team.bundle.js'),
      logLevel: 'silent',
    })
    await writeRole(projectDir, 'pm', '---\nmodel: v1\n---\n')

    const app = await createLeoFromConfig({ cwd: root, userDir, pluginPollMs: 50 })
    try {
      const svc = () => app.leo.ctx.get('agentTeam')
      expect(svc().roles().pm!.model).toBe('v1')

      // 插件写进 team/projects/ 的状态不在 watch 里
      await mkdir(join(projectDir, 'team', 'projects', 'p1'), { recursive: true })
      await writeFile(join(projectDir, 'team', 'projects', 'p1', 'state.json'), '{}')
      const quiet = await app.reloadPlugins()
      expect(quiet.changed).toEqual([])

      const loaded = new Promise<void>((resolve) => app.leo.ctx.on('plugin/loaded' as never, (() => resolve()) as never))
      await new Promise((r) => setTimeout(r, 20))
      await writeRole(projectDir, 'pm', '---\nmodel: v2\n---\n')
      await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error('no reload within 5s')), 5000))])
      expect(svc().roles().pm!.model).toBe('v2')
      // 新增默认角色的覆盖文件同样生效
      await writeRole(projectDir, 'designer', '---\ndisabled: true\n---\n')
      const r = await app.reloadPlugins()
      expect(r.failed).toEqual([])
      expect(Object.keys(svc().roles())).not.toContain('designer')
    } finally {
      await app.dispose()
    }
  }, 15_000)
})
