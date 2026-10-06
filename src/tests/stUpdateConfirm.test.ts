/**
 * 询问模式启动编排（st_ask_before_update，2026-10-06）：
 * - needs-update：confirm true → updateSt({withAutoStart:true})；false → 跳过更新直接 startSt
 * - up-to-date / check-failed / no-git → startSt（与 checkAndStartSt 非 needs-update 分支语义一致）
 * - not-installed → 原样报错，既不更新也不启动
 * - needs-update 时终端日志写中性「等待选择」行——checkForStUpdate 自带的
 *   「正在更新...」message 在用户应答前是谎话，不得上屏
 * lifecycle 与 confirm 通道均为注入替身，零子进程零网络。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StUpdateCheckResult, StUpdateCheckStatus } from '../services/stLifecycle'
import { startStWithUpdateConfirm, useStState } from '../stores/stState'
import { useTerminalLogs } from '../stores/terminalLogs'

/** 构造 lifecycle 替身：三个编排入口全部 mock，调用即断言素材 */
function fakeLifecycle(check: StUpdateCheckResult) {
  return {
    checkForStUpdate: vi.fn(async (): Promise<StUpdateCheckResult> => check),
    updateSt: vi.fn(async (_options?: { withAutoStart?: boolean }) =>
      ({ ok: true, message: '更新完成' }) as const),
    // startSt 返回 StartStResult（多一个 proc 字段）：编排只消费 ok/message，
    // 替身补 null 保持结构兼容
    startSt: vi.fn(async () => ({ ok: true, message: '启动完成', proc: null }) as const),
  }
}

function checkOf(status: StUpdateCheckStatus, message: string): StUpdateCheckResult {
  return { status, message }
}

/**
 * 等待末行满足谓词并返回（引擎异步发射视觉行，appendLine 后 lines 非同步可见，
 * vi.waitFor 轮询——tests/terminalLogs.test.ts 同款时序处理）
 */
async function waitForLogLine(match: (text: string) => boolean): Promise<string> {
  let text = ''
  await vi.waitFor(
    () => {
      const lines = useTerminalLogs.getState().lines
      text = lines.length > 0 ? (lines[lines.length - 1]?.text ?? '') : ''
      if (!match(text)) throw new Error(`terminal log not ready, last="${text}"`)
    },
    { timeout: 2000, interval: 20 },
  )
  return text
}

beforeEach(() => {
  useTerminalLogs.getState().clear()
})

describe('startStWithUpdateConfirm（询问模式启动编排）', () => {
  it('needs-update + 用户确认更新 → updateSt({withAutoStart:true})，不另发 startSt', async () => {
    const lc = fakeLifecycle(checkOf('needs-update', '检测到新版本，正在更新...'))
    const confirm = vi.fn(async () => true)

    const result = await startStWithUpdateConfirm(lc, confirm)

    expect(result.ok).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(lc.updateSt).toHaveBeenCalledWith({ withAutoStart: true })
    expect(lc.startSt).not.toHaveBeenCalled()
  })

  it('needs-update + 用户选择跳过 → startSt 直接启动，不触发 updateSt', async () => {
    const lc = fakeLifecycle(checkOf('needs-update', '检测到新版本，正在更新...'))
    const confirm = vi.fn(async () => false)

    const result = await startStWithUpdateConfirm(lc, confirm)

    expect(result.ok).toBe(true)
    expect(lc.updateSt).not.toHaveBeenCalled()
    expect(lc.startSt).toHaveBeenCalledTimes(1)
  })

  it('needs-update 时终端日志写中性「等待选择」行，不谎报「正在更新」', async () => {
    const lc = fakeLifecycle(checkOf('needs-update', '检测到新版本，正在更新...'))
    await startStWithUpdateConfirm(lc, async () => true)
    expect(await waitForLogLine((t) => t.includes('等待选择是否更新'))).toContain('等待选择是否更新')

    // 跳过路径同款：应答前日志同样中性
    useTerminalLogs.getState().clear()
    const lc2 = fakeLifecycle(checkOf('needs-update', '检测到新版本，正在更新...'))
    await startStWithUpdateConfirm(lc2, async () => false)
    expect(await waitForLogLine((t) => t.includes('等待选择是否更新'))).toContain('等待选择是否更新')
  })

  it.each(['up-to-date', 'check-failed', 'no-git'] as const)(
    '%s → 直接 startSt，不打扰用户（confirm 不调用）',
    async (status) => {
      const lc = fakeLifecycle(checkOf(status, `状态-${status}`))
      const confirm = vi.fn(async () => true)

      const result = await startStWithUpdateConfirm(lc, confirm)

      expect(result.ok).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
      expect(lc.updateSt).not.toHaveBeenCalled()
      expect(lc.startSt).toHaveBeenCalledTimes(1)
      // 非 needs-update 的检查 message 照常上屏（与 checkAndStartSt 的 this.log 对齐）
      expect(await waitForLogLine((t) => t === `状态-${status}`)).toBe(`状态-${status}`)
    },
  )

  it('not-installed → 原样报错，既不更新也不启动', async () => {
    const lc = fakeLifecycle(checkOf('not-installed', 'SillyTavern未安装，请先安装'))

    const result = await startStWithUpdateConfirm(lc, async () => true)

    expect(result.ok).toBe(false)
    expect(result.message).toBe('SillyTavern未安装，请先安装')
    expect(lc.updateSt).not.toHaveBeenCalled()
    expect(lc.startSt).not.toHaveBeenCalled()
    expect(await waitForLogLine((t) => t === 'SillyTavern未安装，请先安装')).toBe('SillyTavern未安装，请先安装')
  })
})

describe('useStState 导出完整性（防误删编排入口）', () => {
  it('startSt 动作仍存在且为函数（询问分支在 startSt 内部接线）', () => {
    expect(typeof useStState.getState().startSt).toBe('function')
  })
})
