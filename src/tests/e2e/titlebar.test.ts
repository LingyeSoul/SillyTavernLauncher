/**
 * E2E 用例：自绘标题栏几何与内容区下移（2026-09-22 自定义标题栏）。
 *
 * 覆盖范围与分工：
 * - 本用例：真实窗口下标题栏的**布局事实**（栏体高、品牌位、按钮贴右缘、内容区
 *   整体下移 36px、树根尺寸 = 800×(644+36)）+ 截图抽检。
 * - 交互事实（拖动搬窗、按钮最小化/关闭）由 scripts/verify-titlebar-drag.ts 用
 *   真实 SendInput + 窗口矩形断言取证——harness 的合成鼠标事件不制造真实光标位移，
 *   拖动实现读的是 GetCursorPos，注入事件下测不出真伪。
 * - 命中归属（按钮不被拖动区祖先吞点击）由 tests/titlebar.test.tsx 覆盖。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { SHOTS_DIR, expectShotExists, launchE2E } from './helpers'
import type { E2ESession } from './helpers'
import { layout } from '../../theme'

const TITLEBAR_H = layout.titlebarH

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 像素几何断言（容差 0.5px）：GPUIX 在真实窗口里按亚像素分配布局，35px 的标题栏
 * 实测会返回 34.6667（2026-10-25 本机 E2E 实测）。原来的 `toBe(35)` 把渲染器的
 * 亚像素取整当成布局错误；容差只吸收 <0.5px 的分配误差，仍能抓住真正的尺寸回归。
 */
function expectPx(actual: number | undefined, expected: number, label: string): void {
  expect(actual, label).toBeDefined()
  expect(Math.abs((actual as number) - expected), label).toBeLessThanOrEqual(0.5)
}

describe('自绘标题栏', () => {
  it('栏体几何 + 内容区下移 + 品牌位（含截图）', async () => {
    session = await launchE2E({ setupCompleted: true })
    const app = session.app

    await app.getByTestId('titlebar').waitFor({ timeoutMs: 10_000 })
    await app.getByTestId('nav-terminal').waitFor({ timeoutMs: 10_000 })

    const bar = (await app.getByTestId('titlebar').bounds()) as Bounds | null
    const brand = (await app.getByTestId('titlebar-brand').bounds()) as Bounds | null
    const drag = (await app.getByTestId('titlebar-drag').bounds()) as Bounds | null
    const min = (await app.getByTestId('titlebar-minimize').bounds()) as Bounds | null
    const close = (await app.getByTestId('titlebar-close').bounds()) as Bounds | null
    const nav = (await app.getByTestId('nav-terminal').bounds()) as Bounds | null
    expect(bar && brand && drag && min && close && nav, '标题栏元素应有 bounds').toBeTruthy()

    // 栏体：贴窗口上沿、满宽、高 = titlebarH - 1（1px 分隔线补齐）
    expectPx(bar!.y, 0, '栏体贴窗口上沿')
    expectPx(bar!.x, 0, '栏体贴窗口左沿')
    expectPx(bar!.height, TITLEBAR_H - 1, '栏体高')
    expectPx(bar!.width, layout.windowW, '栏体宽')

    // 品牌位在栏体左侧（侧栏品牌位移入处）：量 logo 左缘（0.11 起 bounds 为
    // 边框盒，brand 容器 x = 0、paddingLeft 12 计入盒内；logo 才是视觉锚点）
    const logo = (await app.getByTestId('titlebar-logo').bounds()) as Bounds | null
    expect(logo, '品牌 logo 应有 bounds').toBeTruthy()
    expectPx(logo!.x, 12, '品牌 logo 左内缩')
    expect(brand!.height).toBeGreaterThan(0)

    // 窗口按钮贴右缘：关闭占最右 46px，最小化紧邻其左；拖动区右缘 == 最小化左缘
    expectPx(close!.x + close!.width, layout.windowW, '关闭按钮贴右缘')
    expectPx(close!.width, layout.titlebarBtnW, '关闭按钮宽')
    expectPx(min!.x + min!.width, close!.x, '最小化紧邻关闭左侧')
    expectPx(drag!.x + drag!.width, min!.x, '拖动区右缘接最小化左缘')

    // 内容区整体下移：侧栏首项在标题栏之下的本体行内
    expect(nav!.y).toBeGreaterThanOrEqual(TITLEBAR_H)

    // 树根 = 客户区尺寸：内容区 644 + 标题栏 36（原生标题栏已隐藏）
    const { tree } = (await app.call('getTree', {})) as { tree: { bounds?: Bounds } | null }
    expect(tree?.bounds, '树根应有 bounds').toBeTruthy()
    expectPx(tree!.bounds!.width, 800, '树根宽')
    expectPx(tree!.bounds!.height, layout.windowH + TITLEBAR_H, '树根高')

    await app.screenshot({ path: join(SHOTS_DIR, 'titlebar.png') })
    expectShotExists('titlebar.png')
  }, 120_000)
})
