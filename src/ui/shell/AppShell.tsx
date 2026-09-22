/**
 * AppShell（设计 §3；2026-09-22 起含自绘标题栏，O12）：外壳根为**纵向**两段——
 * 36px TitleBar（窗口铬层）+ 本体行（侧栏 168px（DEVIATION: 原设计 192，用户要求改窄；
 * bg-deep + 右 1px border-subtle）+ 主区两种形态
 * （终端自管滚动 / 其余视图自管滚动：2026-09-20 起全部非终端视图统一为"标题区固定、
 * 仅内容区滚动"——DEVIATION: §3.A/§4.2-4.4 原单滚动型 heading 随内容滚动，经
 * O11 回写；版本/同步/扩展/设置四视图共用 PageScaffold（设置页 tab 经 scrollKey
 * 重挂），关于页居中布局整体自管；全应用任何时刻只有一个垂直滚动容器，铁律——自管
 * 视图的外层不得再包 overflow:scroll）。
 * - footer：ST 状态芯片（运行中呼吸微光 = 全应用唯一无限动画实例 M7）+ 主题切换
 *   （§3.B 契约）。2026-09-22：退出启动器按钮移除——自绘标题栏（O12）成为唯一可见
 *   关闭入口，退出保护随之迁到那里，见 requestClose。
 * - 2s 轮询刷新 ST 运行状态（进程退出无回调，running 派生自进程计数）。
 */
import { useEffect } from 'react'
import type { ComponentType } from 'react'
import { motion } from '@gpuix/react'
import { EASE_OUT_QUAD, dur, layout } from '../../theme'
import { errMsg, logError } from '../../services/errorLog'
import { useMotion, useTheme, useThemeContext, useBreath } from '../theme'
import { NavItem } from './NavItem'
import { TitleBar } from './TitleBar'
import { Tooltip } from '../components/Tooltip'
import { ToastHost } from '../components/Toast'
import { Chip } from '../components/Chip'
import { IconButton } from '../components/IconButton'
import type { IconName } from '../components/icons'
import { useUiState, VIEW_IDS, type ViewId } from '../../stores/uiState'
import { useStState } from '../../stores/stState'
import { closeWindow, hideMainWindow } from '../../services/windowControl'
import { isTrayActive } from '../../services/tray'
import { TerminalView } from '../views/TerminalView'
import { VersionView } from '../views/VersionView'
import { SyncView } from '../views/SyncView'
import { ExtensionsView } from '../views/ExtensionsView'
import { SettingsView } from '../views/SettingsView'
import { AboutView } from '../views/AboutView'

const NAV_ITEMS: Array<{ id: ViewId; icon: IconName; label: string }> = [
  { id: 'terminal', icon: 'terminal', label: '终端' },
  { id: 'version', icon: 'gitBranch', label: '版本' },
  { id: 'sync', icon: 'sync', label: '同步' },
  { id: 'extensions', icon: 'puzzle', label: '扩展' },
  { id: 'settings', icon: 'settings', label: '设置' },
  { id: 'about', icon: 'info', label: '关于' },
]

const VIEWS: Record<ViewId, ComponentType> = {
  terminal: TerminalView,
  version: VersionView,
  sync: SyncView,
  extensions: ExtensionsView,
  settings: SettingsView,
  about: AboutView,
}

export function AppShell() {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  const view = useUiState((s) => s.view)
  const setView = useUiState((s) => s.setView)
  const refresh = useStState((s) => s.refresh)

  // 进程退出后复位运行状态（轮询；GPUIX 无进程退出回调）
  useEffect(() => {
    const id = setInterval(() => refresh(), 2000)
    return () => clearInterval(id)
  }, [refresh])

  const CurrentView = VIEWS[view]

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        flexGrow: 1,
        minHeight: 0,
        position: 'relative',
        backgroundColor: t.bg.base,
        selectionColor: t.selection.ember,
      }}>
      {/* 自绘标题栏（窗口铬层，36px）：不占内容区 644 预算，见 theme.ts layout.titlebarH */}
      <TitleBar onCloseRequest={requestClose} />
      <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minHeight: 0 }}>
        <Sidebar />
        {/* 右 1px border-subtle 分隔线（StyleDesc 无分边框色，用 1px div） */}
        <div style={{ width: 1, height: '100%', backgroundColor: t.border.subtle, flexShrink: 0 }} />
        <div
          style={{
            flexGrow: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
          }}>
          {view === 'terminal' ? (
            <TerminalView />
          ) : (
            // 非终端视图统一自管滚动（固定头 + 内容区 SmartScrollArea，实测超高才
            // 开滚动；外层不包滚动容器，嵌套滚动禁止），M1 入场动画保留
            <motion.div
              key={view}
              initial={motionEnabled ? { opacity: 0, top: 6 } : false}
              animate={{ opacity: 1, top: 0 }}
              transition={{ duration: motionEnabled ? dur.enter : 0, ease: EASE_OUT_QUAD }}
              style={{ position: 'relative', flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <CurrentView />
            </motion.div>
          )}
        </div>
      </div>
      {/* Toast 层嵌在外壳内（根层级的 anchored 浮层会把基础树挤成 8px，GPUIX 0.9.0 实测）；
          挂外壳根 = 撑满窗口的锚定父盒，右上角落点与自绘标题栏之前一致 */}
      <ToastHost />
    </div>
  )
}

function Sidebar() {
  const t = useTheme()
  const { mode, setMode, motionEnabled } = useThemeContext()
  const view = useUiState((s) => s.view)
  const setView = useUiState((s) => s.setView)
  const running = useStState((s) => s.running)
  const installed = useStState((s) => s.installed)

  const status: 'running' | 'stopped' | 'not-installed' = running
    ? 'running'
    : installed
      ? 'stopped'
      : 'not-installed'
  const statusLabel = { running: '运行中', stopped: '已停止', 'not-installed': '未安装' }[status]

  return (
    <div
      style={{
        width: layout.sidebarW,
        height: '100%',
        backgroundColor: t.bg.deep,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
      {/* DEVIATION: 移除 dt §1.A workspace-brand 品牌区（logo + 软件名，高 80）——用户要求
          侧栏左上角不放品牌标识；导航顶部以 14px 内边距代替原品牌区留白 */}
      {/* 导航（6 项单组，无分组标签） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          paddingTop: 14,
          paddingLeft: 6,
          paddingRight: 6,
        }}>
        {NAV_ITEMS.map((item) => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={view === item.id}
            onClick={() => setView(item.id)}
            testId={`nav-${item.id}`}
          />
        ))}
      </div>

      {/* 弹性空隙 */}
      <div style={{ flexGrow: 1 }} />

      {/* footer 顶边 1px 分隔线（无分边框色，用 1px div） */}
      <div
        style={{
          marginLeft: 8,
          marginRight: 8,
          height: 1,
          backgroundColor: t.border.subtle,
        }}
      />

      {/* footer：ST 状态芯片 + 主题切换，高 62（§3.B 契约；退出入口在自绘标题栏） */}
      <div
        style={{
          height: 62,
          paddingLeft: 12,
          paddingRight: 8,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}>
        <StStatusDot status={status} />
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <text style={{ fontSize: t.fs.caption, color: t.text.secondary, fontFamily: t.font.sans }}>
            SillyTavern
          </text>
          <Chip color={t.text.muted} testId="st-status-chip">
            {statusLabel}
          </Chip>
        </div>
        <Tooltip label={mode === 'dark' ? '切换浅色主题' : '切换深色主题'}>
          <IconButton
            icon={mode === 'dark' ? 'sun' : 'moon'}
            iconSize={16}
            size={28}
            label="切换主题"
            onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
            testId="theme-toggle"
          />
        </Tooltip>
      </div>
    </div>
  )
}

/** ST 状态点：运行中 = ember + 呼吸（M7，全应用唯一实例）；motion 关或非运行 → 静态 */
function StStatusDot({ status }: { status: 'running' | 'stopped' | 'not-installed' }) {
  const t = useTheme()
  const { motionEnabled } = useThemeContext()
  const breathPhase = useBreath(dur.breathPeriodMs, status === 'running' && motionEnabled)
  if (status !== 'running') {
    return (
      <div
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: t.text.disabled,
          pointerEvents: 'none',
        }}
      />
    )
  }
  return (
    <motion.div
      initial={false}
      animate={{ opacity: breathPhase ? 0.5 : 1 }}
      transition={{ duration: 1, ease: 'easeInOut' }}
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: t.ember,
        pointerEvents: 'none',
      }}
    />
  )
}

/**
 * 关窗请求（D1/§4.7 原始语义："关窗时 ST 运行中则确认"）：ST 运行中先经 exitConfirm
 * 确认再"停止并退出"；未运行直接走原生 WM_CLOSE 链路（O12：与系统 X 同链路）。
 *
 * 2026-09-22：原生标题栏隐藏 + 侧栏"退出启动器"入口移除后，自绘标题栏关闭按钮成为
 * 全应用唯一可见的关闭入口——此前设计因"无法拦截窗口 X"把保护退守在侧栏，自绘铬层
 * 把 D1 语义还了回来。running 用 getState 现读而非订阅值：避免闭包捕获陈旧状态。
 *
 * 托盘启用时（2026-09-22 托盘恢复）：关闭按钮 = 隐藏到托盘——ST 继续运行、托盘
 * 可唤回，无需退出确认（确认对话框的存在前提是"关闭会杀 ST"）。隐藏失败（非
 * win32/Bun、句柄未定位的启动初期）回落原路径，不留"点了没反应"的死入口。
 * Alt+F4 走原生 WM_CLOSE 仍是直接退出——该链路拦不住（见 app.tsx DEVIATION）。
 */
function requestClose(): void {
  if (isTrayActive() && hideMainWindow()) return
  if (useStState.getState().running) {
    useUiState.getState().openDialog({ kind: 'exitConfirm', onConfirm: () => void quitLauncher() })
  } else if (!closeWindow()) {
    // 投递失败（非 win32/Bun、窗口句柄未定位的启动初期）：退化为直接退出——
    // 关闭按钮是唯一可见退出入口，不能留下"点了没反应"的死入口
    void quitLauncher()
  }
}

/** 退出：ST 运行中已在 exitConfirm 确认，这里停止全部进程后退出进程 */
export async function quitLauncher(): Promise<void> {
  const { stopAllProcesses } = await import('../../services/processManager')
  try {
    await stopAllProcesses()
  } catch (err) {
    logError(`[app] 退出前停止进程失败: ${errMsg(err)}`)
  } finally {
    process.exit(0)
  }
}
