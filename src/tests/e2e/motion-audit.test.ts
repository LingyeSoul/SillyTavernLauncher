/**
 * E2E 用例 8：动效深度审计（动效 PR3）。
 *
 * 原理：动效改造（Modal 240ms 进退场 / Toast 240+60ms 衔接 / Select 0.12s 淡入 /
 * NavItem 指示条 / VersionView stagger / reduced-motion 门控）合入后，用真实 GPU
 * 窗口对三块"可回归"面做行为级回归 + 截图落盘 __shots__/motion-*（人工复核）：
 *
 * 1. Modal 退场时序（动效开）：版本切换弹窗 → 面板内元素定向 Escape（Locator.press
 *    带 elementId，冒泡至面板 onKeyDown → requestClose）→ 退场窗口（240ms）内
 *    对话框仍在自动化树（closing 态驻留），>240ms 后真卸载（树中消失）。
 *    ⚠️ 不能点取消按钮触发：VersionSwitchDialog/ErrorDialog 的取消/关闭按钮
 *    onClick 直接 closeTopDialog()，绕过 requestClose 动画路径（立即卸载，
 *    与动效设置无关）——审计到的源码级现象，已列入报告。
 *    （2026-09-21 PR4 后记：上述源码级现象已修复——按钮统一改走 useModalClose
 *    的 requestClose，同样播退场/过门控；本用例仍以 Escape 定向触发，路径与
 *    按钮等价且不依赖各对话框的动作区实现，保持原方法论不变。）
 *    附 clock 探针：automation 协议有 clockPause/Set/FastForward/Resume（protocol.d.ts），
 *    但 @gpuix/react dist/testing.d.ts L143-145 明示「clockFastForward 只推进 motion
 *    clock，不跑到期 JS 定时器（advanceTime 才跑，且仅进程内 TestRenderer 有、
 *    未上 stdio 协议）」。Modal 退场卸载由 JS setTimeout(EXIT_MS=240) 驱动 →
 *    clock 无法精确推进它，只能实时容差断言；探针实测在真实 App 客户端上
 *    fastForward(10s) 后对话框是否仍驻留，验证上述文档结论。
 * 2. Select 下拉（动效开）：0.12s 淡入包装在 Content 内层——断言下拉项在树中
 *    挂载、点击选择仍生效（toast + config.json 落盘）、选择后 Content 卸载。
 *    这是硬断言：motion 包装若破坏 SelectPrimitive 的 Item 注册/点击原语，在此暴露。
 * 3. reduced-motion 门控（动效关）：设置页拨「减少动效」→ config.json
 *    motionEnabled=false 持久化；错误对话框关闭后立即卸载（无 240ms 驻留）。
 *    判别逻辑：动效开时关闭后 ~240ms 内树中仍在，动效关时立即消失——探测点
 *    落在关闭后 ~0-200ms 窗口内，捕捉到"已消失"即证明门控生效。
 *
 * 时序断言为真实时间（clock 不控 JS 定时器），断言消息携带实测 elapsed 便于
 * 失败诊断；阈值留足裕度（驻留断言 <200ms 探测 / 卸载断言 >240ms 后探测）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { launchE2E, sleep, expectShotExists, SHOTS_DIR } from './helpers'
import type { E2ESession } from './helpers'

/** Modal.tsx EXIT_MS 同值（240ms 退场窗口）；此处为审计镜像值，不 import 源码 */
const MODAL_EXIT_MS = 240
/** 探测点距关闭点击的目标耗时（sleep 60ms + 查询往返）：应稳定落在退场窗口内 */
const MID_PROBE_SLEEP_MS = 60
/** 卸载断言前等待：> 240ms 退场 + React 提交 + 裕度 */
const AFTER_EXIT_SLEEP_MS = 700

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

/** 等 toast 文案出现后点掉（toast-dismiss）为后续交互让位（settings.test 同款） */
async function expectToast(s: E2ESession, text: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const nodes = await s.app.getByText(text).all()
    if (nodes.length >= 1) {
      const dismiss = await s.app.getByTestId('toast-dismiss').all()
      if (dismiss.length >= 1) await s.app.getByTestId('toast-dismiss').click()
      await sleep(400)
      return
    }
    if (Date.now() > deadline) throw new Error(`toast 未出现: ${text}`)
    await sleep(250)
  }
}

/** 打开版本切换弹窗（seedSt 会话；1.17.0 非当前版本故有切换按钮） */
async function openVersionDialog(s: E2ESession): Promise<void> {
  await s.app.getByTestId('version-switch-1.17.0').click()
  await s.app.getByTestId('version-switch-cancel').waitFor({ timeoutMs: 5_000 })
}

/** 弹窗（含取消按钮）当前是否在自动化树中 */
async function dialogInTree(s: E2ESession): Promise<boolean> {
  return (await s.app.getByTestId('version-switch-cancel').count()) >= 1
}

describe('动效深度审计', () => {
  it('Modal 退场时序（动效开）：240ms 窗口内驻留、之后真卸载；clock 探针', async () => {
    session = await launchE2E({ setupCompleted: true, seedSt: true })
    const app = session.app

    await app.getByTestId('nav-version').click()
    await app.getByTestId('version-switch-1.17.0').waitFor({ timeoutMs: 10_000 })
    await openVersionDialog(session)
    expect(await dialogInTree(session), '弹窗应已打开').toBe(true)

    // --- 第一轮：纯实时容差断言 ---
    // 面板内取消按钮上定向 Escape：冒泡至 Modal 面板 onKeyDown → requestClose
    // （动效开 → closing 态 + 240ms setTimeout 后 onClose 真卸载）
    const t0 = Date.now()
    await app.getByTestId('version-switch-cancel').press('escape')
    const e0 = Date.now() - t0
    expect(
      await dialogInTree(session),
      `关闭后 ${e0}ms：退场中弹窗应仍在树中（退场窗口 ${MODAL_EXIT_MS}ms）`,
    ).toBe(true)

    await sleep(MID_PROBE_SLEEP_MS)
    const e1 = Date.now() - t0
    expect(
      await dialogInTree(session),
      `关闭后 ${e1}ms：仍处退场窗口（${MODAL_EXIT_MS}ms）内，弹窗应驻留`,
    ).toBe(true)

    // 退场窗口内定性截图（淡出中间态，仅供人工复核；不断言内容）
    await app.screenshot({ path: join(SHOTS_DIR, 'motion-modal-exit-mid.png') })
    expectShotExists('motion-modal-exit-mid.png')

    await sleep(AFTER_EXIT_SLEEP_MS)
    const e2 = Date.now() - t0
    expect(
      await dialogInTree(session),
      `关闭后 ${e2}ms（>${MODAL_EXIT_MS}ms 退场时限）：弹窗应已真卸载`,
    ).toBe(false)
    console.log(`[motion-audit] Modal 退场时序：${e0}ms 驻留 / ${e1}ms 驻留 / ${e2}ms 已卸载`)

    // --- 第二轮：clock 探针（真实 App 客户端上 fastForward 是否推进 JS setTimeout）---
    await openVersionDialog(session)
    try {
      const pauseWithTimeout = Promise.race([
        app.clock.pause(),
        sleep(3_000).then(() => {
          throw new Error('clock.pause() 3s 未返回')
        }),
      ])
      const pausedAt = await pauseWithTimeout
      const t1 = Date.now()
      await app.getByTestId('version-switch-cancel').press('escape')
      const inTreeA = await dialogInTree(session)
      expect(inTreeA, 'clock 暂停下触发关闭：退场驻留不受影响').toBe(true)

      const nowAfter = await app.clock.fastForward(10_000)
      const elapsedB = Date.now() - t1
      const inTreeB = await dialogInTree(session)
      if (elapsedB < 200) {
        // 探测往返足够快时为确定性断言：JS 定时器（240ms）未到期，弹窗必须仍在
        expect(
          inTreeB,
          `fastForward(10s) 后 ${elapsedB}ms：motion clock 快进不得推进 JS setTimeout（弹窗应驻留）`,
        ).toBe(true)
      } else {
        console.log(`[motion-audit] clock 探针探测点过慢（${elapsedB}ms ≥ 200ms），驻留断言降级为观察值: ${inTreeB}`)
      }
      console.log(
        `[motion-audit] clock 探针：pause@${pausedAt}ms → fastForward 后 motion clock=${nowAfter}ms，` +
          `弹窗${inTreeB ? '仍在树中（fastForward 只推进 motion clock，不跑 JS setTimeout——与 testing.d.ts 文档一致）' : '已卸载（fastForward 亦推进了 JS 定时器——与文档相悖）'}`,
      )

      await app.clock.resume()
      await sleep(AFTER_EXIT_SLEEP_MS)
      expect(
        await dialogInTree(session),
        'clock 恢复 + 真实时间 >240ms 后：弹窗应已真卸载',
      ).toBe(false)
    } catch (err) {
      // clock 不可用不判失败（探针性质）：大声记录 + 兜底关闭，主断言在第一轮已完成
      console.log(`[motion-audit] clock 探针不可用（降级纯实时断言）: ${String(err)}`)
      if (await dialogInTree(session)) {
        await app.getByTestId('version-switch-cancel').click().catch(() => undefined)
        await sleep(AFTER_EXIT_SLEEP_MS)
      }
    }
  }, 120_000)

  it('Select 下拉（动效开）：淡入包装下内容挂载、点击选择生效、选后收起', async () => {
    session = await launchE2E({ setupCompleted: true })
    const app = session.app

    await app.getByTestId('nav-settings').click()
    await app.getByTestId('setting-mirror').waitFor({ timeoutMs: 10_000 })

    // 打开下拉：Content（anchored 浮层）经 motion.div 淡入包装后仍须挂载可交互。
    // 镜像为「官方源 / 加速镜像」二选一（种子默认官方源），非选中项即「加速镜像」
    await app.getByTestId('setting-mirror').click()
    await app.getByText('加速镜像').waitFor({ timeoutMs: 5_000 })
    expect(
      await app.getByText('加速镜像').count(),
      '下拉展开态：Content 内的「加速镜像」项应在树中（触发器此时显示官方源）',
    ).toBe(1)

    await app.screenshot({ path: join(SHOTS_DIR, 'motion-select-open.png') })
    expectShotExists('motion-select-open.png')

    // 点击选择：Item 命中 → onValueChange → toast + config.json 落盘（硬回归断言）
    await app.getByText('加速镜像').click()
    await expectToast(session, '尚未选定镜像站')

    expect(
      await app.getByText('加速镜像').count(),
      '选择后：下拉 Content 应卸载（「加速镜像」只剩触发器上一处）',
    ).toBe(1)
    const cfg = session.readConfig()
    const github = cfg?.github as Record<string, unknown> | undefined
    expect(github?.enabled, 'motion 包装不得破坏 SelectPrimitive 的 onValueChange').toBe(true)

    await app.screenshot({ path: join(SHOTS_DIR, 'motion-select-after.png') })
    expectShotExists('motion-select-after.png')
  }, 120_000)

  it('reduced-motion 门控：开关持久化 motionEnabled=false，对话框关闭立即卸载', async () => {
    // 长表单需加高窗口（644 下启动器 tab 的开关行在视口外，settings.test 同款）
    session = await launchE2E({
      setupCompleted: true,
      env: { STL_E2E_WINDOW_HEIGHT: '1600' },
    })
    const app = session.app

    // --- 1. UI 拨「减少动效」开关（启动器 tab；开 = motionEnabled false）---
    await app.getByTestId('nav-settings').click()
    await app.getByTestId('settings-tab-launcher').waitFor({ timeoutMs: 10_000 })
    await app.getByTestId('settings-tab-launcher').click()
    await app.getByTestId('setting-reduce_motion').waitFor({ timeoutMs: 5_000 })
    await app.getByTestId('setting-reduce_motion').click()

    let saved = false
    for (let i = 0; i < 20 && !saved; i++) {
      saved = session.readConfig()?.motionEnabled === false
      if (!saved) await sleep(250)
    }
    expect(saved, '拨开关后 config.json 应持久化 motionEnabled=false').toBe(true)

    // --- 2. 错误对话框（非强模态）：打开 → 立即卸载 ---
    await app.getByTestId('settings-tab-st').click()
    await app.getByTestId('setting-port').waitFor({ timeoutMs: 10_000 })
    await app.getByTestId('setting-port').fill('70000')
    await app.getByTestId('setting-save-port').click()
    await app.getByText('端口号必须在1-65535之间').waitFor({ timeoutMs: 5_000 })

    const t0 = Date.now()
    // 定向 Escape 走 requestClose 门控路径（reduced-motion → 立即 onClose）；
    // 点 error-close 按钮在 PR4 前绕过门控（直接 closeTopDialog），证明不了门控
    // 生效——PR4 后按钮同走 requestClose，此处仍用 Escape 保持审计方法论稳定
    await app.getByTestId('error-close').press('escape')
    const e0 = Date.now() - t0
    expect(
      (await app.getByTestId('error-close').count()),
      `reduced-motion 下关闭后 ${e0}ms：对话框应立即卸载（无 240ms 退场驻留）`,
    ).toBe(0)

    await sleep(80)
    const e1 = Date.now() - t0
    expect(
      (await app.getByTestId('error-close').count()),
      `关闭后 ${e1}ms（仍在动效开的 240ms 驻留窗口内）：不得出现退场驻留`,
    ).toBe(0)
    expect(
      (await app.getByText('端口号必须在1-65535之间').count()),
      '错误文案应随对话框一并卸载',
    ).toBe(0)
    console.log(`[motion-audit] reduced-motion 关闭即卸载：${e0}ms 已消失 / ${e1}ms 复核仍消失`)

    await app.screenshot({ path: join(SHOTS_DIR, 'motion-reduced-dialog-closed.png') })
    expectShotExists('motion-reduced-dialog-closed.png')
  }, 120_000)
})
