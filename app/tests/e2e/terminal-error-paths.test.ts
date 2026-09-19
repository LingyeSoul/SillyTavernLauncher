/**
 * E2E 用例 4：终端按钮异常路径（临时目录无 SillyTavern/ 且无 env/）。
 * - 点「启动」：首次启动先过年龄确认 → 确认后走 startSt → 未安装 →
 *   必须有错误反馈（toast/日志），不得静默、不得崩溃；has_started_st 落盘。
 * - 点「安装」：确认对话框出现 → 取消 → 日志「用户取消安装」。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { launchE2E, sleep, pidAlive } from './helpers'
import type { E2ESession } from './helpers'

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

describe('终端按钮异常路径（无 SillyTavern 环境）', () => {
  // BUG-T1 复核：静态链路完整（onConfirm → has_started_st 落盘 → startSt →
  // not-installed 日志 + toast；getByText 为子串匹配）。取消 skip 实跑验证。
  it('启动 → 年龄确认 → 未安装错误反馈（不崩溃）；安装 → 确认框 → 取消留痕（BUG-T1）', async () => {
    session = await launchE2E({ setupCompleted: true })
    const app = session.app

    await app.getByTestId('terminal-start').waitFor({ timeoutMs: 10_000 })

    // --- 1. 点「启动」→ 首次启动弹出年龄确认对话框 ---
    await app.getByTestId('terminal-start').click()
    await app.getByTestId('age-confirm').waitFor({ timeoutMs: 5_000 })
    await app.getByTestId('age-checkbox').waitFor({ timeoutMs: 5_000 })

    // 勾选年龄确认 → 点「确认启动」
    await app.getByTestId('age-checkbox').click()
    await sleep(250)
    await app.getByTestId('age-confirm').click()

    // --- 2. 未安装：必须出现错误反馈（toast 或终端日志），且应用不崩溃 ---
    let feedback = 0
    for (let i = 0; i < 40 && feedback === 0; i++) {
      const nodes = await app.getByText('SillyTavern未安装').all()
      feedback = nodes.length
      if (feedback === 0) await sleep(250)
    }
    expect(feedback, '启动未安装的 ST 必须有 toast/日志反馈，不得静默').toBeGreaterThanOrEqual(1)

    // 应用仍存活且可交互（没有崩溃）
    expect(pidAlive(session.pid)).toBe(true)
    await app.getByTestId('nav-terminal').waitFor({ timeoutMs: 5_000 })

    // 首次启动标记落盘（has_started_st 在确认后置 true）
    let hasStarted: unknown
    for (let i = 0; i < 20; i++) {
      hasStarted = session.readConfig()?.has_started_st
      if (hasStarted === true) break
      await sleep(250)
    }
    expect(hasStarted).toBe(true)

    // --- 3. 点「安装」→ 年龄确认（安装模式）→ 取消 → 日志留痕 ---
    await app.getByTestId('terminal-install').click()
    await app.getByTestId('age-confirm').waitFor({ timeoutMs: 5_000 })
    await app.getByTestId('age-cancel').click()

    await app.getByText('用户取消安装').waitFor({ timeoutMs: 5_000 })

    // 取消后对话框关闭、应用仍存活
    let ageGone = false
    for (let i = 0; i < 20 && !ageGone; i++) {
      ageGone = (await app.getByTestId('age-confirm').all()).length === 0
      if (!ageGone) await sleep(250)
    }
    expect(ageGone, '取消后年龄确认对话框应关闭').toBe(true)
    expect(pidAlive(session.pid)).toBe(true)
  }, 120_000)
})
