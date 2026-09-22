/**
 * SillyTavernLauncher GPUIX 版入口（Phase 2 UI 组装）。
 *
 * - render() 结尾（幂等，--hot 安全；禁止 createRenderer()/init()）。
 * - 800×(644+36) 固定窗 + 自绘标题栏（D4 + O12；resizable: false 已验证存在于
 *   renderer.rs）。原生标题栏经 titlebarTransparent 隐藏，铬层由 ui/shell/TitleBar
 *   自绘：拖动（services/windowControl 的 SetWindowPos）、最小化、关闭、品牌区。
 *   内容区仍为 644——标题栏高度不计入 layout.windowH，各视图纵向预算不变。
 * - 启动流程（← main.py check_first_launch）：first_run → 欢迎问答；
 *   未同意协议/协议版本变化 → EULA；checkupdate → 后台检查启动器更新；
 *   autostart → 自动启动酒馆（D1 新语义：主窗口正常显示）。
 *
 * DEVIATION: GPUIX 0.9.0 无窗口关闭拦截（onClose），窗口 X = 进程直接退出，
 *   无法挂退出确认。退出保护收敛到侧栏 footer 的"退出启动器"显式入口
 *   （exitConfirm 确认后 stopAllProcesses + process.exit）；窗口 X 直接退出
 *   视为已知行为（迁移计划 D1 行为定义第 1 条：关窗 = 停止所有子进程并退出——
 *   原生退出路径上 processManager 的 exit 钩子仍会同步硬杀子进程）。
 *
 * WINDOWS 陷阱：`bun run`/`npm run` 以 windowsHide 语义 spawn 脚本子进程
 *   （STARTF_USESHOWWINDOW + wShowWindow=SW_HIDE），gpuix 0.9.0 的窗口初始
 *   显示状态继承进程启动信息（gpui_windows 的 GetWindowPlacement showCmd），
 *   窗口创建成功但永不显示；show/focus 选项与 activateWindow() 都绕不开
 *   （activate 全链路无 ShowWindow）。因此 dev 脚本用 `cmd /c` 中转一层，
 *   让真正跑 app 的 bun 进程拿到干净启动信息（见 package.json scripts.dev）。
 *   macOS/Linux 的 spawn 不携带该启动信息，无此问题。
 */
import { useEffect } from 'react'
import { render } from '@gpuix/react'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigStore } from './services/configStore'
import type { ConfigStore } from './services/configStore'
import { createMirrorPingProbe, ensureMirrorSelection } from './services/mirrors'
import { installCrashGuard } from './services/crashGuard'
import { logError } from './services/errorLog'
import { stopAllProcessesSync } from './services/processManager'
import { fetchAgreementDocument } from './services/agreement'
import { checkForUpdates, fetchChangelog, normalizeVersion } from './services/updater'
import { applyWindowIcon } from './services/windowIcon'
import { initWindowControl } from './services/windowControl'
import { APP_VERSION } from './version'
import { layout } from './theme'
import { ThemeProvider } from './ui/theme'
import { AppShell } from './ui/shell/AppShell'
import { DialogHost } from './ui/dialogs/DialogHost'
import { TooltipProvider } from './ui/components/Tooltip'
import { LOGO_DATA_URL } from './ui/assets/logo'
import { useStState } from './stores/stState'
import { uiStateActions } from './stores/uiState'
import { useSettings } from './stores/settings'
import { useTerminalLogs } from './stores/terminalLogs'

const RELEASES_URL = 'https://github.com/LingyeSoul/SillyTavernLauncher/releases/latest'

// gpuix 0.9.0 内嵌的 zed gpui（env_logger）在 Windows 关窗拆除路径必然打 4 条 ERROR
// （gpui::window "window not found" + gpui_windows::window/dispatcher "无效的窗口句柄"），
// 退出码 0、进程正常退出，纯拆除期噪音——已用"最小静态树 + FFI 投递 WM_CLOSE"复现
// 证实与应用代码无关（vendored Rust 二进制内部行为，0.9.0 已是最新版无升级修复）。
// env_logger 在 renderer 初始化（render 调用）时读 RUST_LOG，静态 import 后、render
// 前赋值即可生效（实测）；只静默这三个肇事 target，其余模块 error 级保持可见。
// ??= 尊重外部显式设置：调试 gpuix 时可自行注入 RUST_LOG 覆盖本默认值。
process.env.RUST_LOG ??=
  'error,gpui_windows::window=off,gpui_windows::dispatcher=off,gpui::window=off'

// 进程级异常落盘（RCA：关窗偶发报错未捕获）：gpui 拆除窗口后 Bun 事件循环
// 短暂存活，拆除窗口期落地的 React commit 调 GPU API 会抛
// "The GPUI UI thread is not running"（@gpuix 的 uncaughtException handler
// 只打 stderr 不落盘，退出码 0，纯竞态噪音；采样复现率 ~1/8）。
// crashGuard 只增不替：补 logs/Error_*.txt 落盘通道，退出语义不变。
installCrashGuard()

/**
 * 启动期镜像源自愈（2026-09-21 镜像增强）：
 * 自动模式下若尚未选定镜像站、或选定结果已过期（>12h），用 ping 测速选出最快镜像；
 * 已有新鲜选定 → 直接返回（零网络开销，不打扰用户）。
 * 返回 Promise 供 autostart 先行等待——首次安装的 clone 必须跑在选定的镜像上。
 */
function ensureMirrorAtStartup(config: ConfigStore): Promise<void> {
  const enabled = config.get<boolean>('github.enabled', false)
  const auto = config.get<boolean>('github.auto', true)
  if (!enabled || !auto) return Promise.resolve()
  if (process.env.STL_SKIP_MIRROR_AUTOSELECT === '1') return Promise.resolve()
  return (async () => {
    try {
      const outcome = await ensureMirrorSelection({ probe: createMirrorPingProbe() })
      if (outcome === null) return
      useTerminalLogs.getState().appendLine(`[镜像] ${outcome.message}`)
      if (outcome.exhausted) {
        uiStateActions.pushToast('warning', outcome.message)
        return
      }
      if (outcome.changed) uiStateActions.pushToast('info', outcome.message)
      // 选中结果必须落到 gitconfig insteadOf：portable/system 的 git 加速靠它生效
      // （embedded 走操作时内存前缀）。选优只写 config.json 而不落 gitconfig 会出现
      // "测速选好了但 clone 仍走官方源"；这里无条件同步一次（覆盖手改配置/升级场景）
      await useSettings.getState().syncMirrorToGit(outcome.host, true)
    } catch (err) {
      logError(`[startup] 镜像源自动选优失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

/** ← main.py check_first_launch 的启动对话框序列 */
function StartupFlow() {
  useEffect(() => {
    const config = getConfigStore()

    // 0. 镜像源自愈（先于一切网络操作；autostart 时被 await，见步骤 4）
    const mirrorReady = ensureMirrorAtStartup(config)

    // 1. 首次运行 → 欢迎问答
    if (config.get<boolean>('first_run', true)) {
      uiStateActions.openDialog({ kind: 'welcome' })
    }

    // 2. 未同意协议 或 协议版本变化 → EULA（缓存日期 vs 已同意版本）
    const accepted = config.get<boolean>('agreement_accepted', false)
    const acceptedVersion = config.get<string>('agreement_version', '')
    let cachedDate = ''
    try {
      const cachePath = join(process.cwd(), 'agreement_cache.json')
      if (existsSync(cachePath)) {
        const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as { date?: unknown }
        if (typeof cache.date === 'string') cachedDate = cache.date
      }
    } catch {
      // 缓存损坏按无缓存处理
    }
    if (!accepted || acceptedVersion !== cachedDate) {
      uiStateActions.openDialog({ kind: 'eula' })
    } else if (process.env.STL_SKIP_AGREEMENT_RECHECK !== '1') {
      // 缓存门通过也要后台核对远端协议版本（Bug#4：原实现只在弹窗时刷新缓存，
      // 远端更新后已同意用户永不再弹；语义对齐 main.py check_first_launch 步骤2）
      // STL_SKIP_AGREEMENT_RECHECK=1 供 E2E 种子环境禁用（种子日期 2099-01-01 与远端不符）
      void (async () => {
        try {
          const remote = await fetchAgreementDocument()
          if (remote && remote.date !== acceptedVersion) {
            uiStateActions.openDialog({ kind: 'eula' })
          }
        } catch (err) {
          // 已同意用户的核对失败仅记日志（main.py 同样只在无缓存时才弹网络错误）
          logError(`[startup] 后台核对协议版本失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    }

    // 3. 自动检查启动器更新（← version_checker.run_check）
    if (config.get<boolean>('checkupdate', true)) {
      void (async () => {
        try {
          const current = normalizeVersion(APP_VERSION)
          const result = await checkForUpdates({ currentVersion: current })
          if (result.has_error || !result.has_update || result.latest_version === null) return
          const changelog = await fetchChangelog({ currentVersion: current })
          uiStateActions.openDialog({
            kind: 'updateAvailable',
            currentVersion: current,
            latestVersion: result.latest_version,
            changelog,
            downloadUrl: RELEASES_URL,
          })
        } catch (err) {
          logError(`[startup] 检查更新失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    }

    // 4. 自动启动酒馆（D1 新语义：主窗口正常显示）
    //    先等镜像选优落定：首次安装的 clone 要跑在选定镜像上（无选定则瞬间返回）
    if (config.get<boolean>('autostart', false)) {
      void mirrorReady.then(() => useStState.getState().startSt())
    }
  }, [])
  return null
}

function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        {/* 单一根节点：多个根级兄弟中出现 <anchored>（FloatingLayer）时，
            GPUI 原生树会只保留浮层子树——外壳必须包在一个根 div 内。
            position relative 与 Tooltip/Select 的浮层父容器模式保持一致。 */}
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}>
          <StartupFlow />
          <AppShell />
          <DialogHost />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  )
}

// 原生退出路径的兜底：窗口 X 直接退出时同步硬杀子进程（← terminal.py 退出钩子语义）
process.on('exit', () => {
  try {
    stopAllProcessesSync()
  } catch {
    // 解释器关闭阶段尽力而为
  }
})

const WINDOW_OPTIONS = {
  title: 'SillyTavernLauncher',
  width: 800,
  // 高度 = 内容区 644 + 自绘标题栏 36（theme.layout）：自绘标题栏不占内容预算，
  // 各视图纵向布局值与 E2E 的 644 视口断言（settings 智能滚动回归）全部维持原契约
  // E2E 可加高窗口（STL_E2E_WINDOW_HEIGHT）：设置页为长表单，后台自动化模式下
  // 视口外元素不可点（wheel 亦无效），加高一次性渲染完整表单以驱动开关/端口交互
  height: Number(process.env.STL_E2E_WINDOW_HEIGHT ?? layout.windowH + layout.titlebarH),
  resizable: false,
  // 隐藏原生标题栏，铬层由 React 侧 TitleBar 自绘（拖动/最小化/关闭；Windows 侧
  // 0.9.0 无 window move API，拖动经 services/windowControl 的 SetWindowPos 自力更生）
  titlebarTransparent: true,
  // agent 驱动（GPUIX_BACKGROUND=1）时后台开窗，不抢焦点。
  // E2E 走 @gpuix/react/automation 的官方 launch()：stdio 协议在管道时自动监听，
  // 应用侧无需任何 automation 分支（曾有的 createRenderer+enableAutomation 路径
  // 会破坏对话框卸载后的树状态，已移除）。
  focus: process.env.GPUIX_BACKGROUND !== '1',
}

render(<App />, WINDOW_OPTIONS)

// 原生任务栏/Alt-Tab 图标（WM_SETICON）：render() 同步建窗后即可查找。
// 仅 win32+Bun 生效，其余平台静默空操作；dataURL 解析与投递失败均在
// applyWindowIcon 内部 catch（logError），不影响主流程。
// 注：标题栏图标已随原生标题栏退出视野（titlebarTransparent），本调用只剩
// 任务栏/Alt-Tab 两处收益，投递链路与三槽位顺序保持不变。
void applyWindowIcon(LOGO_DATA_URL, WINDOW_OPTIONS.title)

// 自绘标题栏的窗口控制：启动期定位本进程窗口句柄（标题 + PID 双匹配），
// TitleBar 的拖动/最小化/关闭全部经它投递（见 services/windowControl）。
void initWindowControl(WINDOW_OPTIONS.title)
