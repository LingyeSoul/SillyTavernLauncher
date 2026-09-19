/**
 * Toast 自动关闭（uiState store 层）：分级驻留、队列推进重新计时、
 * 手动关闭与自动到期竞态不复活、到期走 300ms 衔接闩锁。
 * 纯 store 测试不挂 GPU 渲染；fake timers 推进时序。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigStore } from '../services/configStore'

interface UiStateModule {
  useUiState: {
    getState: () => { toast: { id: number; kind: string; message: string } | null; toastQueue: unknown[]; toastClosing: boolean; pushToast: (kind: string, message: string) => void; dismissToast: () => void }
  }
  TOAST_AUTO_MS: Record<string, number>
  uiStateActions: { pushToast: (kind: string, message: string) => void }
}

/** fresh module：configStore 单例指向临时目录（不污染仓库 cwd），uiState 随之重建 */
async function freshStores(tempDir: string): Promise<UiStateModule & { config: ConfigStore }> {
  vi.resetModules()
  const configMod = await import('../services/configStore')
  const config = configMod.getConfigStore(join(tempDir, 'config.json')) as ConfigStore
  const ui = (await import('../stores/uiState')) as unknown as UiStateModule
  return { ...ui, config }
}

let tempDir: string

beforeEach(() => {
  vi.useFakeTimers()
  tempDir = mkdtempSync(join(tmpdir(), 'stl-toast-'))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  rmSync(tempDir, { force: true, recursive: true })
})

describe('Toast 自动关闭（DEVIATION: 分级驻留）', () => {
  it('info 到期自动关闭，且经 toastClosing 闩锁退场', async () => {
    const { useUiState, TOAST_AUTO_MS } = await freshStores(tempDir)
    useUiState.getState().pushToast('info', 'msg')
    expect(useUiState.getState().toast).not.toBeNull()

    // 驻留期内不消失；到期瞬间进入 closing 闩锁（走 dismissToast 统一路径）
    vi.advanceTimersByTime(TOAST_AUTO_MS.info - 1)
    expect(useUiState.getState().toastClosing).toBe(false)
    vi.advanceTimersByTime(1)
    expect(useUiState.getState().toastClosing).toBe(true)

    // 退场 240ms 后清空
    vi.advanceTimersByTime(240)
    expect(useUiState.getState().toast).toBeNull()
  })

  it('error 驻留长于 info：4s 仍在，8s 后关闭', async () => {
    const { useUiState, TOAST_AUTO_MS } = await freshStores(tempDir)
    useUiState.getState().pushToast('error', 'boom')
    vi.advanceTimersByTime(TOAST_AUTO_MS.info)
    expect(useUiState.getState().toast).not.toBeNull()
    vi.advanceTimersByTime(TOAST_AUTO_MS.error - TOAST_AUTO_MS.info + 240)
    expect(useUiState.getState().toast).toBeNull()
  })

  it('队列推进后为下一条按其语义重新计时', async () => {
    const { useUiState, TOAST_AUTO_MS } = await freshStores(tempDir)
    useUiState.getState().pushToast('info', 'A')
    useUiState.getState().pushToast('error', 'B')

    // A 到期（4s）→ 闩锁 300ms（退场 240 + 空档 60）→ B 展示
    vi.advanceTimersByTime(TOAST_AUTO_MS.info + 240 + 60)
    expect(useUiState.getState().toast?.message).toBe('B')
    expect(useUiState.getState().toastClosing).toBe(false)

    // B 是 error：从展示起重新计 8s，中途不消失
    vi.advanceTimersByTime(TOAST_AUTO_MS.info)
    expect(useUiState.getState().toast?.message).toBe('B')
    vi.advanceTimersByTime(TOAST_AUTO_MS.error - TOAST_AUTO_MS.info + 240)
    expect(useUiState.getState().toast).toBeNull()
  })

  it('手动关闭后自动定时器作废，不复活', async () => {
    const { useUiState, TOAST_AUTO_MS } = await freshStores(tempDir)
    useUiState.getState().pushToast('success', 'saved')
    useUiState.getState().dismissToast()

    // 手动退场结算后，推进远超自动驻留时长：不得因残留定时器复活/报错
    vi.advanceTimersByTime(TOAST_AUTO_MS.error + 1000)
    expect(useUiState.getState().toast).toBeNull()
  })
})
