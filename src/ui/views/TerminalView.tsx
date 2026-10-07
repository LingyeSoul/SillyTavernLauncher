/**
 * 终端视图（设计 §4.1，核心）：
 * - 主区 padding 12，flex column，不滚动（自管滚动形态）。
 * - 日志卡：virtual-list alignment=top followTail，ANSI 彩色行渲染
 *   （段 = 相邻 <text>，需在 display:flex + row 容器内才合并一行，见 LogRow）。
 *   DEVIATION: 设计 §4.1 与 gpuix-migration-design 指定 alignment=bottom（不足
 *   一屏日志贴底）；2026-09-20 改为 top：不足一屏时从顶部向下填充，满屏后
 *   followTail 跟尾语义不变。
 *   DEVIATION（审计 C4）：有日志时日志卡锁深底（dark 集）——ANSI 色板按深色调校
 *   且着色在引擎解析时烘焙进 store 行（terminalLogs 模块级单例，无主题重解析
 *   通道），亮色主题下近白前景在浅底不可读；控制台锁深底是通行惯例。无日志
 *   保持主题底喂 EmptyState（共享组件消费主题色，不为其造暗色变体）。
 * - 窗口化渲染（2026-09-21 性能修复）：virtual-list 的 itemCount/windowStart
 *   协议下只挂载 [windowStart, windowStart+WINDOW_ROWS) 的行切片——全量挂载
 *   实测每行 3 个原生元素常驻（RSS ~34KB/行，20k 行 842MB），且每行追加成本
 *   随 N 线性增长（涓流 52ms/行@20k）。窗口随滚动（onVisibleRange）与尾部
 *   跟随（新行入库前滑）由本视图推动——gpuix 文档明确 itemCount 增长不会
 *   自动扩窗，不推窗新行永远不挂载。
 * - 底部 5 按钮接 stLifecycle（安装/启动/停止/更新/清空，各带 tooltip 350ms）。
 * - 右缘自绘滚动条（2026-09-29，components/ScrollBar）：轨道为列表兄弟列
 *   （12px 常驻预留），拖拽经 scrollToItem 行进。thumb 锚点双源合一（2026-09-30
 *   真窗探针重构）：vr 事件（原生滚轮）+ 滚动指令后的 getListScrollTop 原生
 *   读回（live 渲染器对程序化滚动不发 vr 事件，见组件内锚点数据流注释）。
 *   日志卡因此改行布局（无日志时保持列布局喂 EmptyState）。
 * - 中文文案集中于顶部常量对象（i18n 缝）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, useGpuixRequired, useWindowSize } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'
import type { EventPayload } from '@gpuix/native'
import { EASE_OUT_QUAD, dark, dur, layout } from '../../theme'
import { useMotion, useTheme } from '../theme'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { ScrollBar, SCROLLBAR_TRACK_W } from '../components/ScrollBar'
import { Tooltip } from '../components/Tooltip'
import type { IconName } from '../components/icons'
import { mainWindowQueryState } from '../../services/windowControl'
import {
  classifyLogLevel,
  useTerminalLogs,
  type EngineSeg,
  type TerminalLine,
} from '../../stores/terminalLogs'
import { useStState, isDirBusy } from '../../stores/stState'
import { terminalRowHeight, useSettings } from '../../stores/settings'
import { useUiState } from '../../stores/uiState'
import { getConfigStore } from '../../services/configStore'
import { errMsg, logError } from '../../services/errorLog'
import { probeScroll } from '../../services/devProbe'

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
 * virtual-list（paddingLeft/Right 8×2）的布局常量同源；估算误差由引擎像素折行的
 * 安全余量（wrapBudgetPx）与 LogRow 的 overflow hidden 双重兜底。
 */
const DIVIDER_PX = 1
const CARD_BORDER_PX = 2
const LIST_PADDING_X_PX = 16
/** 底部按钮行高（按钮 34 垂直居中于 50 高容器），布局预算与滚动条轨道高推导共用 */
const BUTTON_ROW_H = 50
/**
 * 滚动条轨道高的布局推导（窗口定尺寸 800×644）：
 * 内容区 644 − 视图 padding 24 − 卡片 gap 12 − 按钮行 50 − 卡片边框 2 = 556。
 * 实测 bounds 落地前的初值（ScrollBar 内部自愈修正）。
 */
const TRACK_H_ESTIMATE =
  layout.windowH - 2 * layout.padTerminal - layout.padTerminal - BUTTON_ROW_H - CARD_BORDER_PX

function terminalTextWidthPx(windowWidth: number): number {
  // SCROLLBAR_TRACK_W：有日志时轨道列常驻（宽度稳定优先于"恰好装满"，
  // 防溢出临界点上折行列数抖动），文本可用宽相应扣减
  return (
    windowWidth - layout.sidebarW - DIVIDER_PX - 2 * layout.padTerminal - CARD_BORDER_PX - LIST_PADDING_X_PX -
    SCROLLBAR_TRACK_W
  )
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
    // 级别兜底色取 dark 集：日志卡有日志时锁深底（见文件头 DEVIATION），
    // 亮色主题的 status.* 在深底上虽可读但两套色并置会随主题漂移观感
    const color =
      level === 'error' ? dark.status.error
      : level === 'warning' ? dark.status.warning
      : dark.status.info
    return [{ text: line.text, color, weight: level === 'error' ? 500 : undefined }]
  }, [line.text, line.segs, t])

  const body = segs.map((s, i) => (
    <text
      key={i}
      style={{
        fontSize,
        fontFamily,
        // 无色段兜底取 dark.text.secondary：日志卡有日志时锁深底（文件头 DEVIATION）
        color: s.color ?? dark.text.secondary,
        fontWeight: s.weight,
        textDecoration: s.underline ? 'underline' : undefined,
      }}>
      {s.text}
    </text>
  ))

  // 段必须落在 display:flex + flexDirection:'row' 容器内才会合并一行
  // （纯 div 中相邻 <text> 纵向堆叠，实测结论）；overflow hidden 吸收像素折行
  // advance 模型误差（估算偏窄时末列亦不撑开 virtual-list 内容宽）
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
  /** onVisibleRange 最近一次区间（滚动条 thumb 驱动；缺字段事件不更新，推窗"不动窗口"口径） */
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number } | null>(null)
  /** 最近已知可视行数（scrollToRow 读回路径合成 end 用）：applyVisibleAnchor
   *  同步实测值；初值按默认行高 22 估算（ScrollBar.wheelToRows 同款口径） */
  const visibleRowsRef = useRef(Math.max(1, Math.round(TRACK_H_ESTIMATE / 22)))
  /** 尾部跟随的 UI 镜像（与 atTailRef 同点位写；滚动条尾部锚定用） */
  const [tailPinned, setTailPinned] = useState(true)
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

  // 滚动条行进出口的挂载锚与渲染器（锚点数据流与 scrollToRow 共用）
  const renderer = useGpuixRequired()
  const listRef = useRef<PublicInstance | null>(null)

  // —— 滚动锚点数据流（2026-09-30 真窗探针实证重构）——
  // live 渲染器对程序化 scrollToItem 不发 onVisibleRange 事件（拖拽全程 0 条，
  // 释后 2.3s 才迟来一条陈旧区间）；offscreen 台架却即时连发——单测全绿、真窗
  // thumb 卡死的根因。原生用户滚轮（直滚列表）事件正常。故锚点单一真源改为
  // getListScrollTop 原生读回（live 同步可用且精确，探针锚点逐 move 校验）：
  // 滚动指令（拖拽/轨道点击/滚轮转发）后主动读回应用；vr 事件到达时读回校正
  // 载荷（陈旧事件不得回写旧锚点）。

  /** 可视锚点统一应用（滚动条 thumb 驱动 + 尾部判定 + 推窗）；vr 事件与滚动
   *  指令读回共用出口。useState 稳定 + 全 module 常量 → useCallback 空依赖 */
  const applyVisibleAnchor = useCallback((start: number, end: number): void => {
    const len = useTerminalLogs.getState().lines.length
    const s = Math.max(0, Math.min(start, Math.max(0, len - 1)))
    visibleRowsRef.current = Math.max(1, end - s)
    // 同值不换引用：vr 空转窗口内重复抵达不产生提交（mirror 同款契约）
    setVisibleRange((prev) => (prev !== null && prev.start === s && prev.end === end ? prev : { start: s, end }))
    if (end >= len) {
      atTailRef.current = true
      setTailPinned(true)
      setWindowStart(Math.max(0, len - WINDOW_ROWS))
    } else {
      atTailRef.current = false
      setTailPinned(false)
      setWindowStart(Math.max(0, Math.min(s - WINDOW_OVERSCAN, len - WINDOW_ROWS)))
    }
  }, [])

  /** 原生锚点读回：[itemIndex, offsetPx, viewportH]，itemIndex==len 为 gpui
   *  at-end 哨兵（钳到 len-1，尾部分支按 end>=len 收）。读回失败返回 null */
  const readNativeAnchor = useCallback((): number | null => {
    const el = listRef.current
    if (!el || mainWindowQueryState() === 'frozen') return null
    try {
      const anchor = renderer.getListScrollTop?.(el.id)
      if (anchor && Number.isFinite(anchor[0]) && anchor[0] >= 0) return anchor[0]
    } catch (err) {
      logError(`[terminal] 读回列表锚点失败: ${errMsg(err)}`)
    }
    return null
  }, [renderer])

  const handleVisibleRange = (e: EventPayload): void => {
    if (e.startIndex === undefined && e.endIndex === undefined) return
    const len = useTerminalLogs.getState().lines.length
    // 锚点以读回为准（vr 载荷可陈旧）；可视行数优先取事件区间实测（唯一实测源）
    const native = readNativeAnchor()
    probeScroll(`vr len=${len} start=${e.startIndex} end=${e.endIndex} readback=${native}`)
    const start = native !== null ? native : (e.startIndex ?? 0)
    const end =
      e.endIndex ??
      (visibleRange ? start + Math.max(1, visibleRange.end - visibleRange.start) : len)
    applyVisibleAnchor(start, end)
  }

  /** 清空同时复位窗口与尾部状态：防止缓冲清空后窗口停留在越界位置 */
  const handleClear = (): void => {
    atTailRef.current = true
    setTailPinned(true)
    setVisibleRange(null)
    setWindowStart(0)
    clear()
  }

  // 滚动条行进出口：scrollToItem 走逻辑行号（窗口化协议下 native 侧自行解锚，
  // mirrorDialogPerf 深滚用例已实证）；renderer 调用一律冻结门检 + try/catch
  //（AGENTS.md 铁律）。行数取 getState 现值——拖拽中有新行入库时渲染期闭包已过期。
  // 行进后读回原生锚点立即应用：live 渲染器对程序化滚动不发 vr 事件（见上方
  // 锚点数据流注释），thumb/推窗必须由指令侧自驱动
  const scrollToRow = useCallback(
    (row: number): void => {
      const el = listRef.current
      if (!el || mainWindowQueryState() === 'frozen') return
      const len = useTerminalLogs.getState().lines.length
      if (len <= 0) return
      const clamped = Math.min(Math.max(row, 0), len - 1)
      try {
        renderer.scrollToItem?.(el.id, clamped, 0)
      } catch (err) {
        logError(`[terminal] 滚动条行进失败: ${errMsg(err)}`)
        return
      }
      // 读回失败兜底指令行号（探针实证 live 读回 == 指令行，逐 move 校验）
      const native = readNativeAnchor()
      probeScroll(`scrollTo row=${clamped} readback=${native}`)
      const start = native !== null ? Math.min(native, len - 1) : clamped
      applyVisibleAnchor(start, start + Math.max(1, visibleRowsRef.current))
    },
    [renderer, readNativeAnchor, applyVisibleAnchor],
  )
  // 字号联动 virtual-list 估算高度（与 LogRow 行高同源：terminalRowHeight）
  const fontSize = useSettings((s) => s.terminalFontSize)
  const fontFamilySetting = useSettings((s) => s.terminalFontFamily)
  const fontFamily = fontFamilySetting || t.font.mono
  const estimatedRowHeight = terminalRowHeight(fontSize)
  // 视口折行校准：窗宽/字号/字体任一变 → 重算几何写入引擎（窗口当前固定 800，
  // 校准主要为字号与自定义字体服务；引擎默认几何即标准窗推导，覆盖挂载前日志）
  const { width: windowWidth } = useWindowSize()
  useEffect(() => {
    useTerminalLogs.getState().setWrapGeometry({
      availablePx: terminalTextWidthPx(windowWidth),
      fontSize,
      fontFamily,
    })
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
  // 滚动条锚点推导：尾部跟随时 visibleRange 事件不随行入库连发，锚点须由行数
  // 现算（否则 thumb 随新行漂向上）；非尾部用最近事件区间。可视行数无事件时
  // 按布局估算（≈556/行高）
  const estVisibleRows = Math.max(1, Math.round(TRACK_H_ESTIMATE / estimatedRowHeight))
  const visibleRows = visibleRange ? Math.max(1, visibleRange.end - visibleRange.start) : estVisibleRows
  const startRow = tailPinned || !visibleRange ? Math.max(0, lineCount - visibleRows) : visibleRange.start
  const logOverflow = lineCount > visibleRows
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
      {/* 日志卡：bg-deep 外框 + 1px subtle + radius 6。有日志时行布局
          （virtual-list + 右缘滚动条轨道兄弟列）；无日志保持列布局喂 EmptyState */}
      <div
        testId="terminal-log-card"
        style={{
          flexGrow: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: hasLogs ? 'row' : 'column',
          // 锁深底只在有日志时启用（理由见文件头 DEVIATION 审计 C4）
          backgroundColor: hasLogs ? dark.bg.deep : t.bg.deep,
          borderWidth: 1,
          borderColor: hasLogs ? dark.border.subtle : t.border.subtle,
          borderRadius: t.radius.md,
          overflow: 'hidden',
        }}>
        {hasLogs ? (
          <>
            {/* 列表内缩 wrapper：virtual-list 自身的 paddingLeft/Right 不内缩子项
                （2026-09-30 真窗探针实证：行盒 x=列表左缘，16px 死样式全变右侧
                死区），内缩改由本 wrapper 真实生效——左缘呼吸恢复，右缘文本可用
                宽与 terminalTextWidthPx 的 LIST_PADDING_X_PX=16 口径物理对齐 */}
            <div
              style={{
                flexGrow: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                paddingLeft: 8,
                paddingRight: 8,
                paddingTop: 4,
                paddingBottom: 4,
              }}>
              <virtual-list
                ref={listRef}
                testId="terminal-log-list"
                alignment="top"
                followTail
                itemCount={lineCount}
                windowStart={windowStart}
                estimatedItemHeight={estimatedRowHeight}
                onVisibleRange={handleVisibleRange}
                style={{ flexGrow: 1, minWidth: 0 }}>
                {windowLines.map((line) => (
                  <LogRow key={line.id} line={line} animate={line.animate && line.id > animateCutoff} />
                ))}
              </virtual-list>
            </div>
            <ScrollBar
              testId="terminal-scrollbar"
              itemCount={lineCount}
              visibleRows={visibleRows}
              startRow={startRow}
              rowHeight={estimatedRowHeight}
              overflow={logOverflow}
              onScrollToRow={scrollToRow}
              estimatedTrackH={TRACK_H_ESTIMATE}
            />
          </>
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
          height: BUTTON_ROW_H,
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
