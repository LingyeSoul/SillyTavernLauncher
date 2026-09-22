/**
 * windowControl 纯函数与降级路径单测：
 * 抓取偏移/拖动位置换算是拖动跟手的全部数学；FFI 部分依赖 win32 + Bun 真实窗口，
 * 由 scripts/verify-titlebar-drag.ts（SendInput 真实拖动 + 窗口矩形断言）覆盖。
 * 本用例锁定两点：换算公式正确；非 win32/Bun（Node 测试宿主）下全部 API 静默降级不抛错。
 */
import { describe, expect, it } from 'vitest'
import {
  beginWindowMove,
  closeWindow,
  computeDragPosition,
  computeGrabOffset,
  continueWindowMove,
  endWindowMove,
  initWindowControl,
  minimizeWindow,
} from '../services/windowControl'

describe('computeGrabOffset / computeDragPosition', () => {
  it('抓取偏移 = 光标 − 窗口左上角', () => {
    expect(computeGrabOffset({ x: 700, y: 320 }, { left: 600, top: 300, right: 1400, bottom: 980 })).toEqual({
      dx: 100,
      dy: 20,
    })
  })

  it('拖动位置 = 光标 − 抓取偏移（按下点始终落在光标的同一窗口位置）', () => {
    const grab = computeGrabOffset({ x: 700, y: 320 }, { left: 600, top: 300, right: 1400, bottom: 980 })
    expect(computeDragPosition({ x: 700, y: 320 }, grab)).toEqual({ x: 600, y: 300 })
    // 光标右下移动 40/10：窗口整体同量位移（跟手，不漂移）
    expect(computeDragPosition({ x: 740, y: 330 }, grab)).toEqual({ x: 640, y: 310 })
  })

  it('负偏移（窗口跨到副屏负坐标）同样成立', () => {
    const grab = computeGrabOffset({ x: -1180, y: 30 }, { left: -1280, top: 0, right: -480, bottom: 680 })
    expect(grab).toEqual({ dx: 100, dy: 30 })
    expect(computeDragPosition({ x: -1180, y: 30 }, grab)).toEqual({ x: -1280, y: 0 })
  })
})

describe('非 win32/Bun 宿主降级（Node + vitest）', () => {
  it('initWindowControl 静默返回，不抛错', async () => {
    await expect(initWindowControl('SillyTavernLauncher')).resolves.toBeUndefined()
  })

  it('未定位到窗口时拖动武装返回 false，其余调用为空操作', () => {
    expect(beginWindowMove()).toBe(false)
    expect(() => continueWindowMove()).not.toThrow()
    expect(() => endWindowMove()).not.toThrow()
    expect(() => minimizeWindow()).not.toThrow()
    expect(() => closeWindow()).not.toThrow()
  })
})
