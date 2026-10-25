/**
 * 版本页副标题口径 + 挂载并行拉取（2026-09-21 修复「能启动酒馆却提示未安装」）。
 *
 * 背景：副标题此前只看 stState.currentVersion，为空一律显「未安装」。embedded 下
 * 当前版本读取曾耗时 40s+（见 isoGitCache.test.ts），窗口期内用户能启动酒馆、
 * 版本页却断言「未安装」——与事实相反。现口径：未安装只由安装态决定；读取中 →
 * 读取中...；已安装但读不出（非 Git 仓库/无 tag/失败）→ 未知。
 *
 * 同时锁死挂载并行：当前版本与版本列表必须同时发起（串行时列表被慢读阻塞，
 * 整页空窗）。用例用「永不 resolve 的 refreshVersion」作结构探针，不依赖耗时。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRenderer, TestRoot } from '@gpuix/react/testing'
import type { ReactElement, ReactNode } from 'react'

let tempDir: string
let originalCwd: string

beforeAll(() => {
  originalCwd = process.cwd()
  tempDir = mkdtempSync(join(tmpdir(), 'stl-verview-'))
  // config.json / SillyTavern 探测全部落在临时目录（app 模块按 cwd 解析）
  process.chdir(tempDir)
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(tempDir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

type AppModules = {
  VersionView: () => ReactElement
  executeVersionSwitch: typeof import('../ui/views/VersionView').executeVersionSwitch
  Modal: typeof import('../ui/components/Modal').Modal
  useModalClose: typeof import('../ui/components/Modal').useModalClose
  ThemeProvider: (props: { children: ReactNode }) => ReactElement
  TooltipProvider: (props: { children: ReactNode }) => ReactElement
  getConfigStore: typeof import('../services/configStore').getConfigStore
  getStLifecycle: typeof import('../stores/stState').getStLifecycle
  useStState: typeof import('../stores/stState').useStState
  useUiState: typeof import('../stores/uiState').useUiState
  useVersionState: typeof import('../stores/versionState').useVersionState
}

/** chdir 完成后才加载 app 模块（configStore 单例按 cwd 解析 config.json） */
async function loadApp(): Promise<AppModules> {
  const [
    { VersionView, executeVersionSwitch },
    { Modal, useModalClose },
    { ThemeProvider },
    { TooltipProvider },
    { getConfigStore },
    { getStLifecycle, useStState },
    { useUiState },
    { useVersionState },
  ] = await Promise.all([
    import('../ui/views/VersionView'),
    import('../ui/components/Modal'),
    import('../ui/theme'),
    import('../ui/components/Tooltip'),
    import('../services/configStore'),
    import('../stores/stState'),
    import('../stores/uiState'),
    import('../stores/versionState'),
  ])
  return {
    VersionView,
    executeVersionSwitch,
    Modal,
    useModalClose,
    ThemeProvider,
    TooltipProvider,
    getConfigStore,
    getStLifecycle,
    useStState,
    useUiState,
    useVersionState,
  }
}

let testRoot: TestRoot | null = null
const renderer = (): TestRenderer => {
  if (!testRoot) throw new Error('testRoot 未创建')
  return testRoot.renderer
}

async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  renderer().flush()
}

/** 点击（bounds 中心原生命中测试），随后 settle */
async function clickTestId(testId: string): Promise<void> {
  const el = renderer().findByTestId(testId)
  if (!el) throw new Error(`element ${testId} not found`)
  const bounds = renderer().getElementBounds(el.id)
  if (!bounds) throw new Error(`element ${testId} has no bounds`)
  renderer().nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await settle()
}

/** 版本页渲染：store 状态由各用例注入，两个加载动作一律替身（不触真实 git/文件） */
async function renderVersionView(
  app: AppModules,
  st: Partial<Parameters<AppModules['useStState']['setState']>[0]>,
  versionState: Partial<Parameters<AppModules['useVersionState']['setState']>[0]> = {},
  loaders: { refreshVersion?: () => Promise<void>; ensureVersions?: () => Promise<void> } = {},
): Promise<void> {
  app.useStState.setState({
    refreshVersion: async () => undefined,
    busy: { install: false, start: false, stop: false, update: false },
    ...st,
  })
  app.useVersionState.setState({
    versions: [],
    loading: false,
    error: null,
    ensureVersions: async () => undefined,
    reloadVersions: async () => undefined,
    ...versionState,
  })
  if (loaders.refreshVersion) app.useStState.setState({ refreshVersion: loaders.refreshVersion })
  if (loaders.ensureVersions) app.useVersionState.setState({ ensureVersions: loaders.ensureVersions })

  testRoot?.root.unmount()
  testRoot = createTestRoot()
  testRoot.root.render(
    <app.ThemeProvider>
      <app.TooltipProvider>
        <app.VersionView />
      </app.TooltipProvider>
    </app.ThemeProvider>,
  )
  await settle()
}

const SHA = '06bde939fb1e9c4c8d8641d810f0a916b5bce127'

describe('版本页副标题：未安装 / 读取中 / 未知 互斥', () => {
  it('已安装 + 读取中 → 「读取中...」，不得出现「未安装」', async () => {
    const app = await loadApp()
    await renderVersionView(
      app,
      { installed: true, currentVersion: null, versionLoading: true },
      {},
      { refreshVersion: () => new Promise<void>(() => undefined) },
    )

    const texts = renderer().getAllText()
    expect(texts).toContain('读取中...')
    expect(texts, '读取中不得断言未安装').not.toContain('未安装')
  })

  it('已安装 + 版本读不出 → 「未知」，不得出现「未安装」', async () => {
    const app = await loadApp()
    await renderVersionView(app, { installed: true, currentVersion: null, versionLoading: false })

    const texts = renderer().getAllText()
    expect(texts).toContain('未知')
    expect(texts).not.toContain('未安装')
  })

  it('未安装（ST 目录不完整）→ 「未安装」', async () => {
    const app = await loadApp()
    await renderVersionView(app, { installed: false, currentVersion: null, versionLoading: false })

    const texts = renderer().getAllText()
    expect(texts).toContain('未安装')
    expect(texts).not.toContain('未知')
  })

  it('读到版本 → 「当前 <版本> · Commit <短哈希>」；仅 commit 时不带空「当前」前缀', async () => {
    const app = await loadApp()
    await renderVersionView(app, {
      installed: true,
      currentVersion: { version: '1.19.0', commit: SHA },
      versionLoading: false,
    })
    expect(renderer().getAllText()).toContain('当前 1.19.0 · Commit 06bde93')

    await renderVersionView(app, {
      installed: true,
      currentVersion: { version: null, commit: SHA },
      versionLoading: false,
    })
    const texts = renderer().getAllText()
    expect(texts).toContain('Commit 06bde93')
    expect(texts, '无 tag 时不得拖一个空的「当前」').not.toContain('当前 ')
  })
})

describe('版本页挂载：当前版本与版本列表并行发起', () => {
  it('refreshVersion 挂起时，ensureVersions 仍被立即发起（不阻塞列表）', async () => {
    const app = await loadApp()
    const calls: string[] = []
    await renderVersionView(
      app,
      { installed: true, currentVersion: null, versionLoading: true },
      {},
      {
        // 永不 resolve：串行实现下 ensureVersions 永无机会被调用
        refreshVersion: () => {
          calls.push('version')
          return new Promise<void>(() => undefined)
        },
        ensureVersions: async () => {
          calls.push('list')
        },
      },
    )

    expect(calls, '两路须并行发起').toContain('version')
    expect(calls, '列表不得等当前版本读出').toContain('list')
  })

  it('点刷新同样两路并行（不串行等当前版本，避免两次各读一份 pack）', async () => {
    const app = await loadApp()
    const calls: string[] = []
    await renderVersionView(
      app,
      {
        installed: true,
        currentVersion: null,
        versionLoading: false,
        refreshVersion: () => {
          calls.push('version')
          return new Promise<void>(() => undefined)
        },
      },
      {
        reloadVersions: async () => {
          calls.push('reload')
        },
      },
    )
    calls.length = 0

    await clickTestId('version-refresh')

    expect(calls).toContain('version')
    expect(calls, '刷新时列表不得等当前版本读出').toContain('reload')
  })
})

const IDLE_BUSY = { install: false, start: false, stop: false, update: false }
const VERSION_ENTRY = {
  version: '1.13.0',
  tag: { commit: SHA, date: '2025-01-01T00:00:00.000Z', tag_name: '1.13.0' },
}

describe('版本切换参与目录级互斥（2026-10-25）', () => {
  it('busy 时切换按钮禁用，空闲时可用（同一 testId）', async () => {
    const app = await loadApp()
    const baseState = {
      installed: true,
      currentVersion: { version: '1.12.0', commit: SHA },
      versionLoading: false,
    }

    await renderVersionView(app, { ...baseState, busy: IDLE_BUSY }, { versions: [VERSION_ENTRY], loading: false })
    const idleButton = renderer().findByTestId('version-switch-1.13.0')
    if (!idleButton) throw new Error('version-switch-1.13.0 not found (idle)')
    expect(Number(idleButton.style.opacity ?? 1)).toBe(1)

    await renderVersionView(
      app,
      { ...baseState, busy: { ...IDLE_BUSY, update: true } },
      { versions: [VERSION_ENTRY], loading: false },
    )
    const busyButton = renderer().findByTestId('version-switch-1.13.0')
    if (!busyButton) throw new Error('version-switch-1.13.0 not found (busy)')
    // opacity 0.32 = Button disabled 表现（dt disabled-opacity）
    expect(Number(busyButton.style.opacity ?? 1)).toBeLessThanOrEqual(0.32 + 1e-9)
  })

  it('executeVersionSwitch 在 busy 时拒绝执行并 toast 警告', async () => {
    const app = await loadApp()
    const switchSpy = vi
      .spyOn(app.getStLifecycle(), 'switchStVersion')
      .mockResolvedValue({ ok: true, message: '不应执行' })
    const refresh = vi.fn()
    app.useStState.setState({
      busy: { ...IDLE_BUSY, install: true },
      refreshVersion: async () => undefined,
      refresh,
    })
    app.useUiState.setState({ toast: null, toastQueue: [], toastClosing: false })

    await app.executeVersionSwitch('1.13.0', SHA, '1.13.0')

    expect(switchSpy, '并发目录操作时不得改写工作区').not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    const toast = app.useUiState.getState().toast
    expect(toast?.kind).toBe('warning')
    expect(toast?.message).toContain('请等待完成后再切换版本')
    // 拒绝路径不得改动现有占用标记
    expect(app.useStState.getState().busy).toEqual({ ...IDLE_BUSY, install: true })
  })

  it.each([true, false])('切换期间占用 update 槽，ok=%s 结束后释放并刷新', async (ok) => {
    const app = await loadApp()
    let updateDuringSwitch: boolean | null = null
    const switchSpy = vi.spyOn(app.getStLifecycle(), 'switchStVersion').mockImplementation(async () => {
      updateDuringSwitch = app.useStState.getState().busy.update
      return { ok, message: ok ? '切换成功' : '切换失败' }
    })
    const refresh = vi.fn()
    app.useStState.setState({
      busy: IDLE_BUSY,
      refreshVersion: async () => undefined,
      refresh,
    })
    app.useUiState.setState({ toast: null, toastQueue: [], toastClosing: false })

    await app.executeVersionSwitch('1.13.0', SHA, '1.13.0')

    expect(switchSpy).toHaveBeenCalledWith({ version: '1.13.0', commit: SHA }, '1.13.0')
    expect(updateDuringSwitch, '切换执行期间必须占住 update 槽').toBe(true)
    expect(app.useStState.getState().busy, '成功/失败都必须释放').toEqual(IDLE_BUSY)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('Modal 快速双触发只结算一次（同步闩锁）', () => {
  it.each([
    ['无动画（同步结算）', false, 0],
    ['240ms 退场（定时器）', true, 300],
  ] as const)('%s：同帧两次 requestClose → onClose 仅一次', async (_label, motion, waitMs) => {
    const app = await loadApp()
    app.getConfigStore().set('motionEnabled', motion)

    function DoubleTriggerProbe() {
      const requestClose = app.useModalClose()
      return (
        <div
          testId="modal-double-trigger"
          onClick={() => {
            // 同一帧内连续两次触发：旧实现两次都看到 closing=false，各排一个定时器
            requestClose()
            requestClose()
          }}
          style={{ width: 40, height: 20 }}
        />
      )
    }

    const onClose = vi.fn()
    testRoot?.root.unmount()
    testRoot = createTestRoot()
    testRoot.root.render(
      <app.ThemeProvider>
        <app.Modal open onClose={onClose} actions={<DoubleTriggerProbe />}>
          <text>probe</text>
        </app.Modal>
      </app.ThemeProvider>,
    )
    await settle()

    await clickTestId('modal-double-trigger')
    if (waitMs > 0) await settle(waitMs)

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
