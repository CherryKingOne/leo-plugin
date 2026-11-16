#!/usr/bin/env node
// 把 src/page.html 生成为 src/ui.ts（网页内联进插件，单文件 bundle 也能带上）。修改网页后运行：npm run gen:ui
import { readFile, writeFile } from 'node:fs/promises'
const dir = new URL('../src/', import.meta.url)
const html = await readFile(new URL('page.html', dir), 'utf8')
const out = `// 由 scripts/gen-ui.mjs 从 src/page.html 生成，请勿手改\nexport const PAGE_HTML: string = ${JSON.stringify(html)}\n`
await writeFile(new URL('ui.ts', dir), out)
