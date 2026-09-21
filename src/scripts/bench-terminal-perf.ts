/**
 * 终端性能探针（一次性诊断脚本，不入库）：
 * - store 模式：store/引擎通路填充耗时、堆内存、稳态单次 emitRows 拷贝成本
 * - render 模式：createTestRoot 真实 GPUI 管线的挂载/增量/清空/卸载成本，
 *   并用 getRetainedElementCount 检查原生侧元素泄漏
 *
 * 运行：cd src && bun scripts/bench-terminal-perf.ts [store|render|all]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const part = process.argv[2] ?? 'all'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const gc = () => (globalThis as { Bun?: { gc?: () => void } }).Bun?.gc?.()
const heapMb = () => process.memoryUsage().heapUsed / 1048576
const rssMb = () => process.memoryUsage().rss / 1048576

const tempDir = mkdtempSync(join(tmpdir(), 'stlbench'))
const originalCwd = process.cwd()
process.chdir(tempDir)

const { __resetTerminalLogsForTests, useTerminalLogs, MAX_LINES } = await import('../stores/terminalLogs')
const { getConfigStore } = await import('../services/configStore')
getConfigStore().set('motionEnabled', false)

async function drain(expected: number, timeoutMs = 120_000): Promise<void> {
  const t0 = performance.now()
  while (useTerminalLogs.getState().lines.length < expected) {
    if (performance.now() - t0 > timeoutMs) {
      throw new Error(`drain 超时 @${useTerminalLogs.getState().lines.length}/${expected}`)
    }
    await sleep(2)
  }
}

function makeLines(n: number, offset = 0): Array<{ text: string; stream: 'stdout' }> {
  return Array.from({ length: n }, (_, i) => ({
    text: `[${offset + i}] 普通日志行 模拟 SillyTavern 输出内容 abcdefgh ${(offset + i) * 7}`,
    stream: 'stdout' as const,
  }))
}

async function fill(n: number, chunk = 500): Promise<void> {
  const items = makeLines(n)
  for (let i = 0; i < n; i += chunk) {
    useTerminalLogs.getState().appendBatch(items.slice(i, i + chunk))
    await drain(Math.min(i + chunk, n))
  }
}

// ---------------------------------------------------------------------------
// Part A：store/引擎通路
// ---------------------------------------------------------------------------
async function benchStore(): Promise<void> {
  console.log('=== Part A: store/引擎通路（无渲染）===')
  for (const n of [5_000, 20_000, 50_000, 100_000]) {
    __resetTerminalLogsForTests()
    await sleep(50)
    gc()
    const h0 = heapMb()
    const r0 = rssMb()
    const t0 = performance.now()
    await fill(n)
    const t1 = performance.now()
    gc()
    const h1 = heapMb()
    const r1 = rssMb()
    console.log(
      `[A] N=${n}: 填充 ${((t1 - t0) / 1000).toFixed(2)}s | 堆 ${h0.toFixed(0)}→${h1.toFixed(0)}MB (Δ${(h1 - h0).toFixed(1)}) | RSS ${r0.toFixed(0)}→${r1.toFixed(0)}MB`,
    )
  }
  // 稳态单发成本：N=100k 时一次 emitRows 的数组拷贝（spread + LRU slice）
  const lines = useTerminalLogs.getState().lines
  const one = [{ id: 1, text: 'x', segs: [], stream: 'stdout' as const, animate: false }]
  const t2 = performance.now()
  for (let k = 0; k < 1000; k++) {
    const all = [...lines, ...one]
    if (all.length > MAX_LINES) all.slice(all.length - MAX_LINES)
  }
  const t3 = performance.now()
  console.log(`[A] 稳态(N=100k)单次 emitRows 数组拷贝: ${((t3 - t2) / 1000).toFixed(3)} ms/次（每来一行日志付一次）`)
  __resetTerminalLogsForTests()
}

// ---------------------------------------------------------------------------
// Part B：渲染通路（真实 GPUI 管线）
// ---------------------------------------------------------------------------
async function benchRender(): Promise<void> {
  console.log('=== Part B: 渲染通路（createTestRoot 真实 GPUI 管线）===')
  const { createTestRoot } = await import('@gpuix/react/testing')
  const { createElement: h } = await import('react')
  const { ThemeProvider } = await import('../ui/theme')
  const { TooltipProvider } = await import('../ui/components/Tooltip')
  const { TerminalView } = await import('../ui/views/TerminalView')

  const settle = async (renderer: { flush: () => void }, ms = 20): Promise<void> => {
    await sleep(ms)
    renderer.flush()
  }

  /** 一个尺寸一档：灌数据 → 挂载 → 逐行增量 → （可选）突发/清空/卸载 */
  const stage = async (
    n: number,
    opts: { incremental?: number; burst?: number; checkClear?: boolean } = {},
  ): Promise<void> => {
    __resetTerminalLogsForTests()
    await fill(n)
    gc()
    const h0 = heapMb()
    const r0 = rssMb()
    const testRoot = createTestRoot({ width: 800, height: 644 })
    const renderer = testRoot.renderer
    const t0 = performance.now()
    testRoot.root.render(
      h(
        ThemeProvider,
        null,
        h(TooltipProvider, null, h('div', { style: { width: '100%', height: '100%' } }, h(TerminalView, null))),
      ),
    )
    await settle(renderer, 50)
    const t1 = performance.now()
    gc()
    console.log(
      `[B] 挂载 N=${n}: ${((t1 - t0) / 1000).toFixed(2)}s | 原生保留元素 ${renderer.getRetainedElementCount()} | 堆 ${h0.toFixed(0)}→${heapMb().toFixed(0)}MB | RSS ${r0.toFixed(0)}→${rssMb().toFixed(0)}MB`,
    )

    if (opts.incremental) {
      const samples: number[] = []
      for (let i = 0; i < opts.incremental; i++) {
        const s0 = performance.now()
        useTerminalLogs.getState().appendLine(`[incr ${i}] 增量日志行 abcdefgh ${i * 13}`)
        await drain(useTerminalLogs.getState().lines.length + 1)
        await settle(renderer, 5)
        samples.push(performance.now() - s0)
      }
      samples.sort((a, b) => a - b)
      const avg = samples.reduce((s, v) => s + v, 0) / samples.length
      console.log(
        `[B] N=${n} 逐行追加 ×${opts.incremental}: avg ${avg.toFixed(1)}ms | p50 ${samples[Math.floor(samples.length / 2)]!.toFixed(1)}ms | max ${samples[samples.length - 1]!.toFixed(1)}ms`,
      )
    }

    if (opts.burst) {
      const before = useTerminalLogs.getState().lines.length
      const b0 = performance.now()
      useTerminalLogs.getState().appendBatch(makeLines(opts.burst, 900_000))
      await drain(before + opts.burst)
      await settle(renderer, 10)
      console.log(
        `[B] N=${n} 突发 ${opts.burst} 行: ${((performance.now() - b0) / 1000).toFixed(2)}s | 原生保留元素 ${renderer.getRetainedElementCount()}`,
      )
    }

    if (opts.checkClear) {
      const before = renderer.getRetainedElementCount()
      const c0 = performance.now()
      useTerminalLogs.getState().clear()
      await settle(renderer, 30)
      console.log(
        `[B] 清空: ${((performance.now() - c0) / 1000).toFixed(2)}s | 原生保留元素 ${before} → ${renderer.getRetainedElementCount()}`,
      )
      // 清空后卸载：原生侧是否归零（真泄漏检查）
      const u0 = performance.now()
      testRoot.unmount()
      await settle(renderer, 20)
      console.log(`[B] 清空后卸载: ${((performance.now() - u0) / 1000).toFixed(2)}s | 原生保留元素 → ${renderer.getRetainedElementCount()}`)
      return
    }

    // 带载卸载：原生侧是否归零（真泄漏检查）
    const before = renderer.getRetainedElementCount()
    testRoot.unmount()
    await settle(renderer, 20)
    console.log(`[B] N=${n} 带载卸载: 原生保留元素 ${before} → ${renderer.getRetainedElementCount()}`)
  }

  await stage(1_000, { incremental: 20 })
  await stage(5_000, { incremental: 20 })
  await stage(20_000, { incremental: 30, burst: 500, checkClear: true })
}

try {
  if (part === 'store' || part === 'all') await benchStore()
  if (part === 'render' || part === 'all') await benchRender()
  console.log('=== 完成 ===')
} finally {
  process.chdir(originalCwd)
  // 等 configStore 防抖落盘完成再删临时目录（避免 ENOENT 噪音）
  await sleep(300)
  rmSync(tempDir, { recursive: true, force: true })
}
