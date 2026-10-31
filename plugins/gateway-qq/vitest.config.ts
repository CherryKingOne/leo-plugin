import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 集成测试直接加载同仓库网关的源码（只在测试里；插件代码不 import 网关）
export default defineConfig({
  resolve: { alias: { 'leo-plugin-gateway': fileURLToPath(new URL('../gateway/src/index.ts', import.meta.url)) } },
})
