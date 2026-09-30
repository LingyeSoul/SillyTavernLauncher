/**
 * E2E：终端滚动条契约（2026-09-30 thumb 卡死缺陷取证 + 回归锁）。
 *
 * 根因（真窗探针 scroll-probe.log 实证）：live 渲染器对程序化 scrollToItem
 * 不发 onVisibleRange 事件（拖拽全程 0 条，释后 2.3s 迟来一条陈旧区间），
 * offscreen 台架却即时连发——单测全绿、真窗 thumb 卡死。原生用户滚轮（直滚
 * 列表）事件正常。修复后锚点单一真源 = getListScrollTop 原生读回（TerminalView
 * 锚点数据流注释）。
 *
 * 三条链路断言（缺一即回归）：
 * 1. 拖拽 thumb → 日志行进且 thumb 全程跟随（中程采样，不得卡死）；
 * 2. 深拖到头 → 推窗生效，首行挂载可见（程序化滚动路径的窗口推进）；
 * 3. 列表本体原生滚轮 → vr 事件 + 读回校正，thumb 随行。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchE2E, sleep } from './helpers'
import type { E2ESession } from './helpers'
import type { ElementBounds } from '@gpuix/react/automation'

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

/** 探针日志尾段（STL_SCROLL_PROBE=1，app 侧 vr/scrollTo 埋点；失败排查通道） */
function dumpProbeTail(sess: E2ESession, tail = 15): void {
  const probePath = join(sess.tempDir, 'scroll-probe.log')
  if (!existsSync(probePath)) {
    console.log('[probe] 日志不存在（埋点未触发或探针门未开）')
    return
  }
  const lines = readFileSync(probePath, 'utf8').trim().split('\n')
  console.log(`[probe] 共 ${lines.length} 条，末 ${tail} 条：`)
  for (const line of lines.slice(-tail)) console.log(`  ${line}`)
}

describe('终端滚动条（真窗口）', () => {
  it('拖拽 thumb 全程跟随 + 深拖推窗 + 原生滚轮随行', async () => {
    session = await launchE2E({
      setupCompleted: true,
      env: { STL_SEED_TERMINAL_LINES: '400', STL_SCROLL_PROBE: '1' },
    })
    const app = session.app

    const thumb = app.getByTestId('terminal-scrollbar-thumb')
    const track = app.getByTestId('terminal-scrollbar')
    await thumb.waitFor({ timeoutMs: 10_000 })

    const trackB = await track.bounds()
    const thumbB0 = await thumb.bounds()
    // 起点尾部锚定：thumb 底缘 ≈ 轨道底缘（±4px 容差）
    expect(Math.abs(thumbB0.y + thumbB0.height - (trackB.y + trackB.height))).toBeLessThanOrEqual(4)

    // —— 链路 1：分步拖拽到轨道顶（pressedButton=0：左键按住），中程采样 ——
    const grabX = thumbB0.x + thumbB0.width / 2
    const grabY = thumbB0.y + thumbB0.height / 2
    const dragPx = Math.round(grabY - trackB.y - 6)
    const steps = 10
    await app.mouse.down({ x: grabX, y: grabY })
    let midBounds: ElementBounds | null = null
    for (let i = 1; i <= steps; i++) {
      const y = grabY - Math.round((dragPx * i) / steps)
      await app.mouse.move({ x: grabX, y }, { pressedButton: 0 })
      await sleep(70)
      if (i === steps / 2) midBounds = await thumb.bounds()
    }
    await app.mouse.up({ x: grabX, y: grabY - dragPx })
    await sleep(400)

    const thumbB1 = await thumb.bounds()
    // 拖拽中程：thumb 必须已显著上移（拖到半程 ≈ 内容中段，thumb 应已离开尾部区）
    expect(
      midBounds && thumbB0.y - midBounds.y,
      `拖拽中程 thumb 应跟随上移（起点 y=${thumbB0.y}，中程 y=${midBounds?.y}）`,
    ).toBeGreaterThan(trackB.height / 4)
    // 释后贴顶：深拖到头 thumb 顶缘 ≈ 轨道顶缘（±4px）
    expect(Math.abs(thumbB1.y - trackB.y), `释后 thumb 应贴顶（y=${thumbB1.y}，轨道顶 ${trackB.y}）`).toBeLessThanOrEqual(4)

    // —— 链路 2：深拖推窗生效——首行挂载可见（程序化路径零 vr 事件下推窗） ——
    await app.getByText('seed-log-0').waitFor({ timeoutMs: 5_000 })

    // —— 链路 3：列表本体原生滚轮（vr 事件 + 读回校正路径）→ thumb 随行 ——
    // virtual-list 自身无 painted bounds（AGENTS.md ④），落点取日志卡中心
    const listB = await app.getByTestId('terminal-log-card').bounds()
    for (let i = 0; i < 3; i++) {
      await app.mouse.wheel({ x: listB.x + listB.width / 2, y: listB.y + listB.height / 2 }, 0, -120)
      await sleep(150)
    }
    await sleep(300)
    const thumbB2 = await thumb.bounds()
    expect(
      thumbB2.y - thumbB1.y,
      `原生滚轮下滚后 thumb 应下移（贴顶 y=${thumbB1.y} → y=${thumbB2.y}）`,
    ).toBeGreaterThan(10)

    dumpProbeTail(session)
  }, 120_000)
})
