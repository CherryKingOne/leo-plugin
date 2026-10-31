/**
 * 网关配置文件 `gateway.json`（支持 JSONC 注释与尾随逗号）：
 *
 *   ~/.leo/gateway.json        用户级（全局安装时 leo plugin add 会生成模板）
 *   <项目>/.leo/gateway.json   项目级，覆盖用户级
 *   .leo/config.json 里的插件配置   优先级最高
 *
 * 合并规则：各段（server / agent / sessions / auth / approval）按键覆盖；channels 按账号 id 覆盖；
 * 数组整体替换。合并后再用 GatewayConfigSchema 统一校验，所以三处都可以只写一部分。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONFIG_FILE_NAME = 'gateway.json'

/** 去掉 JSONC 的注释与尾随逗号（字符串内容保持不变） */
export function stripJsonc(text: string): string {
  let src = ''
  for (let i = 0, inStr = false; i < text.length; ) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inStr) {
      src += ch
      if (ch === '\\') {
        src += next ?? ''
        i += 2
        continue
      }
      if (ch === '"') inStr = false
      i++
    } else if (ch === '"') {
      inStr = true
      src += ch
      i++
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
    } else {
      src += ch
      i++
    }
  }
  // 尾随逗号
  let out = ''
  for (let i = 0, inStr = false; i < src.length; i++) {
    const ch = src[i]!
    if (inStr) {
      out += ch
      if (ch === '\\') out += src[++i] ?? ''
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j]!)) j++
      if (src[j] === '}' || src[j] === ']') continue
    }
    out += ch
  }
  return out
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 两层合并：顶层按键覆盖；对象值（各段、channels）再按键覆盖一层；channels 的每个账号再合并一层 */
export function mergeConfig(...layers: (Obj | undefined)[]): Obj {
  const out: Obj = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      const prev = out[k]
      if (isObj(v) && isObj(prev)) {
        if (k === 'channels') {
          const merged: Obj = { ...prev }
          for (const [id, acc] of Object.entries(v)) merged[id] = isObj(acc) && isObj(prev[id]) ? { ...(prev[id] as Obj), ...acc } : acc
          out[k] = merged
        } else out[k] = { ...prev, ...v }
      } else out[k] = isObj(v) ? { ...v } : v
    }
  }
  return out
}

/** 读一个 gateway.json；不存在返回 undefined，格式错误抛错（带文件名） */
export async function readConfigFile(dir: string): Promise<{ file: string; data: Obj } | undefined> {
  const file = join(dir, CONFIG_FILE_NAME)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${file}: ${(err as Error).message}`)
  }
  let data: unknown
  try {
    data = text.trim() ? JSON.parse(stripJsonc(text)) : {}
  } catch (err) {
    throw new Error(`${file}: invalid JSON: ${(err as Error).message}`)
  }
  if (!isObj(data)) throw new Error(`${file}: must contain a JSON object`)
  return { file, data }
}
