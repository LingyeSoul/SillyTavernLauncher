/**
 * 终端视图（设计 §4.1，核心）：
 * - 主区 padding 12，flex column，不滚动（自管滚动形态）。
 * - 日志卡：virtual-list alignment=top followTail，ANSI 彩色行渲染
 *   （段 = 相邻 <text>，需在 display:flex + row 容器内才合并一行，见 LogRow）。
 *   DEVIATION: 设计 §4.1 与 gpuix-migration-design 指定 alignment=bottom（不足
 *   一屏日志贴底）；2026-09-20 改为 top：不足一屏时从顶部向下填充，满屏后
 *   followTail 跟尾语义不变。
 * - 窗口化渲染（2026-09-21 性能修复）：virtual-list 的 itemCount/windowStart
 *   协议下只挂载 [windowStart, windowStart+WINDOW_ROWS) 的行切片——全量挂载
 *   实测每行 3 个原生元素常驻（RSS ~34KB/行，20k 行 842MB），且每行追加成本
 *   随 N 线性增长（涓流 52ms/行@20k）。窗口随滚动（onVisibleRange）与尾部
 *   跟随（新行入库前滑）由本视图推动——gpuix 文档明确 itemCount 增长不会
 *   自动扩窗，不推窗新行永远不挂载。
 * - 底部 5 按钮接 stLifecycle（安装/启动/停止/更新/清空，各带 tooltip 350ms）。
 * - 中文文案集中于顶部常量对象（i18n 缝）。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { motion, useWindowSize } from '@gpuix/react'
import type { EventPayload } from '@gpuix/native'
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
import { computeCols } from '../../services/terminalEngine'
import { useStState, isDirBusy } from '../../stores/stState'
import { terminalRowHeight, useSettings } from '../../stores/settings'
import { useUiState } from '../../stores/uiState'
import { getConfigStore } from '../../services/configStore'
import { errMsg, logError } from '../../services/errorLog'

/** 渲染窗口行数：可视区约 25 行（550px/22px），120 行 ≈ 5 屏余量 */
const WINDOW_ROWS = 120
/** 窗口前缘 overscan：滚动时可见区间先落在窗口内再触发推窗，避免白屏 */
const WINDOW_OVERSCAN = 40

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

/**
 * 日志区单行的可用文本宽（像素）：窗宽 − 侧栏 − 分隔线 − 主区/卡片/列表 padding 与边框。
 * 与 AppShell（sidebarW + 1px 分隔线）、本视图（padTerminal×2、卡片 borderWidth×2）、
 * virtual-list（paddingLeft/Right 8×2）的布局常量同源；估算误差由 computeCols 的
 * 安全余量与 LogRow 的 overflow hidden 双重兜底。
 */
const DIVIDER_PX = 1
const CARD_BORDER_PX = 2
const LIST_PADDING_X_PX = 16

function terminalTextWidthPx(windowWidth: number): number {
  return windowWidth - layout.sidebarW - DIVIDER_PX - 2 * layout.padTerminal - CARD_BORDER_PX - LIST_PADDING_X_PX
}

/** 单行渲染：引擎预解析段 = 相邻 <text>；无色行按日志级别兜底着色。
 *  animate 由视图按"动画截止线"推导（窗口滑出再滑回的行不重复播入场动画） */
const LogRow = memo(function LogRow({ line, animate }: { line: TerminalLine; animate: boolean }) {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  // 终端字体设置（字号/字体族，设置页即时生效）；空字体族回退主题 mono
  const fontSize = useSettings((s) => s.terminalFontSize)
  const fontFamilySetting = useSettings((s) => s.terminalFontFamily)
  const fontFamily = fontFamilySetting || t.font.mono
  // 行高（settings.terminalRowHeight 唯一来源，virtual-list 估算高度同源）
  const rowHeight = terminalRowHeight(fontSize)
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
        fontSize,
        fontFamily,
        color: s.color ?? t.text.secondary,
        fontWeight: s.weight,
        textDecoration: s.underline ? 'underline' : undefined,
      }}>
      {s.text}
    </text>
  ))

  // 段必须落在 display:flex + flexDirection:'row' 容器内才会合并一行
  // （纯 div 中相邻 <text> 纵向堆叠，实测结论）；overflow hidden 吸收折行列数
  // 校准误差（估算 advance 偏窄时末列亦不撑开 virtual-list 内容宽）
  const rowStyle = {
    display: 'flex',
    flexDirection: 'row',
    padding: 1,
    minHeight: rowHeight,
    overflow: 'hidden',
  } as const

  if (!animate || !motionEnabled) {
    return <div style={rowStyle}>{body}</div>
  }
  // M2 新日志行入场：200ms easeOut，top 4→0（translateY 等效）
  return (
    <motion.div
      initial={{ opacity: 0, top: 4 }}
      animate={{ opacity: 1, top: 0 }}
      transition={{ duration: dur.logEnter, ease: EASE_OUT_QUAD }}
      style={{ ...rowStyle, position: 'relative' }}>
      {body}
    </motion.div>
  )
})

export function TerminalView() {
  const t = useTheme()
  // 窗口化数据契约（store 文件头 DEVIATION）：lines 为原地演进的稳定引用，
  // 响应式只订阅 version；行数/窗口切片均经 getState() 在渲染期直读
  const version = useTerminalLogs((s) => s.version)
  const clear = useTerminalLogs((s) => s.clear)
  const lineCount = useTerminalLogs.getState().lines.length
  /** 渲染窗口起始逻辑行（itemCount/windowStart 协议的应用侧推窗状态） */
  const [windowStart, setWindowStart] = useState(() => Math.max(0, lineCount - WINDOW_ROWS))
  /** 用户是否处于尾部（可见区间覆盖末行）；尾部时新行入库窗口前滑 */
  const atTailRef = useRef(true)
  /** 入场动画截止线：id 大于它的行才播动画（历史行/滑回行不播）。
   *  useRef 初值即挂载时存量最大 id：打开视图时历史行不播入场动画 */
  const lastSeenIdRef = useRef<number>(useTerminalLogs.getState().getLastId())
  const animateCutoff = lastSeenIdRef.current
  useEffect(() => {
    lastSeenIdRef.current = useTerminalLogs.getState().getLastId()
  })
  // 尾部跟随：新行入库且处于尾部时窗口前滑（gpuix 文档明确 itemCount
  // 增长不会自动扩窗，不推窗新行永远不挂载）
  useEffect(() => {
    if (!atTailRef.current) return
    setWindowStart(Math.max(0, useTerminalLogs.getState().lines.length - WINDOW_ROWS))
  }, [version])

  const handleVisibleRange = (e: EventPayload): void => {
    const len = useTerminalLogs.getState().lines.length
    if ((e.endIndex ?? len) >= len) {
      atTailRef.current = true
      setWindowStart(Math.max(0, len - WINDOW_ROWS))
    } else {
      atTailRef.current = false
      setWindowStart(Math.max(0, Math.min((e.startIndex ?? 0) - WINDOW_OVERSCAN, len - WINDOW_ROWS)))
    }
  }

  /** 清空同时复位窗口与尾部状态：防止缓冲清空后窗口停留在越界位置 */
  const handleClear = (): void => {
    atTailRef.current = true
    setWindowStart(0)
    clear()
  }
  // 字号联动 virtual-list 估算高度（与 LogRow 行高同源：terminalRowHeight）
  const fontSize = useSettings((s) => s.terminalFontSize)
  const fontFamilySetting = useSettings((s) => s.terminalFontFamily)
  const fontFamily = fontFamilySetting || t.font.mono
  const estimatedRowHeight = terminalRowHeight(fontSize)
  // 视口折行校准：窗宽/字号/字体任一变 → 重算列数写入引擎（窗口当前固定 800，
  // 校准主要为字号与自定义字体服务；引擎初始 1000 列仅为挂载前占位）
  const { width: windowWidth } = useWindowSize()
  useEffect(() => {
    useTerminalLogs.getState().setCols(computeCols(terminalTextWidthPx(windowWidth), fontSize, fontFamily))
  }, [windowWidth, fontSize, fontFamily])
  const running = useStState((s) => s.running)
  const installed = useStState((s) => s.installed)
  // 按钮禁用走 isDirBusy 单一口径（与 store 守卫同源，勿散写三连 ||）；
  // stop 只需自家 busy
  const dirBusy = useStState((s) => isDirBusy(s.busy))
  const stopBusy = useStState((s) => s.busy.stop)
  const installSt = useStState((s) => s.installSt)
  const startSt = useStState((s) => s.startSt)
  const stopSt = useStState((s) => s.stopSt)
  const updateSt = useStState((s) => s.updateSt)
  const openDialog = useUiState((s) => s.openDialog)

  const hasLogs = lineCount > 0
  const windowLines = useTerminalLogs.getState().getRange(windowStart, windowStart + WINDOW_ROWS)

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
            logError(`[terminal] 保存首次启动状态失败: ${errMsg(err)}`)
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
      // 跨操作互斥（2026-09-21 真机竞态）：安装/启动/更新共享 ST 目录，互斥禁用
      disabled: running || dirBusy, onClick: handleInstall, variant: 'default',
    },
    {
      key: 'start', label: TEXTS.start, tip: TEXTS.startTip, icon: 'play',
      disabled: running || dirBusy, onClick: handleStart, variant: 'primary',
    },
    {
      key: 'stop', label: TEXTS.stop, tip: TEXTS.stopTip, icon: 'stop',
      disabled: !running || stopBusy, onClick: () => void stopSt(), variant: 'default',
      dangerText: true,
    },
    {
      key: 'update', label: TEXTS.update, tip: TEXTS.updateTip, icon: 'refresh',
      disabled: running || dirBusy, onClick: () => void updateSt(), variant: 'default',
    },
    {
      key: 'clear', label: TEXTS.clear, tip: TEXTS.clearTip, icon: 'trash',
      disabled: !hasLogs, onClick: handleClear, variant: 'quiet',
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
        testId="terminal-log-card"
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
            alignment="top"
            followTail
            itemCount={lineCount}
            windowStart={windowStart}
            estimatedItemHeight={estimatedRowHeight}
            onVisibleRange={handleVisibleRange}
            style={{ flexGrow: 1, minHeight: 0, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
            {windowLines.map((line) => (
              <LogRow key={line.id} line={line} animate={line.animate && line.id > animateCutoff} />
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
