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
import { layout } from '../theme'

/**
 * windowControl 替身：只把 closeWindow 覆写为"投递成功"。ST 未运行时点击关闭按钮
 * 若投递失败会落进 AppShell.requestClose 的 quitLauncher 兜底——真实 quitLauncher
 * 会 process.exit 掉测试宿主。其余 API 保持真实实现（非 win32 宿主下本就是安全降级）。
 */
vi.mock('../services/windowControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/windowControl')>()
  return { ...actual, closeWindow: () => true }
})

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
  useSettings: typeof import('../stores/settings').useSettings
  useStState: typeof import('../stores/stState').useStState
}

async function loadApp(): Promise<AppModule> {
  const [{ AppShell }, { DialogHost }, { ThemeProvider }, { TooltipProvider }, { useUiState }, { useTerminalLogs }, { useSettings }, { useStState }] =
    await Promise.all([
      import('../ui/shell/AppShell'),
      import('../ui/dialogs/DialogHost'),
      import('../ui/theme'),
      import('../ui/components/Tooltip'),
      import('../stores/uiState'),
      import('../stores/terminalLogs'),
      import('../stores/settings'),
      import('../stores/stState'),
    ])
  return { AppShell, DialogHost, ThemeProvider, TooltipProvider, useUiState, useTerminalLogs, useSettings, useStState }
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
    // 品牌位移入自绘标题栏（侧栏左上角仍按要求不放标识）：应用名现在挂在
    // titlebar-brand 下，侧栏导航区不含它
    expect(renderer.findByTestId('titlebar-brand')).toBeDefined()
    expect(renderer.getAllText()).toContain('SillyTavernLauncher')
  })

  it('点击导航切换视图（terminal → settings → about）', async () => {
    expect(app.useUiState.getState().view).toBe('terminal')
    await clickTestId('nav-settings')
    expect(app.useUiState.getState().view).toBe('settings')
    await settle()
    // 镜像项已移入「环境」页（默认激活）
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

  it('ANSI 彩色段同行内联（回归：纯 div 会纵向堆叠）', async () => {
    await clickTestId('nav-terminal')
    app.useTerminalLogs.getState().clear()
    await settle()
    // 引擎解析 SGR：绿 AAA + 默认色 BBB，两段应渲染在同一行（y 相同、x 相接）
    app.useTerminalLogs.getState().appendLine('\x1b[32mAAA-SEG \x1b[0mBBB-SEG')
    await settle()
    const aaa = renderer.findByText('AAA-SEG ')
    const bbb = renderer.findByText('BBB-SEG')
    expect(aaa).toBeDefined()
    expect(bbb).toBeDefined()
    const a = renderer.getElementBounds(aaa!.id)
    const b = renderer.getElementBounds(bbb!.id)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    // 同行为本断言核心；同行内 x 递增（bbb 紧跟 aaa 右侧）
    expect(b!.y).toBe(a!.y)
    expect(b!.x).toBe(a!.x + a!.width)
  })

  it('ST 未运行时停止按钮禁用（busy 反馈纪律）', async () => {
    await clickTestId('nav-terminal')
    const stop = renderer.findByTestId('terminal-stop')
    if (!stop) throw new Error('terminal-stop not found')
    // opacity 0.32 = disabled 表现（dt disabled-opacity）
    expect(Number(stop.style.opacity ?? 1)).toBeLessThanOrEqual(0.32 + 1e-9)
  })
})

describe('设置页分 tab（smoke）', () => {
  it('环境/酒馆/启动器三页切换，各自控件渲染且互斥', async () => {
    await resetUiStack()
    await clickTestId('nav-settings')
    await settle()
    // 默认「环境」页：环境模式下拉/镜像与工具在页，酒馆/启动器项不在
    expect(renderer.findByTestId('setting-env-mode')).toBeDefined()
    expect(renderer.findByTestId('setting-mirror')).toBeDefined()
    expect(renderer.findByTestId('setting-check-env')).toBeDefined()
    expect(renderer.findByTestId('setting-port')).toBeUndefined()

    // 「酒馆设置」页：启动参数/网络/酒馆更新
    await clickTestId('settings-tab-st')
    await settle()
    expect(renderer.findByTestId('setting-port')).toBeDefined()
    expect(renderer.findByTestId('setting-custom-args')).toBeDefined()
    expect(renderer.findByTestId('setting-stcheckupdate')).toBeDefined()
    expect(renderer.findByTestId('setting-check-env')).toBeUndefined()

    // 「启动器设置」页：启动器行为/终端（镜像已移入环境页）
    await clickTestId('settings-tab-launcher')
    await settle()
    expect(renderer.findByTestId('setting-checkupdate')).toBeDefined()
    expect(renderer.findByTestId('setting-terminal-font-size')).toBeDefined()
    expect(renderer.findByTestId('setting-mirror')).toBeUndefined()
    expect(renderer.findByTestId('setting-port')).toBeUndefined()
    await resetUiStack()
  })

  it('embedded 模式：常驻警告 hint + 体检按钮专属文案 + 体检恒通过 toast', async () => {
    await resetUiStack()
    await clickTestId('nav-settings')
    // 上一用例可能把 tab 留在酒馆/启动器（activeTab 是组件态，导航不重置）——先回环境页
    await clickTestId('settings-tab-env')
    await settle()
    // 直改 store 落 embedded（不经 Select——那会触发兼容性风险确认对话框）
    app.useSettings.getState().update({ envMode: 'embedded' })
    await settle()
    // update 的"设置已保存"toast 副产物先清空（单例槽位），保证后续体检 toast 直接上屏
    await resetUiStack()

    // D4：embedded 激活期间常驻警告 hint
    expect(renderer.findByTestId('setting-env-mode-warning')).toBeDefined()
    // §5.4：体检按钮 embedded 专属文案（区别于 portable 的"检查内置环境"）
    expect(renderer.findByText('检查内置运行时')).toBeDefined()

    // 体检 embedded 分支：exe 自身即运行时恒通过——Node 测试宿主下能产出该 toast
    // 即同时证明 Bun 版本取值经 typeof 守卫兜底（无 ReferenceError）
    await clickTestId('setting-check-env')
    await settle()
    const toast = app.useUiState.getState().toast
    expect(toast?.kind).toBe('success')
    expect(toast?.message).toContain('启动器内置运行时就绪（Bun ')
    expect(toast?.message).toContain(' · isomorphic-git）')

    // 还原 portable，避免污染后续用例
    app.useSettings.getState().update({ envMode: 'portable' })
    await settle()
    await resetUiStack()
  })
})

describe('智能滚动（smoke）', () => {
  /** 与 SmartScrollArea 同源的"装得下"判定（theme 数值即契约）。
   *  offscreen 根按宿主机屏幕高布局：开发机高屏 fits=true，CI 虚拟屏（768 级）上
   *  环境页内容会真实超高 → 断言必须按实测 bounds 推导期望值，而非假定装得下。
   *  契约：滚动开启 ⇔ 内容超高（双向都卡：装得下却开滚 = 要修的回归；超高误关 = 更糟） */
  const PAD_Y = layout.padFormY

  function assertScrollContract(scrollId: string): void {
    const vp = renderer.findByTestId(scrollId)
    if (!vp) throw new Error(`${scrollId} not found`)
    const ct = renderer.findByTestId(`${scrollId}-content`)
    if (!ct) throw new Error(`${scrollId}-content not found`)
    const vb = renderer.getElementBounds(vp.id)
    const cb = renderer.getElementBounds(ct.id)
    if (!vb || !cb) throw new Error(`${scrollId} bounds not ready`)
    const fits = cb.height <= vb.height - PAD_Y * 2 + 1
    expect(renderer.getScrollOffset(vp.id) === null, fits ? '装得下时应为非滚动容器' : '超高时应为滚动容器').toBe(fits)
  }

  /** SmartScrollArea 测量经 setTimeout(16ms) 轮询 + 需 flush 出 painted bounds，
   *  断言前多轮 settle 让效应跑完（retry 12×16ms 内必有一次命中已绘制帧） */
  async function settleMeasure(): Promise<void> {
    for (let i = 0; i < 6; i++) await settle(60)
  }

  it('环境 tab：滚动开关与实测"装得下"判定一致；切 tab 重挂后依旧收敛', async () => {
    await resetUiStack()
    await clickTestId('nav-settings')
    await settleMeasure()
    assertScrollContract('settings-tab-scroll')

    // 切走再切回（key 重挂）→ 测量重新收敛，契约依旧成立
    await clickTestId('settings-tab-launcher')
    await settleMeasure()
    await clickTestId('settings-tab-env')
    await settleMeasure()
    assertScrollContract('settings-tab-scroll')
    await resetUiStack()
  })
})

describe('终端字体设置（smoke）', () => {
  it('设置页渲染终端 section：字号/字体下拉 + 自定义输入 + 预览', async () => {
    await resetUiStack()
    await clickTestId('nav-settings')
    // 终端 section 在「启动器设置」页
    await clickTestId('settings-tab-launcher')
    await settle()
    for (const id of [
      'setting-terminal-font-size',
      'setting-terminal-font-family',
      'setting-terminal-font-custom',
      'setting-save-terminal-font',
      'setting-terminal-font-preview',
    ]) {
      expect(renderer.findByTestId(id)).toBeDefined()
    }
    // 预览行即取即用当前设置（默认 12px / Consolas）
    const preview = renderer.findByTestId('setting-terminal-font-preview')
    if (!preview) throw new Error('preview not found')
    expect(Number(preview.style.fontSize ?? 0)).toBe(12)
  })

  it('字号/字体族变更 → 日志行样式与渲染高度联动（闭环）', async () => {
    await clickTestId('nav-terminal')
    app.useTerminalLogs.getState().clear()
    await settle()
    app.useTerminalLogs.getState().appendBatch([{ text: 'font-smoke-line' }])
    await settle()

    // findByText 命中的是原生文本节点（无 style 记录）→ 行为断言走 bounds：
    // 默认 12px 下的渲染高度
    const el12 = renderer.findByText('font-smoke-line')
    if (!el12) throw new Error('log line not rendered')
    const bounds12 = renderer.getElementBounds(el12.id)
    if (!bounds12) throw new Error('log line has no bounds at 12px')

    app.useSettings.getState().update({ terminalFontSize: 18, terminalFontFamily: 'Cascadia Mono' })
    await settle()

    // 18px 下同一行渲染高度同比增大（字号真实进入布局，而非仅改 props）
    const el18 = renderer.findByText('font-smoke-line')
    if (!el18) throw new Error('log line lost after font change')
    const bounds18 = renderer.getElementBounds(el18.id)
    if (!bounds18) throw new Error('log line has no bounds at 18px')
    expect(bounds18.height).toBeGreaterThan(bounds12.height)

    // 样式探针：设置页预览行（<text> 元素本身带 testId，style 可读）
    await clickTestId('nav-settings')
    await clickTestId('settings-tab-launcher')
    await settle()
    const preview = renderer.findByTestId('setting-terminal-font-preview')
    if (!preview) throw new Error('preview not found')
    expect(Number(preview.style.fontSize ?? 0)).toBe(18)
    expect(String(preview.style.fontFamily ?? '')).toBe('Cascadia Mono')

    // 还原默认，避免污染后续用例；update 的 toast 副产物一并清空（单例槽位）
    app.useSettings.getState().update({ terminalFontSize: 12, terminalFontFamily: '' })
    await settle()
    await resetUiStack()
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

  it('关闭入口契约：标题栏关闭按钮 ST 运行中先确认、未运行直关不弹窗', async () => {
    await resetUiStack()

    // 未运行：点关闭不弹确认（closeWindow 经上方 vi.mock 返回"投递成功"，只锁
    // "不弹对话框"这一半；WM_CLOSE 真退出语义由 e2e exit 用例与真窗取证脚本覆盖）
    await clickTestId('titlebar-close')
    expect(app.useUiState.getState().dialogs.length).toBe(0)

    // 运行中：弹退出确认（D1 入口迁移契约——自绘标题栏关闭按钮是唯一可见关闭入口）。
    // running 由进程计数派生且 AppShell 每 2s 轮询 refresh：用例期间把 refresh 置 no-op
    // 消除 2s 边界抖动，finally 还原。
    const realRefresh = app.useStState.getState().refresh
    app.useStState.setState({ refresh: () => undefined, running: true })
    try {
      await settle()
      await clickTestId('titlebar-close')
      const dialogs = app.useUiState.getState().dialogs
      expect(dialogs.length).toBe(1)
      expect(dialogs[0]?.kind).toBe('exitConfirm')

      // 取消 = 安全默认：栈清空。绝不能点 exit-confirm-stop——AppShell 的 onConfirm
      // 是真实 quitLauncher，会 process.exit 掉测试宿主
      await clickTestId('exit-confirm-cancel')
      expect(app.useUiState.getState().dialogs.length).toBe(0)
    } finally {
      app.useStState.setState({ refresh: realRefresh, running: false })
      await settle()
    }
    await resetUiStack()
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

    // 回归：长标签不得画出对话框边界（checkbox 根 = Modal 内容宽），
    // 且宽度受限后应折行（高度 > 单行 lineHeight）
    {
      const root = renderer.findByTestId('age-checkbox')
      const label = renderer.findByText(
        '我已确认本人已年满18周岁，或作为未满18周岁用户已取得监护人同意',
      )
      if (!root) throw new Error('age-checkbox not found')
      if (!label) throw new Error('age-checkbox label not found')
      const rb = renderer.getElementBounds(root.id)
      const lb = renderer.getElementBounds(label.id)
      if (!rb || !lb) throw new Error('age-checkbox bounds missing')
      expect(lb.x + lb.width).toBeLessThanOrEqual(rb.x + rb.width + 1)
      // 容差含 1px 边框取整：标签须为 16px 方框 + 8px 间隙让出宽度
      expect(lb.width).toBeLessThanOrEqual(rb.width - 16)
      expect(lb.height).toBeGreaterThan(24)
    }

    await clickTestId('age-checkbox')
    const confirmAfter = renderer.findByTestId('age-confirm')
    if (!confirmAfter) throw new Error('age-confirm not found after check')
    expect(Number(confirmAfter.style.opacity ?? 1)).toBeGreaterThan(0.9)

    await clickTestId('age-confirm')
    expect(onConfirm).toHaveBeenCalledWith(true)
    expect(app.useUiState.getState().dialogs.length).toBe(0)
  })
})
