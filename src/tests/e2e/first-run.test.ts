/**
 * E2E 用例 1：首启全流程（真实进程，临时目录空 config → 首启路径）。
 *
 * 顺序契约（main.py check_first_launch 原版对齐）：EULA 先弹（压在问卷之上，
 * 拦截输入）→ 倒计时结束同意落盘 → 欢迎问答顶上 → 逐题作答 → 主界面。
 *
 * 修复记录：agreement_version 曾在页面无日期标记时落盘空字符串（fetch 兜底链
 * 全空），现以内容指纹兜底，保证非空且内容敏感。
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

/** 首启弹窗顺序（对齐 main.py 原版：agreement 先弹、同意后 welcome 顶上）：
 *  DialogHost 只渲染栈顶 → EULA 期间 welcome 不在树中，问卷必须先过协议。 */
describe('首启弹窗顺序', () => {
  it('EULA 独占栈顶，问卷在协议通过前不可达（原版等价行为）', async () => {
    session = await launchE2E()
    const app = session.app

    await app.getByTestId('eula-agree').waitFor({ timeoutMs: 10_000 })
    // EULA 期间 welcome 未挂载（只渲染栈顶）
    expect((await app.getByTestId('welcome-question').all()).length).toBe(0)
  })
})

describe('首启全流程（EULA 先行 → 欢迎问答 → 主界面）', () => {
  it('EULA 倒计时禁用 → 同意落盘 → 10 题问答 → first_run=false → 主界面出现', async () => {
    session = await launchE2E({ env: { EULA_COUNTDOWN_SECONDS: '2' } })
    const app = session.app

    // --- 里程碑 1：EULA 挂载（栈顶独占） ---
    await app.getByTestId('eula-agree').waitFor({ timeoutMs: 10_000 })

    // --- 里程碑 2：EULA 倒计时存在 ---
    const countdownNodes = await app.getByText('请仔细阅读协议内容').all()
    expect(countdownNodes.length).toBeGreaterThanOrEqual(1)

    // --- 里程碑 3：倒计时未结束时点击「我已阅读并同意」无效（config 不得落盘）---
    await app.getByTestId('eula-agree').click()
    await sleep(800)
    const premature = session.readConfig()
    expect(premature?.agreement_accepted).not.toBe(true) // 被禁用/被拦，未同意

    // --- 里程碑 4：倒计时结束（30s）后可同意，agreement_accepted/version 落盘 ---
    await app.getByText('您现在可以同意协议了').waitFor({ timeoutMs: 45_000 })
    await app.getByTestId('eula-agree').click()

    let agreed: Record<string, unknown> | null = null
    for (let i = 0; i < 40; i++) {
      const cfg = session.readConfig()
      if (cfg?.agreement_accepted === true) {
        agreed = cfg
        break
      }
      await sleep(250)
    }
    expect(agreed, 'eula agree 后 config.json 应写入 agreement_accepted=true').not.toBeNull()
    expect(typeof agreed?.agreement_version).toBe('string')
    expect((agreed?.agreement_version as string).length).toBeGreaterThan(0)

    // EULA 关闭后欢迎问答可见（截图：中文渲染抽检）
    await app.getByTestId('welcome-question').waitFor({ timeoutMs: 5_000 })
    await app.screenshot({ path: join(SHOTS_DIR, '01-welcome.png') })

    // --- 里程碑 5：逐题作答（10 题：选一个答案 → 下一题，末题「完成」）---
    for (let step = 1; step <= 10; step++) {
      await app.getByTestId('welcome-question').waitFor({ timeoutMs: 5_000 })
      const q = await app.getByTestId('welcome-question').textContent()
      expect(q.startsWith(`${step}.`)).toBe(true)

      // 交替作答（问卷不校验对错，仅需已答）；重绘有一帧延迟，点「下一题」带重试
      await app.getByTestId(step % 2 === 1 ? 'welcome-answer-true' : 'welcome-answer-false').click()
      let advanced = false
      for (let retry = 0; retry < 12 && !advanced; retry++) {
        await app.getByTestId('welcome-next').click()
        await sleep(250)
        if (step < 10) {
          const nodes = await app.getByTestId('welcome-question').all()
          if (nodes.length === 1) {
            const text = await app.getByTestId('welcome-question').textContent()
            advanced = text.startsWith(`${step + 1}.`)
          }
        } else {
          // 末题「完成」→ 对话框卸载
          advanced = (await app.getByTestId('welcome-question').all()).length === 0
        }
      }
      expect(advanced, `第 ${step} 题作答后应推进`).toBe(true)
    }

    // --- 里程碑 6：问答完成 → first_run=false 落盘 ---
    let firstRun: unknown
    for (let i = 0; i < 40; i++) {
      firstRun = session.readConfig()?.first_run
      if (firstRun === false) break
      await sleep(250)
    }
    expect(firstRun).toBe(false)

    // --- 里程碑 7：主界面出现（标题栏 + 侧栏 6 项 + 终端视图 + footer）---
    for (const nav of ['terminal', 'version', 'sync', 'extensions', 'settings', 'about']) {
      await app.getByTestId(`nav-${nav}`).waitFor({ timeoutMs: 5_000 })
    }
    await app.getByTestId('terminal-start').waitFor({ timeoutMs: 5_000 })
    await app.getByTestId('terminal-install').waitFor({ timeoutMs: 5_000 })
    await app.getByTestId('titlebar-close').waitFor({ timeoutMs: 5_000 })
    await app.getByTestId('theme-toggle').waitFor({ timeoutMs: 5_000 })

    // 终端空态（临时目录无 SillyTavern → 未安装文案）
    const emptyNodes = await app.getByText('尚未安装 SillyTavern').all()
    expect(emptyNodes.length).toBeGreaterThanOrEqual(1)

    await app.screenshot({ path: join(SHOTS_DIR, '02-main-terminal.png') })
    expectShotExists('01-welcome.png')
    expectShotExists('02-main-terminal.png')
  }, 120_000)
})
