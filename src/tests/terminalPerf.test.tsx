/**
 * 终端性能回归门禁（2026-09-21 性能修复的固化断言）。
 *
 * 背景（实测数据）：全量挂载 + 逐行发射的实现在 20k 行时进程 RSS 842MB、
 * 原生保留元素 60,030（3/行）、涓流逐行追加 52ms/行；store 填充呈 O(N²)
 * （5k 0.23s → 100k 17.4s）。修复三件套：
 * ① store 稳定引用原地演进（O(1) 追加/修剪）+ version 订阅 + getRange 窗口
 * ② 引擎 microtask 合批 + 同 tag 分块（写/发射次数 每行一次 → 每块一次）
 * ③ TerminalView itemCount/windowStart 窗口化挂载（原生元素 3N → O(窗口)）
 *
 * 本文件用结构性断言（引用/计数/批次）而非耗时断言，避免 CI 时序抖动误报；
 * 渲染侧门禁用真实 GPUI 管线（createTestRoot）的原生保留元素计数做硬断言。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalEngine, type EngineRow } from '../services/terminalEngine'
import {
  __resetTerminalLogsForTests,
  MAX_LINES,
  useTerminalLogs,
} from '../stores/terminalLogs'

/** 写入并等待引擎发射：期望 expectedRows 行（回调 FIFO，计数达成即稳定） */
async function runEngine(
  lines: Array<{ text: string; tag?: unknown }>,
  expectedRows: number,
): Promise<EngineRow[][]> {
  const batches: EngineRow[][] = []
  const engine = createTerminalEngine((rows) => batches.push(rows))
  for (const line of lines) engine.writeLine(line.text, line.tag)
  await vi.waitFor(() => {
    expect(batches.flat().length).toBe(expectedRows)
  })
  return batches
}

describe('性能门禁①：store 增量结构（稳定引用 + version + getRange）', () => {
  beforeEach(() => {
    __resetTerminalLogsForTests()
  })

  it('lines 引用恒定：追加/清空均原地演进，version 每次发射自增', async () => {
    const refBefore = useTerminalLogs.getState().lines
    const versionBefore = useTerminalLogs.getState().version
    useTerminalLogs.getState().appendLine('line-a')
    await vi.waitFor(() => {
      expect(useTerminalLogs.getState().lines.length).toBe(1)
    })
    expect(useTerminalLogs.getState().lines).toBe(refBefore) // 同一引用，无全量拷贝
    expect(useTerminalLogs.getState().version).toBeGreaterThan(versionBefore)

    useTerminalLogs.getState().clear()
    expect(useTerminalLogs.getState().lines).toBe(refBefore)
    expect(useTerminalLogs.getState().lines).toHaveLength(0)
    expect(useTerminalLogs.getState().version).toBeGreaterThan(versionBefore)
  })

  it('getRange：窗口切片 + 越界收窄 + LRU 修剪后索引正确', async () => {
    useTerminalLogs.getState().appendBatch([
      { text: 'r0' }, { text: 'r1' }, { text: 'r2' }, { text: 'r3' },
    ])
    await vi.waitFor(() => {
      expect(useTerminalLogs.getState().lines.length).toBe(4)
    })
    const { getRange } = useTerminalLogs.getState()
    expect(getRange(1, 3).map((l) => l.text)).toEqual(['r1', 'r2'])
    expect(getRange(-5, 2).map((l) => l.text)).toEqual(['r0', 'r1'])
    expect(getRange(3, 99).map((l) => l.text)).toEqual(['r3'])
    expect(getRange(2, 2)).toEqual([])
    expect(getRange(9, 99)).toEqual([])

    // LRU 修剪：超 MAX_LINES 从头丢弃，getRange(0) 反映修剪后的头部
    useTerminalLogs.getState().appendBatch(
      Array.from({ length: MAX_LINES + 10 }, (_, i) => ({ text: `bulk-${i}` })),
    )
    // 引擎 200 块 × 500 行的合批写入 + 行提取是秒级，waitFor 需显式放大窗口。
    // 等待条件必须用单调量（累计行 id）：`lines.length === MAX_LINES` 在**中途**
    // 也成立——末批 10 行未发射前，缓冲已因修剪停在 10 万（此时 lines[0] 恰是
    // bulk-0），waitFor 会提前放行导致断言读到中途态。
    await vi.waitFor(
      () => {
        expect(useTerminalLogs.getState().getLastId()).toBe(4 + MAX_LINES + 10)
      },
      { timeout: 30_000 },
    )
    expect(useTerminalLogs.getState().lines.length).toBe(MAX_LINES)
    // 既有 4 行（r0-r3）+ 100,010 新行 = 100,014 → 丢弃 14 行（4 旧 + bulk-0..9）
    expect(useTerminalLogs.getState().lines[0]?.text).toBe('bulk-10')
    expect(useTerminalLogs.getState().getRange(0, 1)[0]?.text).toBe('bulk-10')
    expect(useTerminalLogs.getState().getLastId()).toBe(MAX_LINES + 14)
  }, 30_000)
})

describe('性能门禁②：引擎合批（microtask 合并 + 同 tag 分块）', () => {
  it('同步突发 50 行同 tag → 单次发射成批（非 50 次）', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({ text: `burst-${i}`, tag: 'stdout' }))
    const batches = await runEngine(lines, 50)
    expect(batches.length).toBeLessThanOrEqual(2) // microtask 合批：至多首块+残余
    expect(batches.flat().map((r) => r.text)).toEqual(lines.map((l) => l.text))
    expect(batches.flat().every((r) => r.tag === 'stdout')).toBe(true)
  })

  it('stdout/stderr 交替 → 按 tag 分块不串标签', async () => {
    const lines = [
      { text: 'out-1', tag: 'stdout' },
      { text: 'err-1', tag: 'stderr' },
      { text: 'err-2', tag: 'stderr' },
      { text: 'out-2', tag: 'stdout' },
    ]
    const batches = await runEngine(lines, 4)
    const tagged = batches.flat().map((r) => [r.text, r.tag])
    expect(tagged).toEqual([
      ['out-1', 'stdout'],
      ['err-1', 'stderr'],
      ['err-2', 'stderr'],
      ['out-2', 'stdout'],
    ])
  })
})

// ---------------------------------------------------------------------------
// 性能门禁③：窗口化挂载（真实 GPUI 管线硬断言）
// ---------------------------------------------------------------------------
describe('性能门禁③：TerminalView 窗口化挂载', () => {
  let tempDir: string
  let originalCwd: string
  type AppModule = {
    h: typeof import('react').createElement
    ThemeProvider: typeof import('../ui/theme').ThemeProvider
    TooltipProvider: typeof import('../ui/components/Tooltip').TooltipProvider
    TerminalView: typeof import('../ui/views/TerminalView').TerminalView
    useTerminalLogs: typeof import('../stores/terminalLogs').useTerminalLogs
  }
  let app: AppModule
  let testRoot: import('@gpuix/react/testing').TestRoot
  let renderer: import('@gpuix/react/testing').TestRenderer

  beforeAll(async () => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'stl-perf-gate-'))
    process.chdir(tempDir)
    const [{ createTestRoot }, react, theme, tooltip, view, logs] = await Promise.all([
      import('@gpuix/react/testing'),
      import('react'),
      import('../ui/theme'),
      import('../ui/components/Tooltip'),
      import('../ui/views/TerminalView'),
      import('../stores/terminalLogs'),
    ])
    app = {
      h: react.createElement,
      ThemeProvider: theme.ThemeProvider,
      TooltipProvider: tooltip.TooltipProvider,
      TerminalView: view.TerminalView,
      useTerminalLogs: logs.useTerminalLogs,
    }
    const { getConfigStore } = await import('../services/configStore')
    getConfigStore().set('motionEnabled', false)
    __resetTerminalLogsForTests()
    testRoot = createTestRoot({ width: 800, height: 644 })
    renderer = testRoot.renderer
  }, 60_000)

  afterAll(() => {
    testRoot?.unmount()
    process.chdir(originalCwd)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('10,000 行缓冲：原生保留元素 O(窗口) 而非 3N；尾部行可见；清空回落', async () => {
    // 灌 10,000 行（合批后引擎写入为整块，秒级完成）
    const CHUNK = 500
    for (let i = 0; i < 10_000; i += CHUNK) {
      app.useTerminalLogs.getState().appendBatch(
        Array.from({ length: CHUNK }, (_, k) => ({ text: `perf-gate-${i + k}` })),
      )
      await vi.waitFor(() => {
        expect(app.useTerminalLogs.getState().lines.length).toBeGreaterThanOrEqual(
          Math.min(i + CHUNK, 10_000),
        )
      })
    }

    testRoot.root.render(
      app.h(
        app.ThemeProvider,
        null,
        app.h(
          app.TooltipProvider,
          null,
          app.h('div', { style: { width: '100%', height: '100%' } }, app.h(app.TerminalView, null)),
        ),
      ),
    )
    await new Promise((r) => setTimeout(r, 50))
    renderer.flush()

    // 硬门禁：窗口化生效时原生元素 ≈ 120 行 × 3 + 外壳 ≈ 数百；
    // 若回退为全量挂载则 ≥ 30,000（3/行），立即失败
    const retained = renderer.getRetainedElementCount()
    expect(retained).toBeLessThan(1_000)
    // 尾部跟随：最新一行必须在渲染树中可见
    expect(renderer.findByText('perf-gate-9999')).toBeDefined()

    // 清空：原生元素回落到空载水平（无泄漏）；原生释放随 React 提交异步
    // 完成，轮询等待（期间反复驱动渲染管线）而非固定 sleep
    app.useTerminalLogs.getState().clear()
    await vi.waitFor(
      () => {
        renderer.flush()
        expect(renderer.getRetainedElementCount()).toBeLessThan(100)
      },
      { timeout: 10_000, interval: 100 },
    )
  }, 60_000)
})
