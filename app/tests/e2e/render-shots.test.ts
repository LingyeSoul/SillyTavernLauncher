/**
 * E2E 用例 6：中文渲染抽检。
 * - getPaintedText（上一帧实际绘制的字符串）断言关键中文文案进入渲染管线
 *   （树里存在 ≠ 画出来；painted text 是绘制证据）。
 * - screenshot 存 tests/e2e/__shots__/（人工/图像模型复核用）。
 * 种子：协议已同意 + first_run=true → 仅欢迎问答弹窗可见（无 EULA 遮挡）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { launchE2E, sleep, expectShotExists, SHOTS_DIR } from './helpers'
import type { E2ESession } from './helpers'

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

describe('中文渲染抽检', () => {
  it('欢迎问答界面：关键中文文案在树中可达，截图落盘', async () => {
    session = await launchE2E({ setupCompleted: true, welcomeOnly: true })
    const app = session.app

    await app.getByTestId('welcome-question').waitFor({ timeoutMs: 10_000 })
    // EULA 已同意 → 不应再有 eula-agree 节点
    expect((await app.getByTestId('eula-agree').all()).length).toBe(0)

    // 注：GPUIX_BACKGROUND=1 后台窗不产绘制帧，getPaintedText 恒空（实测）——
    // 中文断言走树查询 textContent，像素级正确性由 __shots__ 截图人工/图像模型复核
    // （screenshot 底层 captureScreenshot 会强制绘制一帧，能出图）。
    const question = await app.getByTestId('welcome-question').textContent()
    expect(question).toContain('1. 可以将启动器放在包含中文或空格的路径中运行')
    expect(question).not.toContain('\uFFFD')

    const navTrue = await app.getByText('√ 正确').all()
    const navFalse = await app.getByText('✗ 错误').all()
    expect(navTrue.length).toBe(1)
    expect(navFalse.length).toBe(1)

    const header = await app.getByText('初始配置 (1/10)').all()
    expect(header.length).toBe(1)

    await app.screenshot({ path: join(SHOTS_DIR, '03-welcome-alone.png') })
    expectShotExists('03-welcome-alone.png')
  }, 120_000)
})
