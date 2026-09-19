/**
 * 终端视图（设计 §4.1，核心）：
 * - 主区 padding 12，flex column，不滚动（自管滚动形态）。
 * - 日志卡：virtual-list alignment=bottom followTail，ANSI 彩色行渲染（相邻 <text> 合并一行）。
 * - 底部 5 按钮接 stLifecycle（安装/启动/停止/更新/清空，各带 tooltip 350ms）。
 * - 中文文案集中于顶部常量对象（i18n 缝）。
 */
import { memo, useMemo } from 'react'
import { motion } from '@gpuix/react'
import { EASE_OUT_QUAD, dur, layout } from '../../theme'
import { useMotion, useTheme } from '../theme'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { Tooltip } from '../components/Tooltip'
import type { IconName } from '../components/icons'
import {
  classifyLogLevel,
  useTerminalLogs,
  type EngineSeg,
  type TerminalLine,
} from '../../stores/terminalLogs'
import { useStState } from '../../stores/stState'
import { useUiState } from '../../stores/uiState'
import { getConfigStore } from '../../services/configStore'

const TEXTS = {
  emptyNoLog: '等待日志输出',
  emptyNoLogHint: '安装或启动 SillyTavern 后，输出将显示在这里',
  emptyNotInstalled: '尚未安装 SillyTavern',
  emptyNotInstalledHint: '点击下方"安装"按钮开始安装',
  install: '安装',
  installTip: '从仓库拉取最新版本并安装依赖',
  start: '启动',
  startTip: '启动SillyTavern',
  stop: '停止',
  stopTip: '停止SillyTavern',
  update: '更新',
  updateTip: '更新到最新版本并更新依赖',
  clear: '清空',
  clearTip: '清空终端日志',
  cancelInstall: '用户取消安装',
  cancelStart: '用户取消启动',
} as const

/** 单行渲染：引擎预解析段 = 相邻 <text>（合并一行特性）；无色行按日志级别兜底着色 */
const LogRow = memo(function LogRow({ line }: { line: TerminalLine }) {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  const segs = useMemo<EngineSeg[]>(() => {
    // 引擎已产出带样式的段 → 直接渲染；纯文本行 → 行级语义着色兜底（dt §1.E，
    // 与旧版"无 ANSI 色才走级别着色"的行为一致）
    if (line.segs.some((s) => s.color !== undefined || s.weight !== undefined)) return line.segs
    if (line.segs.length === 0) return [{ text: line.text }]
    const level = classifyLogLevel(line.text)
    if (level === 'default') return line.segs
    const color =
      level === 'error' ? t.status.error
      : level === 'warning' ? t.status.warning
      : t.status.info
    return [{ text: line.text, color, weight: level === 'error' ? 500 : undefined }]
  }, [line.text, line.segs, t])

  const body = segs.map((s, i) => (
    <text
      key={i}
      style={{
        fontSize: 12,
        fontFamily: t.font.mono,
        color: s.color ?? t.text.secondary,
        fontWeight: s.weight,
        textDecoration: s.underline ? 'underline' : undefined,
      }}>
      {s.text}
    </text>
  ))

  if (!line.animate || !motionEnabled) {
    return <div style={{ padding: 1, minHeight: 18 }}>{body}</div>
  }
  // M2 新日志行入场：200ms easeOut，top 4→0（translateY 等效）
  return (
    <motion.div
      initial={{ opacity: 0, top: 4 }}
      animate={{ opacity: 1, top: 0 }}
      transition={{ duration: dur.logEnter, ease: EASE_OUT_QUAD }}
      style={{ position: 'relative', padding: 1, minHeight: 18 }}>
      {body}
    </motion.div>
  )
})

export function TerminalView() {
  const t = useTheme()
  const lines = useTerminalLogs((s) => s.lines)
  const clear = useTerminalLogs((s) => s.clear)
  const running = useStState((s) => s.running)
  const installed = useStState((s) => s.installed)
  const busy = useStState((s) => s.busy)
  const installSt = useStState((s) => s.installSt)
  const startSt = useStState((s) => s.startSt)
  const stopSt = useStState((s) => s.stopSt)
  const updateSt = useStState((s) => s.updateSt)
  const openDialog = useUiState((s) => s.openDialog)

  const hasLogs = lines.length > 0

  /** ← Flet install_sillytavern：ST 未安装时先过年龄确认对话框 */
  const handleInstall = (): void => {
    if (!installed) {
      openDialog({
        kind: 'ageConfirm',
        mode: 'install',
        onConfirm: (ok) => {
          if (!ok) {
            useTerminalLogs.getState().appendLine(TEXTS.cancelInstall)
            return
          }
          void installSt()
        },
      })
      return
    }
    void installSt()
  }

  /** ← Flet start_sillytavern：首次启动（has_started_st=false）先过年龄确认 */
  const handleStart = (): void => {
    if (!getConfigStore().get<boolean>('has_started_st', false)) {
      openDialog({
        kind: 'ageConfirm',
        mode: 'start',
        onConfirm: (ok) => {
          if (!ok) {
            useTerminalLogs.getState().appendLine(TEXTS.cancelStart)
            return
          }
          getConfigStore().set('has_started_st', true)
          try {
            getConfigStore().save()
          } catch (err) {
            console.error(`[terminal] 保存首次启动状态失败: ${err instanceof Error ? err.message : String(err)}`)
          }
          void startSt()
        },
      })
      return
    }
    void startSt()
  }

  const buttons: Array<{
    key: string
    label: string
    tip: string
    icon: IconName
    disabled: boolean
    onClick: () => void
    variant: 'primary' | 'default' | 'quiet' | 'quietDanger'
    dangerText?: boolean
  }> = [
    {
      key: 'install', label: TEXTS.install, tip: TEXTS.installTip, icon: 'download',
      disabled: running || busy.install, onClick: handleInstall, variant: 'default',
    },
    {
      key: 'start', label: TEXTS.start, tip: TEXTS.startTip, icon: 'play',
      disabled: running || busy.start, onClick: handleStart, variant: 'primary',
    },
    {
      key: 'stop', label: TEXTS.stop, tip: TEXTS.stopTip, icon: 'stop',
      disabled: !running || busy.stop, onClick: () => void stopSt(), variant: 'default',
      dangerText: true,
    },
    {
      key: 'update', label: TEXTS.update, tip: TEXTS.updateTip, icon: 'refresh',
      disabled: running || busy.update, onClick: () => void updateSt(), variant: 'default',
    },
    {
      key: 'clear', label: TEXTS.clear, tip: TEXTS.clearTip, icon: 'trash',
      disabled: !hasLogs, onClick: clear, variant: 'quiet',
    },
  ]

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        padding: layout.padTerminal,
        gap: layout.padTerminal,
      }}>
      {/* 日志卡：bg-deep 外框 + 1px subtle + radius 6 */}
      <div
        style={{
          flexGrow: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: t.bg.deep,
          borderWidth: 1,
          borderColor: t.border.subtle,
          borderRadius: t.radius.md,
          overflow: 'hidden',
        }}>
        {hasLogs ? (
          <virtual-list
            alignment="bottom"
            followTail
            estimatedItemHeight={18}
            style={{ flexGrow: 1, minHeight: 0, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
            {lines.map((line) => (
              <LogRow key={line.id} line={line} />
            ))}
          </virtual-list>
        ) : (
          <EmptyState
            icon="terminal"
            title={installed ? TEXTS.emptyNoLog : TEXTS.emptyNotInstalled}
            hint={installed ? TEXTS.emptyNoLogHint : TEXTS.emptyNotInstalledHint}
          />
        )}
      </div>

      {/* 按钮行：高 50，按钮 34 垂直居中，5 按钮等宽 96 gap 8 水平居中 */}
      <div
        style={{
          height: 50,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}>
        {buttons.map((b) => (
          <Tooltip key={b.key} label={b.tip}>
            <Button
              variant={b.variant}
              icon={b.icon}
              disabled={b.disabled}
              onClick={b.onClick}
              width={96}
              danger={b.dangerText}
              testId={`terminal-${b.key}`}>
              {b.label}
            </Button>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
