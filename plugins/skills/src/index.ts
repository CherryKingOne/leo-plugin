/**
 * leo-plugin-skills：技能（Agent Skills，SKILL.md）管理与按需加载。
 *
 * 参考 deer-flow 把技能分成两类分开管理：
 *   - 内置技能：随插件发布（目前只有 skill-creator），释放到 ~/.leo/skills/.builtin/，只读、升级时覆盖
 *   - 外部技能：用户自己装的，放在 ~/.leo/skills/（用户级）或 <项目>/.leo/skills/（项目级）；插件启动时建好空目录
 *
 * 按需加载（渐进披露，参考 pi 与 DeepSeek Harness）：
 *   - 系统提示里只放技能目录：名字 + 描述，不放正文
 *   - 模型觉得任务对得上某个技能时调用 `skill` 工具拿完整说明；说明里提到的参考文件再用 `skill`（file）读
 *   - 用户可以 `/skill <名字> [任务]` 手动触发
 *
 * 只用 leo-agents 已有的接口：context.registerSection、tools.register、commands（≥ 0.2.1）、leoPaths。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context, Disposer, PluginDefinition, ToolDefinition } from 'leo-agents'
import { BUILTIN_DIR_NAME, materializeBuiltin } from './builtin.js'
import {
  type CatalogSnapshot,
  expandHome,
  listResources,
  readResource,
  SkillCatalog,
  type SkillRoot,
  type SkillSummary,
  SOURCE_LABEL,
} from './catalog.js'
import { CONFIG_FILE_NAME, type ConfigPaths, loadConfig, readDisabled, type SkillsConfig, writeDisabled } from './config.js'
import { parseSkillFile } from './frontmatter.js'
import { installSkills, removeSkillDir } from './install.js'

export { BUILTIN_DIGEST, BUILTIN_SKILLS, materializeBuiltin } from './builtin.js'
export * from './catalog.js'
export { CONFIG_FILE_NAME, DEFAULT_CONFIG, loadConfig, normalizeConfig, type SkillsConfig } from './config.js'
export { parseSkillFile, parseYamlSubset, splitFrontmatter } from './frontmatter.js'
export { findSkills, installSkills, parseGitSource } from './install.js'

const PLUGIN_NAME = 'leo-plugin-skills'
/** 外部技能目录名（在 ~/.leo/ 与 <项目>/.leo/ 下） */
export const SKILLS_DIR_NAME = 'skills'

interface ContextServiceLike {
  registerSection(section: { id: string; layer: string; priority?: number; render(input: { model: string }): string | undefined | Promise<string | undefined> }): Disposer
}
interface ToolsLike {
  register(def: ToolDefinition): Disposer
}
interface CommandContextLike {
  args: string
  argv: string[]
  surface?: string
}
interface CommandsLike {
  register(def: {
    name: string
    aliases?: string[]
    description?: string
    usage?: string
    plugin?: string
    run(c: CommandContextLike): unknown
  }): Disposer
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

/** 系统提示里的技能目录（只放名字和描述） */
export function catalogSection(skills: SkillSummary[], maxDescriptionChars = 500): string | undefined {
  const visible = skills.filter((s) => s.modelInvocable && !s.disabled)
  if (!visible.length) return undefined
  return [
    '## Skills',
    'Skills are task-specific instruction packages. When the user\'s task matches a skill\'s description below, call the `skill` tool with its name to load the full instructions BEFORE starting the task, then follow them. Do not load skills that are not relevant.',
    'A loaded skill may reference bundled files (references, scripts, assets). Read them only when needed with `skill` (name + file, path relative to the skill directory); run its scripts with bash using the absolute skill directory the tool returns.',
    '',
    '<available_skills>',
    ...visible.map((s) => `<skill><name>${s.name}</name><description>${escapeXml(clip(s.description, maxDescriptionChars))}</description></skill>`),
    '</available_skills>',
  ].join('\n')
}

/** `skill` 工具 / `/skill` 命令加载出来的内容 */
export async function renderSkill(s: SkillSummary): Promise<string> {
  const { body } = parseSkillFile(await readFile(s.file, 'utf8'))
  const { files, more } = await listResources(s.dir)
  return [
    `<skill_content name="${s.name}" source="${s.source}">`,
    `Skill directory: ${s.dir}`,
    'Relative paths in the instructions are relative to this directory.',
    ...(files.length ? ['<skill_resources>', ...files, ...(more ? ['…'] : []), '</skill_resources>'] : []),
    '<skill_instructions>',
    body.trim(),
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

export interface SkillsService {
  config: SkillsConfig
  paths: ConfigPaths
  /** 外部技能目录：用户级、项目级（没有项目 .leo 时为 undefined） */
  dirs: { user: string; project?: string; builtin: string }
  snapshot(): Promise<CatalogSnapshot>
  /** 按名字找生效的技能（不管是否禁用） */
  find(name: string): Promise<SkillSummary | undefined>
}

export function listText(snap: CatalogSnapshot, svc: Pick<SkillsService, 'dirs'>): string {
  const lines: string[] = []
  if (!snap.skills.length) lines.push('还没有技能。')
  for (const s of snap.skills) {
    const flags = [SOURCE_LABEL[s.source], s.disabled ? '已禁用' : '', !s.modelInvocable ? '仅手动' : '', !s.userInvocable ? '仅模型' : ''].filter(Boolean).join(' · ')
    lines.push(`  ${s.name}（${flags}）— ${clip(s.description, 80)}`)
  }
  for (const s of snap.shadowed) lines.push(`  ${s.name}（${SOURCE_LABEL[s.source]}）被${SOURCE_LABEL[s.shadowedBy!]}的同名技能覆盖`)
  for (const d of snap.diagnostics) lines.push(`  ⚠ ${d.file}：${d.message}`)
  lines.push(`外部技能目录：${svc.dirs.user}${svc.dirs.project ? `、${svc.dirs.project}` : ''}`)
  lines.push('安装：/skills add <git 地址|本地路径> [技能名…] [--project] [--all]；手动触发：/skill <名字> [任务]')
  return lines.join('\n')
}

export interface SkillsPluginOptions {
  /** 测试用：替换内置技能 */
  builtin?: Parameters<typeof materializeBuiltin>[1]
  /** 测试用：替换 git clone */
  clone?: Parameters<typeof installSkills>[0]['clone']
}

const MANAGE = new Set(['add', 'install', 'remove', 'rm', 'uninstall', 'enable', 'disable'])

export function createSkillsPlugin(opts: SkillsPluginOptions = {}): PluginDefinition<Record<string, unknown>> & { watch?: readonly string[] } {
  return {
    name: PLUGIN_NAME,
    inject: ['tools', 'context'],
    watch: [CONFIG_FILE_NAME],
    async apply(ctx: Context<any>, raw: Record<string, unknown> = {}) {
      const leoPaths = ctx.maybe('leoPaths') as ConfigPaths | undefined
      const paths: ConfigPaths = leoPaths ?? { cwd: process.cwd(), userDir: join(homedir(), '.leo') }
      const config = await loadConfig(leoPaths, raw ?? {})
      const userDir = join(paths.userDir, SKILLS_DIR_NAME)
      const projectDir = paths.projectDir ? join(paths.projectDir, SKILLS_DIR_NAME) : undefined
      const builtinDir = join(userDir, BUILTIN_DIR_NAME)
      const log = { warn: (m: string) => ctx.logger?.warn?.(m) }

      // 外部技能的空目录：用户级总是建；项目级只在项目已有 .leo 时建
      await mkdir(userDir, { recursive: true }).catch((e: Error) => log.warn(`skills: 创建 ${userDir} 失败：${e.message}`))
      if (projectDir) await mkdir(projectDir, { recursive: true }).catch((e: Error) => log.warn(`skills: 创建 ${projectDir} 失败：${e.message}`))
      if (config.builtin) {
        const job = opts.builtin ? materializeBuiltin(builtinDir, opts.builtin, `test-${Object.keys(opts.builtin).join(',')}`) : materializeBuiltin(builtinDir)
        await job.catch((e: Error) =>
          log.warn(`skills: 释放内置技能失败：${e.message}`),
        )
      }

      const base = paths.projectRoot ?? paths.cwd ?? process.cwd()
      const roots = (): SkillRoot[] => [
        ...(projectDir ? [{ source: 'project' as const, dir: projectDir }] : []),
        ...config.paths.map((p) => ({ source: 'custom' as const, dir: resolve(base, expandHome(p)) })),
        { source: 'user', dir: userDir },
        ...(config.builtin ? [{ source: 'builtin' as const, dir: builtinDir }] : []),
      ]
      const catalog = new SkillCatalog(roots)
      const svc: SkillsService = {
        config,
        paths,
        dirs: { user: userDir, ...(projectDir ? { project: projectDir } : {}), builtin: builtinDir },
        snapshot: () => catalog.snapshot(config.disabled),
        find: async (name) => (await catalog.snapshot(config.disabled)).skills.find((s) => s.name === name),
      }
      ctx.provide('skills' as never, svc as never)
      if (!config.enabled) return

      const context = ctx.get('context' as never) as unknown as ContextServiceLike
      await ctx.effect(() =>
        context.registerSection({
          id: 'skills.catalog',
          layer: 'agent',
          priority: 60,
          render: async () => catalogSection((await svc.snapshot()).skills, config.maxDescriptionChars),
        }),
      )

      const tools = ctx.get('tools' as never) as unknown as ToolsLike
      await ctx.effect(() => tools.register(skillTool(svc)))

      const commands = ctx.maybe('commands' as never) as unknown as CommandsLike | undefined
      if (!commands) return
      await ctx.effect(() =>
        commands.register({
          name: 'skill',
          usage: '<名字> [任务]',
          description: '手动触发一个技能：把它的完整说明交给 Agent，再接着做你写的任务',
          plugin: 'skills',
          run: async ({ argv, args }) => {
            const name = argv[0]
            if (!name) return { text: listText(await svc.snapshot(), svc) }
            const s = await svc.find(name)
            if (!s) return { text: `没有技能 ${name}。用 /skills 看看有哪些`, isError: true }
            if (s.disabled) return { text: `技能 ${name} 已禁用：/skills enable ${name}`, isError: true }
            if (!s.userInvocable) return { text: `技能 ${name} 只允许模型自己加载（user-invocable: false）`, isError: true }
            const task = args.slice(name.length).trim()
            const block = await renderSkill(s)
            return {
              text: `已加载技能 ${name}`,
              prompt: `${block}\n\n${task ? `The user explicitly invoked the skill "${name}". Follow it for this task:\n${task}` : `The user explicitly invoked the skill "${name}". Follow it; ask the user what they want to do with it if the task is unclear.`}`,
            }
          },
        }),
      )
      await ctx.effect(() =>
        commands.register({
          name: 'skills',
          usage: '[add <来源> [技能名…] [--project] [--all] [--force] | remove <名字> [--project] | enable|disable <名字> [--project] | info <名字>]',
          description: '技能：列表、安装、删除、启用 / 禁用',
          plugin: 'skills',
          run: async (c) => {
            try {
              return await manage(c)
            } catch (err) {
              return { text: (err as Error).message, isError: true }
            }
          },
        }),
      )

      async function manage({ argv, surface }: CommandContextLike) {
        const flags = new Set(argv.filter((a) => a.startsWith('--')))
        const [sub, ...rest] = argv.filter((a) => !a.startsWith('--'))
        if (!sub || sub === 'list' || sub === 'ls') return { text: listText(await svc.snapshot(), svc) }
        if (MANAGE.has(sub) && surface && surface !== 'cli' && !config.remoteManage) {
          return { text: '为了安全，聊天渠道里不能安装、删除或启停技能。请在终端里操作，或在 skills.json 里设 "remoteManage": true', isError: true }
        }
        const useProject = flags.has('--project')
        if (useProject && !projectDir) throw new Error('当前目录不在项目里（没有 .leo 目录）：先 leo init，或去掉 --project')
        const target = useProject ? projectDir! : userDir
        const scopeDir = useProject ? paths.projectDir! : paths.userDir

        if (sub === 'info') {
          const name = rest[0]
          if (!name) throw new Error('用法：/skills info <名字>')
          const s = await svc.find(name)
          if (!s) throw new Error(`没有技能 ${name}`)
          const { files } = await listResources(s.dir, 30)
          return {
            text: [`${s.name}（${SOURCE_LABEL[s.source]}${s.disabled ? ' · 已禁用' : ''}）`, s.description, `目录：${s.dir}`, ...(s.license ? [`许可：${s.license}`] : []), ...(files.length ? [`文件：${files.join('、')}`] : [])].join('\n'),
          }
        }
        if (sub === 'add' || sub === 'install') {
          const source = rest[0]
          if (!source) throw new Error('用法：/skills add <git 地址|本地路径> [技能名…] [--project] [--all] [--force]')
          const r = await installSkills({
            source,
            targetDir: target,
            names: rest.slice(1),
            all: flags.has('--all'),
            force: flags.has('--force'),
            cwd: paths.cwd ?? process.cwd(),
            ...(opts.clone ? { clone: opts.clone } : {}),
          })
          if (r.choices) {
            return { text: [`${source} 里有 ${r.choices.length} 个技能，指定要装哪个（或加 --all）：`, ...r.choices.map((s) => `  ${s.name} — ${clip(s.description, 80)}`)].join('\n') }
          }
          const lines = r.installed.map((s) => `已安装 ${s.name} → ${s.dir}`)
          if (r.skipped.length) lines.push(`已存在，跳过：${r.skipped.join(', ')}（--force 覆盖）`)
          return { text: lines.join('\n') || '没有安装任何技能', isError: !r.installed.length }
        }
        const name = rest[0]
        if (!name) throw new Error(`用法：/skills ${sub} <名字>${sub === 'remove' || sub === 'rm' ? ' [--project]' : ''}`)
        if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
          const snap = await svc.snapshot()
          const all = [...snap.skills, ...snap.shadowed].filter((s) => s.name === name)
          const want = useProject ? 'project' : flags.has('--user') ? 'user' : undefined
          const removable = all.filter((s) => (want ? s.source === want : s.source === 'project' || s.source === 'user'))
          const hit = removable[0]
          if (!hit) {
            if (all.some((s) => s.source === 'builtin')) throw new Error(`${name} 是内置技能，不能删除；不想用可以 /skills disable ${name}`)
            if (all.some((s) => s.source === 'custom')) throw new Error(`${name} 在 skills.json 的 paths 目录里，请到那个目录手动删除`)
            throw new Error(`没有可删除的技能 ${name}`)
          }
          await removeSkillDir(hit.dir)
          const left = (await svc.find(name))?.source
          return { text: `已删除 ${name}（${SOURCE_LABEL[hit.source]}）：${hit.dir}${left ? `；现在生效的是${SOURCE_LABEL[left]}的同名技能` : ''}` }
        }
        if (sub === 'enable' || sub === 'disable') {
          const own = await readDisabled(scopeDir)
          const next = sub === 'disable' ? [...new Set([...own, name])] : own.filter((n) => n !== name)
          const file = await writeDisabled(scopeDir, next)
          if (sub === 'disable') {
            if (!config.disabled.includes(name)) config.disabled.push(name)
          } else {
            config.disabled.splice(0, config.disabled.length, ...config.disabled.filter((n) => n !== name))
          }
          const still = sub === 'enable' && config.disabled.includes(name)
          const exists = await svc.find(name)
          return {
            text: `${sub === 'disable' ? '已禁用' : '已启用'} ${name}（写入 ${file}）${exists ? '' : '；注意：现在还没有这个技能'}${still ? '；另一级 skills.json 里还禁用着它' : ''}`,
          }
        }
        throw new Error(`不认识的子命令 ${sub}。用法：/skills [add|remove|enable|disable|info]`)
      }
    },
  }
}

function skillTool(svc: SkillsService): ToolDefinition {
  return {
    name: 'skill',
    title: '加载技能',
    description:
      'Load a skill from <available_skills>: returns its full instructions and the absolute skill directory. Call it as soon as the task matches a skill description, before doing the task. Pass `file` to read one bundled file the skill mentions (path relative to the skill directory).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, exactly as listed in <available_skills>' },
        file: { type: 'string', description: 'Optional: a file inside the skill directory to read, e.g. references/schemas.md' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async (args: { name?: unknown; file?: unknown }) => {
      const name = String(args.name ?? '').trim()
      const s = await svc.find(name)
      if (!s || s.disabled) {
        const names = (await svc.snapshot()).skills.filter((x) => x.modelInvocable && !x.disabled).map((x) => x.name)
        throw new Error(`没有可用的技能 "${name}"${names.length ? `；可用的有：${names.join(', ')}` : ''}`)
      }
      if (!s.modelInvocable) throw new Error(`技能 ${name} 只能由用户用 /skill 手动触发`)
      if (typeof args.file === 'string' && args.file.trim()) {
        const text = await readResource(s.dir, args.file.trim())
        return `<skill_file skill="${s.name}" path="${args.file.trim()}">\n${text}\n</skill_file>`
      }
      return renderSkill(s)
    },
  } as unknown as ToolDefinition
}

const plugin = createSkillsPlugin()
export default plugin
