import { defineConfig } from 'vitest/config'

// LEO_AGENTS_DIST=<leo-agents 仓库>/dist/index.js 时用指定的宿主跑同一套测试
// （例如 leo-agents 分支 feat/context-log 的构建产物，验证 llm/request.breakdown 路径）
const host = process.env.LEO_AGENTS_DIST
export default defineConfig({
  resolve: host ? { alias: { 'leo-agents': host } } : {},
  test: { testTimeout: 15_000 },
})
