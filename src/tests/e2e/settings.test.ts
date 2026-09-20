/**
 * E2E 用例 3：设置页交互（种子 config 跳过首启）。
 * 切镜像下拉 → 切开关 → 改端口并保存 → 断言临时目录 config.json / SillyTavern/config.yaml 变化。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { launchE2E, sleep, SHOTS_DIR } from './helpers'
import type { E2ESession } from './helpers'

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

/** 等待 toast 文案出现；出现后点关闭为下一条腾位（toast 单例排队；最短 4s 自动
 *  驻留 > 250ms 轮询周期，断言必先于自动关闭命中。dismiss 若撞上自动到期仅无效） */
async function expectToast(session: E2ESession, text: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const nodes = await session.app.getByText(text).all()
    if (nodes.length >= 1) {
      // 关闭当前 toast（退场 240ms + 空档 60ms），让队列中的下一条可展示
      const dismiss = await session.app.getByTestId('toast-dismiss').all()
      if (dismiss.length >= 1) await session.app.getByTestId('toast-dismiss').click()
      await sleep(400)
      return
    }
    if (Date.now() > deadline) throw new Error(`toast 未出现: ${text}`)
    await sleep(250)
  }
}

/** 终端 section 在「启动器设置」tab 底部：窗口高度被屏幕钳制（如 1600 请求被压到
 *  ~1047 逻辑高）时元素可能在视口外，click 的窗口坐标落空。先在主区滚动容器上定点
 *  滚轮（固定窗口坐标，不依赖可能已滚出视口的元素；实测 deltaY 为负才向下滚），
 *  直到目标 bounds 进入视口带（y≤700）。 */
async function scrollSettingsIntoView(session: E2ESession, testId: string): Promise<void> {
  let prevY = Number.POSITIVE_INFINITY
  for (let i = 0; i < 12; i++) {
    const b = await session.app.getByTestId(testId).bounds()
    if (!b) throw new Error(`${testId} not found`)
    if (b.y >= 0 && b.y <= 700) return
    if (b.y >= prevY) throw new Error(`${testId} 滚动后 bounds 未收敛（y=${b.y}），wheel 可能未生效`)
    prevY = b.y
    // 主区内容固定点（侧栏 168 右侧、窗口中部），滚轮事件由 overflow:scroll 容器承接
    await session.app.mouse.wheel({ x: 600, y: 500 }, 0, -500)
    await sleep(250)
  }
  throw new Error(`${testId} 多次滚动后仍未进入视口`)
}

describe('设置页交互', () => {
  // BUG-S1 复核：取消 skip 实跑验证（saveLauncherConfig 走 configStore.save，
  // 临时目录可写；toast 队列 300ms 衔接已由 expectToast 的 dismiss+400ms 处理）。
  it('切镜像/切开关/改端口保存 → 临时目录配置文件变化（BUG-S1）', async () => {
    // BUG-S1 根因是 Switch 轨道吞点击（已修 ui/components/Switch.tsx）；另需加高窗口：
    // 设置页为长表单，644 高度下 checkupdate/端口行在视口外，后台自动化无法点击
    session = await launchE2E({
      setupCompleted: true,
      env: { STL_E2E_WINDOW_HEIGHT: '1600' },
    })
    const app = session.app

    await app.getByTestId('nav-settings').click()
    // 镜像已移入「环境」tab（默认激活），无需切 tab；更新检查仍在「启动器设置」tab
    await app.getByTestId('setting-mirror').waitFor({ timeoutMs: 10_000 })

    // --- 1. 切镜像下拉：github → gh-proxy.org ---
    await app.getByTestId('setting-mirror').click()
    // 下拉面板项（SelectPrimitive.Content 的 anchored 浮层）
    await app.getByText('镜像站点 (gh-proxy.org)').waitFor({ timeoutMs: 5_000 })
    await app.getByText('镜像站点 (gh-proxy.org)').click()
    await expectToast(session, '镜像配置已更新')

    let cfg = session.readConfig()
    const github = cfg?.github as Record<string, unknown> | undefined
    expect(github?.mirror, 'config.json github.mirror 应更新为 gh-proxy.org').toBe('gh-proxy.org')

    // --- 2. 切开关：checkupdate false → true（「启动器设置」tab）---
    await app.getByTestId('settings-tab-launcher').click()
    await app.getByTestId('setting-checkupdate').waitFor({ timeoutMs: 10_000 })
    await app.getByTestId('setting-checkupdate').click()
    await expectToast(session, '设置已保存')
    cfg = session.readConfig()
    expect(cfg?.checkupdate, 'config.json checkupdate 应为 true').toBe(true)

    // --- 3. 改端口并保存：8000 → 8123（落 ST 侧 config.yaml；端口在「酒馆设置」tab）---
    await app.getByTestId('settings-tab-st').click()
    await app.getByTestId('setting-port').fill('8123')
    await app.getByTestId('setting-save-port').click()
    await expectToast(session, '端口已保存，重启酒馆后生效')

    const yamlText = session.readStConfigYaml()
    expect(yamlText, '临时目录 SillyTavern/config.yaml 应被创建').not.toBeNull()
    const st = parseYaml(yamlText as string) as Record<string, unknown>
    expect(st.port, 'config.yaml port 应为 8123').toBe(8123)

    // --- 4. 端口非法输入被拦截（输入超范围 → 错误对话框，不落盘）---
    await app.getByTestId('setting-port').fill('70000')
    await app.getByTestId('setting-save-port').click()
    await app.getByText('端口号必须在1-65535之间').waitFor({ timeoutMs: 5_000 })
    const st2 = parseYaml(session.readStConfigYaml() as string) as Record<string, unknown>
    expect(st2.port, '非法端口不得落盘').toBe(8123)
    // 关闭错误对话框（避免遮挡后续交互）
    await app.getByTestId('error-close').click().catch(() => undefined)

    await app.screenshot({ path: join(SHOTS_DIR, 'settings-after.png') })
  }, 120_000)

  it('终端字体：字号下拉 + 自定义字体名保存 → config.json terminal.* 变化', async () => {
    session = await launchE2E({
      setupCompleted: true,
      env: { STL_E2E_WINDOW_HEIGHT: '1600' },
    })
    const app = session.app

    await app.getByTestId('nav-settings').click()
    // 终端 section 在「启动器设置」tab，先切 tab
    await app.getByTestId('settings-tab-launcher').click()
    await app.getByTestId('setting-terminal-font-size').waitFor({ timeoutMs: 10_000 })

    // --- 1. 字号下拉：默认 → 18 px（先滚入视口再交互）---
    await scrollSettingsIntoView(session, 'setting-terminal-font-size')
    await app.getByTestId('setting-terminal-font-size').click()
    await app.getByText('18 px').waitFor({ timeoutMs: 5_000 })
    await app.getByText('18 px').click()
    await expectToast(session, '设置已保存')
    let cfg = session.readConfig()
    let terminal = cfg?.terminal as Record<string, unknown> | undefined
    expect(terminal?.font_size, 'config.json terminal.font_size 应为 18').toBe(18)

    // --- 2. 自定义字体名：JetBrains Mono 落盘 ---
    await app.getByTestId('setting-terminal-font-custom').fill('JetBrains Mono')
    await app.getByTestId('setting-save-terminal-font').click()
    await expectToast(session, '设置已保存')
    cfg = session.readConfig()
    terminal = cfg?.terminal as Record<string, unknown> | undefined
    expect(terminal?.font_family, 'config.json terminal.font_family 应为 JetBrains Mono').toBe('JetBrains Mono')

    // --- 3. 空字体名被拦截（错误对话框，不落盘）---
    await app.getByTestId('setting-terminal-font-custom').fill('   ')
    await app.getByTestId('setting-save-terminal-font').click()
    await app.getByText('字体名称不能为空').waitFor({ timeoutMs: 5_000 })
    cfg = session.readConfig()
    terminal = cfg?.terminal as Record<string, unknown> | undefined
    expect(terminal?.font_family, '空字体名不得落盘').toBe('JetBrains Mono')
    await app.getByTestId('error-close').click().catch(() => undefined)

    await app.screenshot({ path: join(SHOTS_DIR, 'settings-terminal-font.png') })
  }, 120_000)

  // 智能滚动回归（2026-09-20）：环境 tab 在默认 644 窗口高下内容装得下，
  // 修复前真实窗口滚轮仍可把 overflow:scroll 容器推出越界偏移（实测内容位移
  // 34px 起且可把整窗绘制滚没）；SmartScrollArea 实测装得下时翻 'hidden'，
  // 非滚动容器 → 滚轮必须无效（bounds 纹丝不动）
  it('环境 tab 内容装得下：滚轮无效（无越界偏移）', async () => {
    session = await launchE2E({ setupCompleted: true })
    const app = session.app

    await app.getByTestId('nav-settings').click()
    await app.getByTestId('setting-start-cmd').waitFor({ timeoutMs: 10_000 })
    // SmartScrollArea 测量在挂载后 ~16ms 轮询完成，留出翻 'hidden' 的时间
    await sleep(600)

    const before = await app.getByTestId('setting-start-cmd').bounds()
    expect(before, 'setting-start-cmd 应有 bounds').not.toBeNull()
    // 环境卡底部（before.y+height）应在窗口内：内容确实装得下（前提自检）
    expect(before!.y + before!.height).toBeLessThan(644)

    // 连续下压滚轮（内容区固定坐标），内容不得位移
    for (let i = 0; i < 3; i++) {
      await app.mouse.wheel({ x: 600, y: 400 }, 0, -400)
      await sleep(150)
    }
    const after = await app.getByTestId('setting-start-cmd').bounds()
    expect(after!.y, '装得下的内容被滚轮推移（智能滚动失效）').toBe(before!.y)

    // 顶栏为固定区，同样不得受滚轮影响
    const tabBefore = await app.getByTestId('settings-tab-env').bounds()
    await app.mouse.wheel({ x: 600, y: 400 }, 0, -400)
    await sleep(300)
    const tabAfter = await app.getByTestId('settings-tab-env').bounds()
    expect(tabAfter!.y, '固定头被滚轮推移（越界偏移破坏绘制）').toBe(tabBefore!.y)

    await app.screenshot({ path: join(SHOTS_DIR, 'settings-smart-scroll.png') })
  }, 120_000)
})
