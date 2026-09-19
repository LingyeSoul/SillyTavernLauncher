/**
 * E2E 用例 5：退出路径（种子 config，无 ST 运行）。
 * 侧栏「退出启动器」→ ST 未运行应直接退出（进程结束，无确认弹窗），
 * 退出时 config 落盘（process.on('exit') → saveOnExit）。
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

describe('退出路径', () => {
  it('无 ST 运行时点击退出 → 进程直接结束且退出时保存配置', async () => {
    session = await launchE2E({ setupCompleted: true })
    const app = session.app
    const pid = session.pid

    await app.getByTestId('exit-launcher').waitFor({ timeoutMs: 10_000 })

    await app.getByTestId('exit-launcher').click()

    // 无 ST 运行 → 不弹确认框，进程应在数秒内退出
    let exited = false
    for (let i = 0; i < 60 && !exited; i++) {
      exited = !pidAlive(pid)
      if (!exited) await sleep(250)
    }
    expect(exited, '点击退出后子进程应在 15s 内结束').toBe(true)

    // 退出钩子保存配置（种子 config 回写为当前状态）
    let saved: Record<string, unknown> | null = null
    for (let i = 0; i < 20; i++) {
      saved = session.readConfig()
      if (saved) break
      await sleep(250)
    }
    expect(saved, '退出时 process exit 钩子应保存 config.json').not.toBeNull()
    expect(saved?.first_run).toBe(false)

    // cleanup 对已死进程安全（幂等）
    await session.cleanup()
    session = null
  }, 120_000)
})
