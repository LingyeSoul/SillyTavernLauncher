/**
 * UI 冒烟测试：createTestRoot()（@gpuix/react/testing）渲染外壳/视图/对话框，
 * 按钮点击 → store 变化（testId 定位 + 断言）。
 *
 * - 运行前 chdir 到临时目录：config.json / agreement_cache.json 等落盘不污染仓库
 *   （静态导入会被提升，所有 app 模块经动态 import 在 chdir 之后加载）。
 * - 并发根的 commit 异步：每次交互后 settle()（宏任务 + flush）再断言。
 * - 不触发真实子进程：终端按钮只测"清空"（纯 store 操作）；启动/安装类按钮
 *   仅断言 disabled 态存在。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'
import type { ReactElement, ReactNode } from 'react'
import type { TestRenderer, TestRoot } from '@gpuix/react/testing'

let tempDir: string
let originalCwd: string

/** chdir 完成后才加载 app 模块（configStore 单例按 cwd 解析 config.json） */
type AppModule = {
  AppShell: () => ReactElement
  DialogHost: () => ReactElement | null
  ThemeProvider: (props: { children: ReactNode }) => ReactElement
  TooltipProvider: (props: { children: ReactNode }) => ReactElement
  useUiState: typeof import('../stores/uiState').useUiState
  useTerminalLogs: typeof import('../stores/terminalLogs').useTerminalLogs
}

async function loadApp(): Promise<AppModule> {
  const [{ AppShell }, { DialogHost }, { ThemeProvider }, { TooltipProvider }, { useUiState }, { useTerminalLogs }] =
    await Promise.all([
      import('../ui/shell/AppShell'),
      import('../ui/dialogs/DialogHost'),
      import('../ui/theme'),
      import('../ui/components/Tooltip'),
      import('../stores/uiState'),
      import('../stores/terminalLogs'),
    ])
  return { AppShell, DialogHost, ThemeProvider, TooltipProvider, useUiState, useTerminalLogs }
}

let testRoot: TestRoot
let renderer: TestRenderer
let app: AppModule

/** 并发根 commit 是异步的：等一个宏任务再驱动 GPUI 渲染管线 */
async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  renderer.flush()
}

async function clickTestId(testId: string): Promise<void> {
  const el = renderer.findByTestId(testId)
  if (!el) throw new Error(`element ${testId} not found`)
  const bounds = renderer.getElementBounds(el.id)
  if (!bounds) throw new Error(`element ${testId} has no bounds`)
  renderer.nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await settle()
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** 每个对话框用例前清空 UI 栈，避免上一用例的浮层遮挡命中 */
async function resetUiStack(): Promise<void> {
  app.useUiState.setState({ dialogs: [], toast: null, toastQueue: [], toastClosing: false })
  await settle()
}

beforeAll(async () => {
  originalCwd = process.cwd()
  tempDir = mkdtempSync(join(tmpdir(), 'stl-ui-smoke-'))
  process.chdir(tempDir)

  app = await loadApp()
  // 关闭动效：Modal/Toast 退场立即结算，测试时序确定化（§6.B reduced-motion 门控）
  const { getConfigStore } = await import('../services/configStore')
  getConfigStore().set('motionEnabled', false)

  testRoot = createTestRoot({ width: 800, height: 644 })
  renderer = testRoot.renderer
  testRoot.root.render(
    <app.ThemeProvider>
      <app.TooltipProvider>
        {/* 单一根包装（与 app.tsx 同构：根级兄弟含 anchored 浮层会顶掉基础树）。
            ToastHost 已并入 AppShell 内部，不再单独挂载 */}
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <app.DialogHost />
          <app.AppShell />
        </div>
      </app.TooltipProvider>
    </app.ThemeProvider>,
  )
  await settle()
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(tempDir, { recursive: true, force: true })
})

describe('AppShell 视图切换与终端（smoke）', () => {
  it('外壳渲染：侧栏导航 6 项齐全', () => {
    for (const id of ['nav-terminal', 'nav-version', 'nav-sync', 'nav-extensions', 'nav-settings', 'nav-about']) {
      expect(renderer.findByTestId(id)).toBeDefined()
    }
    expect(renderer.findByText('SillyTavernLauncher')).toBeDefined()
  })

  it('点击导航切换视图（terminal → settings → about）', async () => {
    expect(app.useUiState.getState().view).toBe('terminal')
    await clickTestId('nav-settings')
    expect(app.useUiState.getState().view).toBe('settings')
    await settle()
    expect(renderer.findByTestId('setting-mirror')).toBeDefined()

    await clickTestId('nav-about')
    expect(app.useUiState.getState().view).toBe('about')
    await settle()
    expect(renderer.findByTestId('about-check-update')).toBeDefined()

    await clickTestId('nav-terminal')
    expect(app.useUiState.getState().view).toBe('terminal')
  })

  it('版本/同步/扩展视图渲染不崩', async () => {
    await clickTestId('nav-version')
    expect(renderer.findByTestId('version-refresh')).toBeDefined()

    await clickTestId('nav-sync')
    expect(renderer.findByTestId('sync-server-switch')).toBeDefined()

    await clickTestId('nav-extensions')
    expect(renderer.findByTestId('ext-git-install')).toBeDefined()
    expect(renderer.findByTestId('ext-zip-install')).toBeDefined()
  })

  it('终端日志流：append 行渲染 + 清空按钮清空 store', async () => {
    await clickTestId('nav-terminal')
    // 此前用例（版本视图加载）可能已写入日志行，先清零再断言
    app.useTerminalLogs.getState().clear()
    await settle()
    app.useTerminalLogs.getState().appendBatch([
      { text: 'smoke-line-1' },
      { text: 'smoke-line-2' },
      { text: 'smoke-error-3', stream: 'stderr' },
    ])
    await settle()
    expect(renderer.findByText('smoke-line-1')).toBeDefined()
    expect(app.useTerminalLogs.getState().lines.length).toBe(3)

    await clickTestId('terminal-clear')
    expect(app.useTerminalLogs.getState().lines.length).toBe(0)
    await settle()
    expect(renderer.findByText('smoke-line-1')).toBeUndefined()
  })

  it('ST 未运行时停止按钮禁用（busy 反馈纪律）', async () => {
    await clickTestId('nav-terminal')
    const stop = renderer.findByTestId('terminal-stop')
    if (!stop) throw new Error('terminal-stop not found')
    // opacity 0.32 = disabled 表现（dt disabled-opacity）
    expect(Number(stop.style.opacity ?? 1)).toBeLessThanOrEqual(0.32 + 1e-9)
  })
})

describe('Toast 队列（smoke）', () => {
  it('pushToast 展示 + 手动关闭', async () => {
    app.useUiState.getState().pushToast('success', 'smoke-toast-message')
    await settle()
    expect(renderer.findByTestId('toast-dismiss')).toBeDefined()
    expect(renderer.findByText('smoke-toast-message')).toBeDefined()

    await clickTestId('toast-dismiss')
    // 退场 240ms（toastClosing 闩锁）
    await sleep(340)
    await settle()
    expect(app.useUiState.getState().toast).toBeNull()
  })
})

describe('对话框（smoke）', () => {
  it('欢迎问答：作答 10 题后完成并写 first_run=false', async () => {
    app.useUiState.getState().openDialog({ kind: 'welcome' })
    await settle()
    expect(renderer.findByTestId('welcome-question')).toBeDefined()
    expect(renderer.findByTestId('welcome-answer-true')).toBeDefined()

    for (let step = 0; step < 10; step++) {
      await clickTestId('welcome-answer-true')
      await clickTestId('welcome-next')
    }
    // 完成后对话框关闭
    expect(app.useUiState.getState().dialogs.length).toBe(0)
    const { getConfigStore } = await import('../services/configStore')
    expect(getConfigStore().get<boolean>('first_run', true)).toBe(false)
  })

  it('退出确认：取消/确认回调正确', async () => {
    const onConfirm = vi.fn()
    app.useUiState.getState().openDialog({ kind: 'exitConfirm', onConfirm })
    await settle()
    expect(renderer.findByTestId('exit-confirm-cancel')).toBeDefined()

    await clickTestId('exit-confirm-cancel')
    expect(app.useUiState.getState().dialogs.length).toBe(0)
    expect(onConfirm).not.toHaveBeenCalled()

    app.useUiState.getState().openDialog({ kind: 'exitConfirm', onConfirm })
    await settle()
    await clickTestId('exit-confirm-stop')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(app.useUiState.getState().dialogs.length).toBe(0)
  })

  it('错误对话框：标题/正文/复制按钮渲染', async () => {
    app.useUiState.getState().openDialog({
      kind: 'error',
      title: 'smoke-error-title',
      message: 'smoke-error-message',
      detail: 'smoke-error-detail',
    })
    await settle()
    expect(renderer.findByText('smoke-error-title')).toBeDefined()
    expect(renderer.findByText('smoke-error-message')).toBeDefined()
    expect(renderer.findByTestId('error-copy')).toBeDefined()
    app.useUiState.getState().closeTopDialog()
    await settle()
  })

  it('年龄确认：勾选前确认按钮禁用，勾选后可点', async () => {
    const onConfirm = vi.fn()
    app.useUiState.getState().openDialog({ kind: 'ageConfirm', mode: 'install', onConfirm })
    await settle()
    const confirm = renderer.findByTestId('age-confirm')
    if (!confirm) throw new Error('age-confirm not found')
    expect(Number(confirm.style.opacity ?? 1)).toBeLessThanOrEqual(0.32 + 1e-9)

    await clickTestId('age-checkbox')
    const confirmAfter = renderer.findByTestId('age-confirm')
    if (!confirmAfter) throw new Error('age-confirm not found after check')
    expect(Number(confirmAfter.style.opacity ?? 1)).toBeGreaterThan(0.9)

    await clickTestId('age-confirm')
    expect(onConfirm).toHaveBeenCalledWith(true)
    expect(app.useUiState.getState().dialogs.length).toBe(0)
  })
})
