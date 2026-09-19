/**
 * E2E 用例 2：六视图切换（种子 config 跳过首启 → 主界面直达）。
 * 依次点击侧栏 终端/版本/同步/扩展/设置/关于，断言各视图标志性元素（testId）。
 * 顺带对每个视图截图（中文渲染抽检，存 tests/e2e/__shots__/）。
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

/** 每个视图的标志性 testId（缺失 testId 的元素会在 waitFor 直接暴露为 Timeout） */
const VIEW_MARKERS: Array<{ nav: string; marker: string; shot: string }> = [
  { nav: 'terminal', marker: 'terminal-start', shot: 'view-terminal.png' },
  { nav: 'version', marker: 'version-refresh', shot: 'view-version.png' },
  { nav: 'sync', marker: 'sync-method', shot: 'view-sync.png' },
  { nav: 'extensions', marker: 'ext-git-install', shot: 'view-extensions.png' },
  { nav: 'settings', marker: 'setting-mirror', shot: 'view-settings.png' },
  { nav: 'about', marker: 'about-check-update', shot: 'view-about.png' },
]

describe('六视图切换', () => {
  it('依次点击侧栏六项，各视图标志性元素出现且视图标题正确', async () => {
    session = await launchE2E({ setupCompleted: true })
    const app = session.app

    // 主界面就绪（首启弹窗已被种子跳过）
    for (const nav of ['terminal', 'version', 'sync', 'extensions', 'settings', 'about']) {
      await app.getByTestId(`nav-${nav}`).waitFor({ timeoutMs: 10_000 })
    }

    // 各视图标题（唯一文本，getByText 要求恰好一个匹配）
    const TITLE_BY_NAV: Record<string, string> = {
      version: '版本管理',
      sync: '数据同步',
      extensions: '扩展管理',
    }

    for (const { nav, marker, shot } of VIEW_MARKERS) {
      await app.getByTestId(`nav-${nav}`).click()
      await app.getByTestId(marker).waitFor({ timeoutMs: 10_000 })
      if (TITLE_BY_NAV[nav]) {
        const nodes = await app.getByText(TITLE_BY_NAV[nav]).all()
        expect(
          nodes.length,
          `${nav} 视图标题「${TITLE_BY_NAV[nav]}」应渲染`,
        ).toBeGreaterThanOrEqual(1)
      }
      await sleep(300) // 视图入场动画（240ms）后截图
      await app.screenshot({ path: join(SHOTS_DIR, shot) })
      expectShotExists(shot)
    }

    // 切换过程不崩溃：回到终端视图仍可交互
    await app.getByTestId('nav-terminal').click()
    await app.getByTestId('terminal-start').waitFor({ timeoutMs: 5_000 })
  }, 120_000)

  it('种子 git 仓库下版本视图渲染版本卡片', async () => {
    session = await launchE2E({ setupCompleted: true, seedSt: true })
    const app = session.app

    await app.getByTestId('nav-version').click()
    // 卡片渲染 = getStTags 成功（错误路径下只有 EmptyState，无 switch 按钮）。
    // HEAD 携带 v1.18.0 → describe 判其为当前版本卡（[当前] 芯片，无 switch 按钮），
    // 故断言另两张卡的 switch 按钮。
    await app.getByTestId('version-switch-1.17.0').waitFor({ timeoutMs: 10_000 })
    await app.getByTestId('version-switch-1.16.0').waitFor({ timeoutMs: 5_000 })

    await sleep(300) // 视图入场动画（240ms）后截图
    await app.screenshot({ path: join(SHOTS_DIR, 'view-version-cards.png') })
    expectShotExists('view-version-cards.png')
  }, 120_000)
})
