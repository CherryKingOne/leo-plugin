import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 集成测试直接加载同仓库注册层的源码（只在测试里；插件代码不 import 注册层）
export default defineConfig({
  resolve: { alias: { 'leo-plugin-provider': fileURLToPath(new URL('../provider/src/index.ts', import.meta.url)) } },
})
