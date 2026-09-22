/**
 * TitleBar 合同测试（自绘标题栏 2026-09-22）：
 *
 * 1) **命中归属回归（踩坑实录）**：拖动三监听器必须挂在拖动区上、按钮是它的**兄弟**。
 *    监听器若挂在按钮的祖先（曾实现为整条栏体），祖先的 mouseDown/Up 会捕获手势，
 *    子按钮的 onClick 永远不触发（真实鼠标点击与 harness 合成点击都收不到；
 *    createTestRoot 已最小复现）。用例直接断言"点按钮只出按钮动作、不出拖动动作"，
 *    以及"拖动区右缘 == 最小化按钮左缘"（结构不变量）。
 * 2) 品牌区在拖动区内部且 pointerEvents none：在 logo/文字上按下也算拖动。
 * 3) 窗口按钮点击：最小化 = 投递窗口消息（windowControl 经 vi.mock 记录，不碰真实
 *    FFI）；关闭 = 回调调用方的 `onCloseRequest`（退出保护/直关语义在 AppShell，
 *    TitleBar 保持哑展示）。
 *
 * 几何断言用 createTestRoot 的真实 GPUI 布局；点击走 nativeSimulateClick 真实命中链路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

vi.mock('../services/windowControl', () => ({
  beginWindowMove: () => {
    calls.push('begin')
    return true
  },
  continueWindowMove: () => {
    calls.push('move')
  },
  endWindowMove: () => {
    calls.push('end')
  },
  minimizeWindow: () => {
    calls.push('minimize')
  },
}))

import { createTestRoot } from '@gpuix/react/testing'
import type { TestRoot } from '@gpuix/react/testing'
import { ThemeProvider } from '../ui/theme'
import { TitleBar } from '../ui/shell/TitleBar'
import { layout } from '../theme'

let testRoot: TestRoot
const renderer = () => testRoot.renderer

async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  renderer().flush()
}

function boundsOf(testId: string): { x: number; y: number; width: number; height: number } {
  const el = renderer().findByTestId(testId)
  if (!el) throw new Error(`${testId} 未找到`)
  const b = renderer().getElementBounds(el.id)
  if (!b) throw new Error(`${testId} 无 bounds`)
  return b
}

function centerOf(testId: string): { x: number; y: number } {
  const b = boundsOf(testId)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

beforeEach(async () => {
  calls.length = 0
  testRoot = createTestRoot({ width: 800, height: 200 })
  testRoot.root.render(
    <ThemeProvider>
      {/* 与 app.tsx 同构：栏体处于纵向根列中的顶部 */}
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: '#141618' }}>
        <TitleBar
          onCloseRequest={() => {
            calls.push('closeRequest')
          }}
        />
      </div>
    </ThemeProvider>,
  )
  await settle()
})

afterEach(() => {
  testRoot?.unmount()
})

describe('TitleBar 布局与品牌', () => {
  it('栏体高 = titlebarH - 1，底部 1px 分隔线补齐 titlebarH', () => {
    const bar = boundsOf('titlebar')
    expect(bar.y).toBe(0)
    expect(bar.height).toBe(layout.titlebarH - 1)
    // 分隔线：栏体底边之下 1px（用整块高度上限断言，不查分隔线元素本身）
    const drag = boundsOf('titlebar-drag')
    expect(drag.y + drag.height).toBe(bar.y + bar.height)
  })

  it('品牌区承载 logo + 应用名（侧栏品牌位移入）', () => {
    expect(renderer().findByTestId('titlebar-brand')).toBeDefined()
    expect(renderer().findByText('SillyTavernLauncher')).toBeDefined()
    const brand = boundsOf('titlebar-brand')
    expect(brand.x).toBe(12)
    expect(brand.height).toBeGreaterThan(0)
  })

  it('窗口按钮贴右缘：关闭占最右 46px，最小化在其左侧', () => {
    const bar = boundsOf('titlebar')
    const close = boundsOf('titlebar-close')
    const min = boundsOf('titlebar-minimize')
    expect(close.x + close.width).toBe(bar.x + bar.width)
    expect(close.width).toBe(46)
    expect(min.x + min.width).toBe(close.x)
  })

  it('结构不变量：拖动区右缘 == 最小化按钮左缘（按钮不是拖动区的后代）', () => {
    const drag = boundsOf('titlebar-drag')
    const min = boundsOf('titlebar-minimize')
    expect(drag.x + drag.width).toBe(min.x)
  })
})

describe('TitleBar 命中归属（祖先监听器吞点击的回归）', () => {
  it('点击最小化按钮：只投递最小化，不触发拖动', async () => {
    const p = centerOf('titlebar-minimize')
    renderer().nativeSimulateClick(p.x, p.y)
    await settle()
    expect(calls).toEqual(['minimize'])
  })

  it('点击关闭按钮：只触发关闭请求，不触发拖动', async () => {
    const p = centerOf('titlebar-close')
    renderer().nativeSimulateClick(p.x, p.y)
    await settle()
    expect(calls).toEqual(['closeRequest'])
  })

  it('拖动区按下-移动-抬起：武装 / 跟随 / 收尾各一次', async () => {
    const p = centerOf('titlebar-drag')
    renderer().nativeSimulateMouseDown(p.x, p.y)
    renderer().nativeSimulateMouseMove(p.x + 40, p.y + 10, 0)
    renderer().nativeSimulateMouseUp(p.x + 40, p.y + 10)
    await settle()
    expect(calls).toEqual(['begin', 'move', 'end'])
  })

  it('品牌区（logo/文字）在拖动区内且命中穿透：在文字上按下也武装拖动', async () => {
    const p = centerOf('titlebar-brand')
    renderer().nativeSimulateMouseDown(p.x, p.y)
    renderer().nativeSimulateMouseUp(p.x, p.y)
    await settle()
    expect(calls).toEqual(['begin', 'end'])
  })
})
