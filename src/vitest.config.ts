import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // 既有用例（tests/ 根层）；e2e 归下方独立项目（语义与原 tests/** 一致）
          include: ['tests/*.test.ts', 'tests/*.test.tsx'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/*.test.ts'],
          // E2E 起真实 GPU 进程 + 30s EULA 倒计时，单用例放宽到 120s
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // 串行执行：同机多 GPU 窗口/网络行为不可控
          fileParallelism: false,
        },
      },
    ],
  },
})
