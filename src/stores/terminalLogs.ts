/**
 * terminalLogs store（D3：完整缓冲 + 上限 10 万行软限制）。
 *
 * - 行级动画限流（§4.1 anti-pattern A4 对策）：引擎发射时给"本批新增"行打
 *   animate 标记；输出速率超过 60 行/秒持续 2 秒进入 flood 模式，全局禁用
 *   行级动画直到速率回落。同时维护 animateFromIndex 与 floodMode。
 * - ANSI 解析已移交 services/terminalEngine（@xterm/headless 无头终端，
 *   方案 B）：appendBatch 把行写入引擎，引擎异步发射"视觉行 + 颜色段"，
 *   本模块只负责状态管理（id/flood/LRU）。← 旧版 parse_ansi_text 退役。
 *   DEVIATION: 空文本行不再产生空白行记录（旧版 appendLine('') 会留空行），
 *   与 readStreamLines 的 if (text) 跳过语义对齐。
 */
import { create } from 'zustand'
import {
  createTerminalEngine,
  type EngineRow,
  type EngineSeg,
} from '../services/terminalEngine'

export type { EngineSeg }

export interface TerminalLine {
  id: number
  /** 行纯文本（引擎段拼接；语义分级兜底与测试断言用） */
  text: string
  /** 预解析颜色段（渲染数据；无色行由视图按日志级别兜底着色） */
  segs: EngineSeg[]
  stream: 'stdout' | 'stderr'
  /** 本行是否播放入场动画（引擎发射时按 flood 状态决定） */
  animate: boolean
}

/** ← terminal.py 的软限制等价物：内存完整缓冲，10 万行 LRU */
export const MAX_LINES = 100_000
/** flood 判定：滑动窗口内速率（行/秒）超过该值持续 FLOOD_WINDOW_MS 进入 flood 模式 */
export const FLOOD_RATE = 60
export const FLOOD_WINDOW_MS = 2000

/** 行级语义分级（dt §1.E 日志行类名：error/warn/info/默认） */
export type LogLevel = 'default' | 'error' | 'warning' | 'info'

export function classifyLogLevel(text: string): LogLevel {
  if (/错误|失败|Error|ERROR|✗/.test(text)) return 'error'
  if (/警告|警告:|Warning|WARNING/.test(text)) return 'warning'
  if (/提示|注意|Info|INFO/.test(text)) return 'info'
  return 'default'
}

interface TerminalLogsState {
  lines: TerminalLine[]
  /** 动画契约（设计 §4.1）：>= 该索引且 !floodMode 的行播放入场动画 */
  animateFromIndex: number
  floodMode: boolean
  appendLine: (text: string, stream?: 'stdout' | 'stderr') => void
  appendBatch: (items: Array<{ text: string; stream?: 'stdout' | 'stderr' }>) => void
  clear: () => void
}

let nextLineId = 1
/** flood 检测的滑动窗口（发射时间戳） */
let appendTimestamps: number[] = []
let floodUntil = 0

function updateFloodState(rowCount: number): { flood: boolean } {
  const now = Date.now()
  // 每行一个时间戳（对齐旧版 appendLine 逐行计数的粒度，回调批量合并不失真）
  for (let i = 0; i < rowCount; i++) appendTimestamps.push(now)
  appendTimestamps = appendTimestamps.filter((ts) => now - ts <= FLOOD_WINDOW_MS)
  const rate = appendTimestamps.length / (FLOOD_WINDOW_MS / 1000)
  if (rate > FLOOD_RATE) floodUntil = now + FLOOD_WINDOW_MS
  return { flood: now < floodUntil }
}

/** 引擎发射的视觉行落入 store（flood/LRU/动画契约在此统一收口） */
function emitRows(rows: EngineRow[]): void {
  if (rows.length === 0) return
  const { flood } = updateFloodState(rows.length)
  const { lines, animateFromIndex } = useTerminalLogs.getState()
  const startIndex = lines.length
  const newLines: TerminalLine[] = rows.map((row) => ({
    id: nextLineId++,
    text: row.text,
    segs: row.segs,
    stream: (row.tag as 'stdout' | 'stderr' | undefined) ?? 'stdout',
    // flood 模式下本批全部禁用动画（A4 限流）
    animate: !flood,
  }))
  let all = [...lines, ...newLines]
  // 软限制：超 10 万行从头丢弃
  if (all.length > MAX_LINES) all = all.slice(all.length - MAX_LINES)
  useTerminalLogs.setState({
    lines: all,
    floodMode: flood,
    animateFromIndex: flood ? all.length : Math.max(animateFromIndex, startIndex),
  })
}

/** 引擎单例（clear/reset 时重建；渲染数据一律经 emitRows 入库） */
let engine = createTerminalEngine(emitRows)

export const useTerminalLogs = create<TerminalLogsState>(() => ({
  lines: [],
  animateFromIndex: 0,
  floodMode: false,

  appendBatch: (items) => {
    for (const item of items) {
      engine.writeLine(item.text, item.stream)
    }
  },

  appendLine: (text, stream = 'stdout') => {
    engine.writeLine(text, stream)
  },

  clear: () => {
    engine.reset()
    appendTimestamps = []
    floodUntil = 0
    useTerminalLogs.setState({ lines: [], animateFromIndex: 0, floodMode: false })
  },
}))

/** 测试隔离：重建引擎 + 清空 store（对齐 configStore 的 __reset*ForTests 模式） */
export function __resetTerminalLogsForTests(): void {
  engine = createTerminalEngine(emitRows)
  appendTimestamps = []
  floodUntil = 0
  nextLineId = 1
  useTerminalLogs.setState({ lines: [], animateFromIndex: 0, floodMode: false })
}

/** 便捷引用（stLifecycle onLog 回调等非 React 上下文） */
export const terminalLogsActions = {
  appendLine: (text: string, stream?: 'stdout' | 'stderr') =>
    useTerminalLogs.getState().appendLine(text, stream),
  clear: () => useTerminalLogs.getState().clear(),
}
