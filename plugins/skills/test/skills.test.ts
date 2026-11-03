import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeo, type PluginDefinition } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import plugin, {
  BUILTIN_SKILLS,
  catalogSection,
  createSkillsPlugin,
  findSkills,
  materializeBuiltin,
  normalizeConfig,
  parseGitSource,
  parseSkillFile,
  readResource,
  SkillCatalog,
} from '../src/index.js'

const md = (name: string, description: string, extra = '', body = `# ${name}\n\nDo the ${name} thing.`) =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`

async function skill(root: string, dir: string, content: string, files: Record<string, string> = {}) {
  await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(root, dir, 'SKILL.md'), content)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, dir, rel, '..'), { recursive: true })
    await writeFile(join(root, dir, rel), text)
  }
}

const tmp = () => mkdtemp(join(tmpdir(), 'leo-skills-'))

describe('frontmatter', () => {
  it('普通字段、引号、布尔、块标量、跨行、跳过列表', () => {
    const { data, body, hasFrontmatter } = parseSkillFile(
      [
        '\uFEFF---',
        'name: pdf',
        'description: >',
        '  Read and write PDFs.',
        '  Use for forms.',
        'license: "Apache-2.0"',
        "argument-hint: 'it''s ok'",
        'disable-model-invocation: true',
        'user-invocable: false # 注释',
        'allowed-tools:',
        '  - Bash',
        '  - Read',
        'metadata:',
        '  version: 1',
        'long: first line',
        '  second line',
        'keep: |',
        '  a',
        '  b',
        '---',
        'Body here',
      ].join('\r\n'),
    )
    expect(hasFrontmatter).toBe(true)
    expect(data).toMatchObject({
      name: 'pdf',
      description: 'Read and write PDFs. Use for forms.\n',
      license: 'Apache-2.0',
      'argument-hint': "it's ok",
      'disable-model-invocation': true,
      'user-invocable': false,
      long: 'first line second line',
      keep: 'a\nb\n',
    })
    expect(data['allowed-tools']).toBeUndefined()
    expect(body.trim()).toBe('Body here')
  })

  it('没有 frontmatter', () => {
    expect(parseSkillFile('# hi\n').hasFrontmatter).toBe(false)
    expect(parseSkillFile('---\nname: x\n').hasFrontmatter).toBe(false)
  })

  it('内置的 skill-creator 能解析', () => {
    const { data } = parseSkillFile(BUILTIN_SKILLS['skill-creator']!['SKILL.md']!.text)
    expect(data.name).toBe('skill-creator')
    expect(String(data.description)).toMatch(/Create new skills/)
  })
})

describe('目录', () => {
  it('优先级：项目 > 自定义 > 用户 > 内置；禁用、诊断、隐藏目录', async () => {
    const d = await tmp()
    const [project, custom, user, builtin] = ['project', 'custom', 'user', 'user/.builtin'].map((x) => join(d, x)) as [string, string, string, string]
    await skill(builtin, 'skill-creator', md('skill-creator', 'builtin creator'))
    await skill(builtin, 'shared', md('shared', 'from builtin'))
    await skill(user, 'shared', md('shared', 'from user'))
    await skill(user, 'mine', md('mine', 'only user', 'disable-model-invocation: true\n'))
    await skill(custom, 'claude-one', md('claude-one', 'from claude dir'))
    await skill(project, 'shared', md('shared', 'from project'))
    await skill(user, 'broken', '# no frontmatter\n')
    await skill(user, 'Bad_Name', md('Bad_Name', 'x'))
    await skill(user, 'nodesc', '---\nname: nodesc\n---\nhi\n')
    await mkdir(join(user, 'not-a-skill'), { recursive: true })
    await writeFile(join(user, 'README.md'), 'hello')
    await symlink(join(custom, 'claude-one'), join(user, 'linked'))

    const cat = new SkillCatalog(() => [
      { source: 'project', dir: project },
      { source: 'custom', dir: custom },
      { source: 'user', dir: user },
      { source: 'builtin', dir: builtin },
    ])
    const snap = await cat.snapshot(['skill-creator'])
    expect(snap.skills.map((s) => `${s.name}:${s.source}`)).toEqual(['claude-one:custom', 'mine:user', 'shared:project', 'skill-creator:builtin'])
    expect(snap.skills.find((s) => s.name === 'shared')!.description).toBe('from project')
    expect(snap.skills.find((s) => s.name === 'skill-creator')!.disabled).toBe(true)
    expect(snap.skills.find((s) => s.name === 'mine')!.modelInvocable).toBe(false)
    expect(snap.shadowed.map((s) => `${s.name}:${s.source}:${s.shadowedBy}`).sort()).toEqual([
      'claude-one:user:custom',
      'shared:builtin:project',
      'shared:user:project',
    ])
    const diag = snap.diagnostics.map((x) => x.message).join('\n')
    for (const re of [/frontmatter/, /不合法/, /缺少 description/]) expect(diag).toMatch(re)

    const section = catalogSection(snap.skills, 500)!
    expect(section).toContain('<skill><name>shared</name><description>from project</description></skill>')
    expect(section).not.toContain('mine') // 仅手动
    expect(section).not.toContain('skill-creator') // 已禁用
    expect(section).not.toContain(project) // 不放路径
    expect(catalogSection([], 500)).toBeUndefined()

    // 改了文件会重新读
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(project, 'shared', 'SKILL.md'), md('shared', 'changed & <new>'))
    const again = await cat.snapshot()
    expect(again.skills.find((s) => s.name === 'shared')!.description).toBe('changed & <new>')
    expect(catalogSection(again.skills)).toContain('changed &amp; &lt;new&gt;')
  })

  it('资源文件只能读技能目录里的', async () => {
    const d = await tmp()
    await skill(d, 'pdf', md('pdf', 'pdf'), { 'references/forms.md': 'FORMS', 'scripts/run.py': 'print(1)' })
    await writeFile(join(d, 'secret.txt'), 'SECRET')
    await symlink(join(d, 'secret.txt'), join(d, 'pdf', 'escape.txt'))
    expect(await readResource(join(d, 'pdf'), 'references/forms.md')).toBe('FORMS')
    expect(await readResource(join(d, 'pdf'), 'references')).toMatch(/forms\.md/)
    await expect(readResource(join(d, 'pdf'), '../secret.txt')).rejects.toThrow(/不在技能目录/)
    await expect(readResource(join(d, 'pdf'), 'escape.txt')).rejects.toThrow(/不在技能目录/)
    await expect(readResource(join(d, 'pdf'), join(d, 'secret.txt'))).rejects.toThrow(/相对技能目录/)
    await expect(readResource(join(d, 'pdf'), 'nope.md')).rejects.toThrow(/没有/)
  })
})

describe('内置技能', () => {
  it('释放到 .builtin，指纹不变不重写，删掉不再内置的', async () => {
    const d = join(await tmp(), '.builtin')
    const r1 = await materializeBuiltin(d)
    expect(r1).toEqual({ written: true, names: ['skill-creator'] })
    expect(await readFile(join(d, 'skill-creator', 'SKILL.md'), 'utf8')).toMatch(/name: skill-creator/)
    expect((await stat(join(d, 'skill-creator', 'scripts', 'run_eval.py'))).mode & 0o111).toBeTruthy()
    expect(await readFile(join(d, 'skill-creator', 'LICENSE.txt'), 'utf8')).toMatch(/Apache License/)
    expect((await materializeBuiltin(d)).written).toBe(false)

    await mkdir(join(d, 'old-one'))
    const r2 = await materializeBuiltin(d, { fresh: { 'SKILL.md': { text: md('fresh', 'new'), mode: 0o644 } } }, 'v2')
    expect(r2.written).toBe(true)
    await expect(stat(join(d, 'old-one'))).rejects.toThrow()
    await expect(stat(join(d, 'skill-creator'))).rejects.toThrow()
    expect(await readFile(join(d, 'fresh', 'SKILL.md'), 'utf8')).toMatch(/fresh/)
  })
})

describe('安装', () => {
  it('识别 git 来源', () => {
    expect(parseGitSource('https://github.com/anthropics/skills/tree/main/skills/pdf')).toEqual({ url: 'https://github.com/anthropics/skills.git', ref: 'main', subdir: 'skills/pdf' })
    expect(parseGitSource('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md')).toEqual({ url: 'https://github.com/anthropics/skills.git', ref: 'main', subdir: 'skills/pdf' })
    expect(parseGitSource('https://github.com/anthropics/skills')).toEqual({ url: 'https://github.com/anthropics/skills.git' })
    expect(parseGitSource('github:o/r#dev')).toEqual({ url: 'https://github.com/o/r.git', ref: 'dev' })
    expect(parseGitSource('git@github.com:o/r.git')).toEqual({ url: 'git@github.com:o/r.git' })
    expect(parseGitSource('./my-skill')).toBeUndefined()
    expect(parseGitSource('~/skills/x')).toBeUndefined()
  })

  it('找技能：自己就是技能，或者往下找，嵌套的不算', async () => {
    const d = await tmp()
    await skill(d, 'skills/a', md('a', 'A'), { 'evals/fixtures/inner/SKILL.md': md('inner', 'nested') })
    await skill(d, 'skills/b', md('b', 'B'))
    const r = await findSkills(d)
    expect(r.skills.map((s) => s.name)).toEqual(['a', 'b'])
    expect((await findSkills(join(d, 'skills', 'a'))).skills.map((s) => s.name)).toEqual(['a'])
  })

  it('默认导出', () => {
    expect(plugin.name).toBe('leo-plugin-skills')
    expect(normalizeConfig({})).toMatchObject({ enabled: true, builtin: true, disabled: [], paths: [], remoteManage: false })
    expect(() => normalizeConfig({ disabled: 3 })).toThrow(/disabled/)
  })
})

describe('插件', () => {
  type Cmd = { run(c: unknown): unknown }
  async function setup(over: { project?: boolean; options?: Record<string, unknown>; clone?: (src: { url: string }, dest: string) => Promise<void> } = {}) {
    const home = await tmp()
    const userDir = join(home, '.leo')
    const projectRoot = join(home, 'proj')
    const projectDir = join(projectRoot, '.leo')
    await mkdir(projectDir, { recursive: true })
    const cmds = new Map<string, Cmd>()
    const host: PluginDefinition = {
      name: 'fake-host',
      apply(ctx) {
        ctx.provide('leoPaths' as never, { cwd: projectRoot, userDir, ...(over.project === false ? {} : { projectRoot, projectDir }) } as never)
        ctx.provide('commands' as never, { register: (d: { name: string } & Cmd) => (cmds.set(d.name, d), () => cmds.delete(d.name)) } as never)
      },
    }
    const leo = await createLeo({ logLevel: 'silent', plugins: [host, [createSkillsPlugin(over.clone ? { clone: over.clone } : {}), over.options ?? {}]] })
    const run = async (name: string, args = '', surface = 'cli') =>
      (await cmds.get(name)!.run({ args, argv: args ? args.split(/\s+/) : [], surface })) as { text: string; prompt?: string; isError?: boolean }
    const system = async () => {
      const sections = (leo.ctx.get('context' as never) as unknown as { sections: { id: string; render(i: unknown): unknown }[] }).sections
      const s = sections.find((x) => x.id === 'skills.catalog')
      return s ? ((await s.render({ model: 'm' })) as string | undefined) : undefined
    }
    const tool = async (args: Record<string, unknown>) => {
      const t = (leo.ctx.get('tools' as never) as unknown as { get(n: string): { execute(a: unknown, e: unknown): Promise<string> } | undefined }).get('skill')!
      return t.execute(args, {})
    }
    return { home, userDir, projectRoot, projectDir, leo, cmds, run, system, tool }
  }

  it('建空目录、释放内置技能、目录注入系统提示、skill 工具按需加载', async () => {
    const h = await setup()
    expect((await stat(join(h.userDir, 'skills'))).isDirectory()).toBe(true)
    expect((await stat(join(h.projectDir, 'skills'))).isDirectory()).toBe(true)
    expect((await stat(join(h.userDir, 'skills', '.builtin', 'skill-creator', 'SKILL.md'))).isFile()).toBe(true)

    const sys = (await h.system())!
    expect(sys).toContain('<name>skill-creator</name>')
    expect(sys).not.toMatch(/# Skill Creator/) // 正文不进系统提示

    const loaded = await h.tool({ name: 'skill-creator' })
    expect(loaded).toContain('<skill_content name="skill-creator" source="builtin">')
    expect(loaded).toContain(join(h.userDir, 'skills', '.builtin', 'skill-creator'))
    expect(loaded).toContain('scripts/run_eval.py')
    expect(loaded).toContain('# Skill Creator')
    expect(loaded).not.toMatch(/^name: skill-creator$/m)
    expect(await h.tool({ name: 'skill-creator', file: 'references/schemas.md' })).toMatch(/<skill_file skill="skill-creator" path="references\/schemas.md">/)
    await expect(h.tool({ name: 'nope' })).rejects.toThrow(/可用的有：skill-creator/)

    // 用户同名技能覆盖内置
    await skill(join(h.userDir, 'skills'), 'skill-creator', md('skill-creator', 'my own creator'))
    expect(await h.tool({ name: 'skill-creator' })).toContain('source="user"')
    await h.leo.dispose()
    expect(h.cmds.size).toBe(0)
  })

  it('/skill 手动触发、/skills 列表、info', async () => {
    const h = await setup()
    await skill(join(h.projectDir, 'skills'), 'deploy', md('deploy', 'Deploy the app', 'disable-model-invocation: true\n'))
    await skill(join(h.userDir, 'skills'), 'auto-only', md('auto-only', 'model only', 'user-invocable: false\n'))
    const r = await h.run('skill', 'deploy 发到 staging')
    expect(r.text).toBe('已加载技能 deploy')
    expect(r.prompt).toContain('<skill_content name="deploy" source="project">')
    expect(r.prompt).toMatch(/Follow it for this task:\n发到 staging$/)
    expect((await h.run('skill', 'auto-only')).isError).toBe(true)
    expect((await h.run('skill', 'missing')).isError).toBe(true)
    expect(await h.system()).not.toContain('deploy') // 仅手动的不进目录
    await expect(h.tool({ name: 'deploy' })).rejects.toThrow(/手动触发/)

    const list = (await h.run('skills')).text
    expect(list).toMatch(/deploy（项目 · 仅手动）/)
    expect(list).toMatch(/skill-creator（内置）/)
    expect(list).toMatch(/auto-only（用户 · 仅模型）/)
    expect((await h.run('skills', 'info skill-creator')).text).toMatch(/许可|目录：/)
    await h.leo.dispose()
  })

  it('/skills add 本地与 git、remove、内置不能删', async () => {
    const src = await tmp()
    await skill(src, 'skills/alpha', md('alpha', 'Alpha'), { 'ref.md': 'R' })
    await skill(src, 'skills/beta', md('beta', 'Beta'))
    const cloned: string[] = []
    const h = await setup({
      clone: async (s, dest) => {
        cloned.push(s.url)
        const { cp } = await import('node:fs/promises')
        await cp(src, dest, { recursive: true })
      },
    })
    // 多个技能要指定
    expect((await h.run('skills', `add ${src}`)).text).toMatch(/有 2 个技能[\s\S]*alpha[\s\S]*beta/)
    expect((await h.run('skills', `add ${src} alpha`)).text).toMatch(/已安装 alpha/)
    expect(await readFile(join(h.userDir, 'skills', 'alpha', 'ref.md'), 'utf8')).toBe('R')
    expect((await h.run('skills', `add ${src} alpha`)).text).toMatch(/已存在，跳过/)
    expect((await h.run('skills', `add ${src} gamma`)).text).toMatch(/没有技能 gamma/)
    // git + 项目级
    expect((await h.run('skills', 'add https://github.com/o/r/tree/main/skills/beta --project')).text).toMatch(/已安装 beta/)
    expect(cloned).toEqual(['https://github.com/o/r.git'])
    expect((await stat(join(h.projectDir, 'skills', 'beta', 'SKILL.md'))).isFile()).toBe(true)
    expect(await h.system()).toMatch(/alpha[\s\S]*beta/)

    expect((await h.run('skills', 'remove alpha')).text).toMatch(/已删除 alpha（用户）/)
    await expect(stat(join(h.userDir, 'skills', 'alpha'))).rejects.toThrow()
    expect((await h.run('skills', 'remove skill-creator')).text).toMatch(/内置技能，不能删除/)
    await h.leo.dispose()
  })

  it('/skills disable / enable 写 skills.json，聊天渠道默认不能管理', async () => {
    const h = await setup()
    expect((await h.run('skills', 'disable skill-creator')).text).toMatch(/已禁用 skill-creator/)
    expect(JSON.parse(await readFile(join(h.userDir, 'skills.json'), 'utf8'))).toEqual({ disabled: ['skill-creator'] })
    expect(await h.system()).toBeUndefined()
    await expect(h.tool({ name: 'skill-creator' })).rejects.toThrow()
    expect((await h.run('skill', 'skill-creator')).isError).toBe(true)
    expect((await h.run('skills', 'enable skill-creator')).text).toMatch(/已启用/)
    expect(JSON.parse(await readFile(join(h.userDir, 'skills.json'), 'utf8'))).toEqual({ disabled: [] })
    expect(await h.system()).toContain('skill-creator')

    const remote = await h.run('skills', 'disable skill-creator', 'gateway')
    expect(remote.isError).toBe(true)
    expect(remote.text).toMatch(/remoteManage/)
    expect((await h.run('skills', '', 'gateway')).text).toMatch(/skill-creator/) // 列表可以看
    expect((await h.run('skills', 'add x --project', 'cli')).isError).toBe(true) // 找不到 x
    await h.leo.dispose()
  })

  it('读配置：builtin=false、paths、没有项目时 --project 报错、总开关', async () => {
    const extra = await tmp()
    await skill(extra, 'claude-skill', md('claude-skill', 'From ~/.claude/skills'))
    const h = await setup({ project: false, options: { builtin: false, paths: [extra], loadConfigFiles: false } })
    const sys = (await h.system())!
    expect(sys).toContain('claude-skill')
    expect(sys).not.toContain('skill-creator')
    expect((await h.run('skills', 'add ./x --project')).text).toMatch(/不在项目里/)
    await h.leo.dispose()

    const off = await setup({ options: { enabled: false, loadConfigFiles: false } })
    expect(await off.system()).toBeUndefined()
    expect(off.cmds.size).toBe(0)
    await off.leo.dispose()
  })
})
