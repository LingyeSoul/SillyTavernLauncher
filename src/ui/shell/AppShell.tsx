/**
 * AppShell（设计 §3）：侧栏 168px（DEVIATION: 原设计 192，用户要求改窄；bg-deep + 右 1px border-subtle）+ 主区两种形态
 * （终端自管滚动 / 其余视图自管滚动：2026-09-20 起全部非终端视图统一为"标题区固定、
 * 仅内容区滚动"——DEVIATION: §3.A/§4.2-4.4 原单滚动型 heading 随内容滚动，经
 * O11 回写；版本/同步/扩展/设置四视图共用 PageScaffold（设置页 tab 经 scrollKey
 * 重挂），关于页居中布局整体自管；全应用任何时刻只有一个垂直滚动容器，铁律——自管
 * 视图的外层不得再包 overflow:scroll）。
 * - footer：ST 状态芯片（运行中呼吸微光 = 全应用唯一无限动画实例 M7）+ 主题切换
 *   + 退出启动器入口（DEVIATION: GPUIX 无 onClose 拦截，窗口 X 直接退出为已知行为，
 *     退出保护收敛到主界面的显式入口走 exitConfirm）。
 * - 2s 轮询刷新 ST 运行状态（进程退出无回调，running 派生自进程计数）。
 */
import { useEffect } from 'react'
import type { ComponentType } from 'react'
import { motion } from '@gpuix/react'
import { EASE_OUT_QUAD, dur, layout } from '../../theme'
import { errMsg, logError } from '../../services/errorLog'
import { useMotion, useTheme, useThemeContext, useBreath } from '../theme'
import { NavItem } from './NavItem'
import { Tooltip } from '../components/Tooltip'
import { ToastHost } from '../components/Toast'
import { Chip } from '../components/Chip'
import { IconButton } from '../components/IconButton'
import type { IconName } from '../components/icons'
import { useUiState, VIEW_IDS, type ViewId } from '../../stores/uiState'
import { useStState } from '../../stores/stState'
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
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        position: 'relative',
        backgroundColor: t.bg.base,
        selectionColor: t.selection.ember,
      }}>
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
      {/* Toast 层嵌在外壳内（根层级的 anchored 浮层会把基础树挤成 8px，GPUIX 0.9.0 实测） */}
      <ToastHost />
    </div>
  )
}

function Sidebar() {
  const t = useTheme()
  const { mode, setMode, motionEnabled } = useThemeContext()
  const view = useUiState((s) => s.view)
  const setView = useUiState((s) => s.setView)
  const openDialog = useUiState((s) => s.openDialog)
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

      {/* footer：ST 状态芯片 + 主题切换 + 退出，高 62 */}
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
        <Tooltip label="退出启动器">
          <IconButton
            icon="x"
            size={28}
            label="退出启动器"
            testId="exit-launcher"
            onClick={() => {
              // ← D1 行为定义：ST 未运行直接退出；运行中先确认
              if (!running) {
                void quitLauncher()
              } else {
                openDialog({ kind: 'exitConfirm', onConfirm: () => void quitLauncher() })
              }
            }}
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
