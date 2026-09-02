import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// vitest 配置。只收 `*.test.tsx`：
// `src/lib/format.test.ts` 是更早期的**独立可执行脚本**（自带 console 打印与退出码，
// 用 `npx tsx src/lib/format.test.ts` 运行），不是 vitest 套件，纳入会被报 "No test suite found"。
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.tsx'],
  },
})
