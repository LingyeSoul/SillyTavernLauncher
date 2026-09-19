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

/** 等待 toast 文案出现；出现后点关闭为下一条腾位（toast 单例排队且不自动消失） */
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

    // --- 2. 切开关：checkupdate false → true ---
    await app.getByTestId('setting-checkupdate').click()
    await expectToast(session, '设置已保存')
    cfg = session.readConfig()
    expect(cfg?.checkupdate, 'config.json checkupdate 应为 true').toBe(true)

    // --- 3. 改端口并保存：8000 → 8123（落 ST 侧 config.yaml）---
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
})
