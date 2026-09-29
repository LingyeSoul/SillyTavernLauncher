/**
 * ScrollBar 契约（2026-09-29 自绘滚动条）：
 * - 纯几何：thumb 尺寸钳幅（最小 24 / 装得下满轨）、首可见行 ↔ thumb 顶点
 *   正逆映射互逆、滚轮 delta 换算（Windows 棘轮 120/档×3 行 + precise 像素）
 * - 真实 GPUI 管线（createTestRoot，同 terminalPerf ③ 台架）：
 *   尾部锚定（thumb 贴底）→ scrollToItem 驱动 thumb 跟随 → 拖拽 thumb 行进
 *   （nativeSimulateMouseDown/Move 真实命中链路）→ 轨道滚轮转发
 *   （pointerEvents:'auto' 吃掉的滚轮经 onScroll 换行还给列表）→ 清空卸载
 * - 结构性断言（AGENTS.md：性能门禁不用耗时断言）：窗口化挂载不回归
 *   （保留元素 O(窗口) 量级）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRoot } from '@gpuix/react/testing'
import {
  SCROLLBAR_MIN_THUMB_H,
  rowForThumbTop,
  thumbGeometry,
  thumbTopFor,
  wheelToRows,
} from '../ui/components/ScrollBar'

// ---------------------------------------------------------------------------
// 纯几何
// ---------------------------------------------------------------------------
describe('ScrollBar 纯几何', () => {
  it('thumb 尺寸：可视占比 × 轨道高，钳 [24, trackH]；装得下 → 满轨零行程', () => {
    // 10k 行 / 25 可视：占比 1.39px → 抬到最小 24
    expect(thumbGeometry(556, 10_000, 25)).toEqual({ thumbH: 24, travel: 532 })
    // 中段：400 行 / 25 可视
    expect(thumbGeometry(556, 400, 25)).toEqual({ thumbH: 556 * 25 / 400, travel: 556 - (556 * 25) / 400 })
    // 装得下（10 行 < 25 可视）：thumb 满轨、无行程
    expect(thumbGeometry(556, 10, 25)).toEqual({ thumbH: 556, travel: 0 })
    // 防御：非正输入
    expect(thumbGeometry(0, 100, 25).travel).toBe(0)
    expect(thumbGeometry(556, 0, 25).travel).toBe(0)
  })

  it('首可见行 ↔ thumb 顶点：正逆映射互逆（±1 行），越界钳到 [0, travel]', () => {
    const geo = thumbGeometry(556, 10_000, 25)
    expect(thumbTopFor(0, 10_000, 25, geo)).toBe(0)
    expect(thumbTopFor(10_000 - 25, 10_000, 25, geo)).toBeCloseTo(geo.travel, 6)
    expect(thumbTopFor(99_999, 10_000, 25, geo)).toBe(geo.travel) // 越界钳幅
    // 互逆：正映射再逆映射回到原行（±1 行舍入容差）
    for (const row of [0, 1, 123, 2500, 5000, 7500, 9975]) {
      const back = rowForThumbTop(thumbTopFor(row, 10_000, 25, geo), 10_000, 25, geo)
      expect(Math.abs(back - row)).toBeLessThanOrEqual(1)
    }
    // 装得下：映射与逆映射都退化为边界
    const full = thumbGeometry(556, 10, 25)
    expect(thumbTopFor(3, 10, 25, full)).toBe(0)
    expect(rowForThumbTop(100, 10, 25, full)).toBe(0)
  })

  it('滚轮换算：Windows 棘轮 120/档 × 3 行/档；precise 像素 ÷ 行高；钳幅 ±30', () => {
    expect(wheelToRows(-120, false, 22)).toBe(3) // 向下一档 = +3 行
    expect(wheelToRows(120, false, 22)).toBe(-3) // 向上一档
    expect(wheelToRows(-120, false, 22)).toBeGreaterThan(0)
    expect(wheelToRows(-22, true, 22)).toBe(1) // 触控板像素
    expect(wheelToRows(0, false, 22)).toBe(0)
    expect(wheelToRows(-120 * 40, false, 22)).toBe(30) // 钳幅
    // 不足一行的 ratchet 残量按方向取 1 行（不丢事件）
    expect(wheelToRows(-40, false, 22)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 真实 GPUI 管线
// ---------------------------------------------------------------------------
describe('ScrollBar 集成（TerminalView 真实管线）', () => {
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
  let testRoot: TestRoot
  const renderer = () => testRoot.renderer

  async function settle(ms = 50): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
    renderer().flush()
    renderer().dispatchNativeEvents()
  }

  /** 等待条件成立（每轮驱动渲染管线：行入库 → 窗口推_move 需要 dispatch） */
  async function waitForRenders(check: () => boolean, timeout = 5000): Promise<void> {
    await vi.waitFor(
      () => {
        renderer().flush()
        renderer().dispatchNativeEvents()
        expect(check()).toBe(true)
      },
      { timeout, interval: 50 },
    )
  }

  const anchorOf = (): number => {
    const list = renderer().findByTestId('terminal-log-list')
    if (!list) return -1
    return renderer().getListScrollTop(list.id)?.[0] ?? -1
  }

  beforeAll(async () => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'stl-scrollbar-'))
    process.chdir(tempDir)
    const [react, theme, tooltip, view, logs] = await Promise.all([
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
    logs.__resetTerminalLogsForTests()
    testRoot = createTestRoot({ width: 800, height: 644 })
  }, 60_000)

  afterAll(() => {
    testRoot?.unmount()
    process.chdir(originalCwd)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('渲染 + 尾部锚定 + 窗口化不回归 → 拖拽行进 → 滚轮转发 → 清空卸载', async () => {
    // 灌 400 行（远超一屏 ~25 行）
    app.useTerminalLogs.getState().appendBatch(
      Array.from({ length: 400 }, (_, i) => ({ text: `scroll-test-${i}` })),
    )
    await vi.waitFor(() => {
      expect(app.useTerminalLogs.getState().lines.length).toBe(400)
    })
    renderer().flush()

    // offscreen 测试根不认尺寸请求、按屏幕高布局且 height:'100%' 不解析
    //（smart-scroll 测试同款结论）；且普通 div 子元素不吃 flexGrow——须复刻
    // AppShell 的 flex 列容器形态，TerminalView 的 flexGrow 才能撑到定高
    testRoot.root.render(
      app.h(
        app.ThemeProvider,
        null,
        app.h(
          app.TooltipProvider,
          null,
          app.h(
            'div',
            { style: { width: 800, height: 644, display: 'flex', flexDirection: 'column' } },
            app.h(app.TerminalView, null),
          ),
        ),
      ),
    )
    await settle()

    // —— 渲染：轨道 + thumb 在树，thumb ≥ 最小高且贴底（尾部跟随锚定） ——
    const track = renderer().findByTestId('terminal-scrollbar')
    expect(track, '轨道必须在树').toBeDefined()
    const thumb = renderer().findByTestId('terminal-scrollbar-thumb')
    expect(thumb, '溢出时 thumb 必须在树').toBeDefined()
    const tb = renderer().getElementBounds(track!.id)!
    const mb = renderer().getElementBounds(thumb!.id)!
    expect(tb, '轨道 bounds 可测').not.toBeNull()
    expect(mb, 'thumb bounds 可测').not.toBeNull()
    expect(mb.height).toBeGreaterThanOrEqual(SCROLLBAR_MIN_THUMB_H)
    expect(mb.height).toBeLessThan(tb.height)
    // 尾部锚定：thumb 底缘 ≈ 轨道底缘（±2px）
    expect(Math.abs(mb.y + mb.height - (tb.y + tb.height))).toBeLessThanOrEqual(2)
    // 窗口化不回归：+轨道/thumb 只加常数个元素
    expect(renderer().getRetainedElementCount()).toBeLessThan(1_000)

    // —— scrollToItem 驱动 thumb：滚到头部 → thumb 贴顶 ——
    const list = renderer().findByTestId('terminal-log-list')!
    expect(list, '列表（ref 挂载锚）必须在树').toBeDefined()
    renderer().scrollToItem(list.id, 0)
    renderer().flush()
    renderer().dispatchNativeEvents()
    await waitForRenders(() => {
      const th = renderer().findByTestId('terminal-scrollbar-thumb')
      if (!th) return false
      const b = renderer().getElementBounds(th.id)
      const t = renderer().getElementBounds(track!.id)
      return !!b && !!t && Math.abs(b.y - t.y) <= 2
    })
    expect(anchorOf(), '头部锚：列表锚行 ≈ 0').toBeLessThanOrEqual(1)
    const anchorHead = anchorOf()

    // —— 轨道滚轮转发：悬停轨道滚一格 = 列表向下行进 ——
    const wheelX = tb.x + tb.width / 2
    const wheelY = tb.y + tb.height / 2
    renderer().nativeSimulateScrollWheel(wheelX, wheelY, 0, -120)
    await settle()
    expect(anchorOf(), '轨道滚轮应推进列表锚行').toBeGreaterThan(anchorHead)

    // —— 拖拽 thumb：从当前位置（头部）拖到轨道底部 → 锚行到尾部 ——
    const thumbAtHead = renderer().getElementBounds(renderer().findByTestId('terminal-scrollbar-thumb')!.id)!
    const grabX = thumbAtHead.x + thumbAtHead.width / 2
    const grabY = thumbAtHead.y + thumbAtHead.height / 2
    renderer().nativeSimulateMouseDown(grabX, grabY)
    renderer().nativeSimulateMouseMove(grabX, tb.y + tb.height - 30, 0)
    renderer().nativeSimulateMouseUp(grabX, tb.y + tb.height - 30)
    await waitForRenders(() => anchorOf() > 300)
    expect(renderer().findByText('scroll-test-399'), '拖到尾部后末行应已挂载可见').toBeDefined()

    // —— 清空：轨道随日志卡空态卸载 ——
    app.useTerminalLogs.getState().clear()
    await waitForRenders(() => renderer().findByTestId('terminal-scrollbar') === undefined)
    expect(renderer().findByTestId('terminal-log-list')).toBeUndefined()
  }, 60_000)
})
