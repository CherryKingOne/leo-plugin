import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeoFromConfig } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import { createProviderPlugin, getJsonc, withSettingsDefaults, persistSelection, scaffoldEntry, selectionWrite, setJsonc, stripJsonc, targetFile } from '../src/index.js'

const TEMPLATE = readFile(new URL('../templates/provider.json', import.meta.url), 'utf8')
const parse = (t: string) => JSON.parse(stripJsonc(t))
const tick = () => new Promise((r) => setTimeout(r, 50))

describe('setJsonc', () => {
  it('edits the shipped template and keeps every comment', async () => {
    let t = await TEMPLATE
    t = setJsonc(t, ['providers', 'longcat'], { defaultModel: 'LongCat-2.5-Preview', thinking: 'enabled' })
    t = setJsonc(t, ['model'], 'longcat/LongCat-2.5-Preview')
    t = setJsonc(t, ['providers', 'longcat', 'reasoningEffort'], 'max')
    t = setJsonc(t, ['providers', 'longcat', 'thinking'], 'disabled')
    expect(parse(t)).toMatchObject({
      model: 'longcat/LongCat-2.5-Preview',
      autoDetect: true,
      providers: { longcat: { defaultModel: 'LongCat-2.5-Preview', thinking: 'disabled', reasoningEffort: 'max' } },
    })
    for (const c of ['// "qwen":', '// "deepseek-work":', '// 0.1.x 写在']) expect(t).toContain(c)
    expect(t).toContain('\n    "longcat": {\n      "defaultModel": "LongCat-2.5-Preview",')
  })

  it('expands a one-line {} entry, handles trailing commas and reads values back', () => {
    let t = '{\n  "providers": {\n    "deepseek": {},\n  },\n}\n'
    t = setJsonc(t, ['providers', 'deepseek', 'thinking'], 'enabled')
    t = setJsonc(t, ['providers', 'longcat'], {})
    expect(t).toBe('{\n  "providers": {\n    "deepseek": {\n      "thinking": "enabled"\n    },\n    "longcat": {}\n  },\n}\n')
    expect(getJsonc(t, ['providers', 'deepseek'])).toEqual({ thinking: 'enabled' })
    expect(getJsonc(t, ['model'])).toBeUndefined()
  })
})

describe('writing provider.json', () => {
  const dirs = async (withProject: boolean) => {
    const root = await mkdtemp(join(tmpdir(), 'leo-pv-'))
    const userDir = join(root, 'home')
    const projectDir = join(root, 'proj', '.leo')
    await mkdir(userDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    if (withProject) await writeFile(join(projectDir, 'provider.json'), '{ "providers": {} }')
    return { userDir, projectDir }
  }

  it('writes the project file when it exists, otherwise the user file', async () => {
    const a = await dirs(true)
    expect(targetFile(a)).toBe(join(a.projectDir, 'provider.json'))
    const b = await dirs(false)
    expect(targetFile(b)).toBe(join(b.userDir, 'provider.json'))
    await persistSelection(b, { model: 'longcat/LongCat-2.5-Preview', topModel: true, fields: { defaultModel: 'LongCat-2.5-Preview' } })
    expect(parse(await readFile(join(b.userDir, 'provider.json'), 'utf8'))).toEqual({ model: 'longcat/LongCat-2.5-Preview', providers: { longcat: { defaultModel: 'LongCat-2.5-Preview' } } })
  })

  it('scaffolds only missing or empty entries, and only into an existing file', async () => {
    const d = await dirs(false)
    const tpl = { defaultModel: 'm', thinking: 'enabled' }
    expect(await scaffoldEntry(d, 'longcat', tpl)).toBe(false)
    const file = join(d.userDir, 'provider.json')
    await writeFile(file, '{ "providers": { "deepseek": { "thinking": "disabled" }, "longcat": {} } }')
    expect(await scaffoldEntry(d, 'longcat', tpl)).toBe(true)
    expect(await scaffoldEntry(d, 'longcat', tpl)).toBe(false)
    expect(await scaffoldEntry(d, 'deepseek', tpl)).toBe(false)
    expect(parse(await readFile(file, 'utf8')).providers).toEqual({ deepseek: { thinking: 'disabled' }, longcat: tpl })
  })
})

describe('selectionWrite', () => {
  const tpl = { defaultModel: 'x', thinking: 'enabled', reasoningEffort: 'high' }
  it('maps /model, /think and /effort to fields', () => {
    expect(selectionWrite({ model: 'longcat/L', changed: 'model' }, tpl)).toEqual({ model: 'longcat/L', topModel: true, fields: { defaultModel: 'L' } })
    expect(selectionWrite({ model: 'longcat/L', changed: 'thinking', reasoning: { enabled: false } }, tpl)?.fields).toEqual({ thinking: 'disabled' })
    expect(selectionWrite({ model: 'longcat/L', changed: 'effort', reasoning: { enabled: true, effort: 'max' } }, tpl)?.fields).toEqual({ thinking: 'enabled', reasoningEffort: 'max' })
    expect(selectionWrite({ model: 'longcat/L', changed: 'effort', reasoning: { enabled: false } }, tpl)?.fields).toEqual({ thinking: 'disabled' })
    // 驱动没声明思考字段（通用端点）：不写
    expect(selectionWrite({ model: 'vllm/q', changed: 'thinking', reasoning: { enabled: false } })).toBeUndefined()
  })
})

describe('provider plugin persistence', () => {
  it('fills the entry when a driver registers, and writes back llm/selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-pv-app-'))
    const home = join(root, 'home')
    await mkdir(join(root, '.leo'), { recursive: true })
    await mkdir(home, { recursive: true })
    const file = join(root, '.leo', 'provider.json')
    await writeFile(file, await TEMPLATE)
    const driver = {
      name: 'fake-driver',
      inject: ['providers'],
      apply(ctx: any) {
        ctx.effect(() =>
          ctx.get('providers').registerDriver({ id: 'fake', name: 'Fake', baseURL: 'http://127.0.0.1:9', defaultModel: 'f-1', settingsTemplate: { defaultModel: 'f-1', thinking: 'enabled', reasoningEffort: 'high' } }),
        )
      },
    }
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, plugins: [createProviderPlugin(), driver as never], watchPlugins: false })
    await tick()
    expect(parse(await readFile(file, 'utf8')).providers.fake).toEqual({ defaultModel: 'f-1', thinking: 'enabled', reasoningEffort: 'high' })
    app.leo.ctx.emit('llm/selected' as never, { model: 'fake/f-2', reasoning: {}, changed: 'model' } as never)
    await tick()
    app.leo.ctx.emit('llm/selected' as never, { model: 'fake/f-2', reasoning: { enabled: true, effort: 'max' }, changed: 'effort' } as never)
    await tick()
    const saved = parse(await readFile(file, 'utf8'))
    expect(saved.model).toBe('fake/f-2')
    expect(saved.providers.fake).toEqual({ defaultModel: 'f-2', thinking: 'enabled', reasoningEffort: 'max' })
    expect(await readFile(join(home, 'provider.json'), 'utf8').catch(() => 'none')).toBe('none')
    await app.dispose()
  })
})

describe('withSettingsDefaults', () => {
  const m = { id: 'x', contextWindow: 1, reasoning: { supported: true, canDisable: true, defaultEnabled: true, efforts: ['low', 'high', 'max'] as never, defaultEffort: 'high' as const } }
  it('reflects provider.json thinking / reasoningEffort as the model defaults', () => {
    expect(withSettingsDefaults(m, { enabled: true, thinking: 'disabled' }).reasoning).toMatchObject({ defaultEnabled: false, defaultEffort: 'high' })
    expect(withSettingsDefaults(m, { enabled: true, reasoningEffort: 'max' }).reasoning).toMatchObject({ defaultEnabled: true, defaultEffort: 'max' })
    expect(withSettingsDefaults(m, { enabled: true, reasoningEffort: 'medium' })).toBe(m)
    expect(withSettingsDefaults({ id: 'y', contextWindow: 1 }, { enabled: true, thinking: 'disabled' })).toEqual({ id: 'y', contextWindow: 1 })
  })
})
