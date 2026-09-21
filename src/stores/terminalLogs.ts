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
 *
 * DEVIATION（性能契约，2026-09-21 起）：
 * - `lines` 是引用恒定的原地演进数组（push/splice 直接改内容，O(行数)），
 *   不再是每次发射全量拷贝的新数组——10 万行稳态下全量拷贝实测 1.4ms/行，
 *   叠加成 O(N²) 填充曲线（基准：N=5k 0.23s → N=100k 17.4s）。
 * - 因此 React 侧禁止 `useTerminalLogs((s) => s.lines)` 订阅（引用不变不会
 *   触发重渲染）：一律订阅 `version`（每次变更自增），用 `getRange(start, end)`
 *   取窗口切片（O(窗口)）。`lines` 保留给测试与非热路径的 getState() 直读。
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
  /**
   * 全量缓冲（原地演进的稳定引用，见文件头 DEVIATION 性能契约）。
   * 测试/非热路径经 getState() 直读；React 组件勿以此做响应式选择器。
   */
  lines: TerminalLine[]
  /** 缓冲版本号：每次发射/清空自增，React 侧的唯一响应式订阅源 */
  version: number
  /** 动画契约（设计 §4.1）：>= 该索引且 !floodMode 的行播放入场动画 */
  animateFromIndex: number
  floodMode: boolean
  appendLine: (text: string, stream?: 'stdout' | 'stderr') => void
  appendBatch: (items: Array<{ text: string; stream?: 'stdout' | 'stderr' }>) => void
  /** 视口折行列数校准（窗口宽/字号/字体变化；透传引擎 setCols） */
  setCols: (cols: number) => void
  clear: () => void
  /** 窗口切片读取（O(窗口)；start 含、end 不含，越界自动收窄） */
  getRange: (start: number, end: number) => TerminalLine[]
  /** 当前最大行 id（视图动画截止线用；空缓冲返回 0） */
  getLastId: () => number
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
  const state = useTerminalLogs.getState()
  const lines = state.lines
  const startIndex = lines.length
  for (const row of rows) {
    lines.push({
      id: nextLineId++,
      text: row.text,
      segs: row.segs,
      stream: (row.tag as 'stdout' | 'stderr' | undefined) ?? 'stdout',
      // flood 模式下本批全部禁用动画（A4 限流）
      animate: !flood,
    })
  }
  // 软限制：超 10 万行从头丢弃（splice O(超出量)，不做全量 slice 拷贝）
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  useTerminalLogs.setState({
    lines,
    version: state.version + 1,
    floodMode: flood,
    animateFromIndex: flood ? lines.length : Math.max(state.animateFromIndex, startIndex),
  })
}

/** 引擎单例（clear/reset 时重建；渲染数据一律经 emitRows 入库） */
let engine = createTerminalEngine(emitRows)

export const useTerminalLogs = create<TerminalLogsState>(() => ({
  lines: [],
  version: 0,
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

  setCols: (cols) => {
    engine.setCols(cols)
  },

  clear: () => {
    engine.reset()
    appendTimestamps = []
    floodUntil = 0
    const lines = useTerminalLogs.getState().lines
    lines.length = 0 // 保持引用恒定（性能契约），内容原地清空
    useTerminalLogs.setState({
      lines,
      version: useTerminalLogs.getState().version + 1,
      animateFromIndex: 0,
      floodMode: false,
    })
  },

  /** 窗口切片读取（O(窗口)；start 含、end 不含，越界自动收窄） */
  getRange: (start: number, end: number): TerminalLine[] => {
    const lines = useTerminalLogs.getState().lines
    const s = Math.max(0, start)
    const e = Math.min(lines.length, end)
    return s >= e ? [] : lines.slice(s, e)
  },

  getLastId: () => nextLineId - 1,
}))

/** 测试隔离：重建引擎 + 清空 store（对齐 configStore 的 __reset*ForTests 模式） */
export function __resetTerminalLogsForTests(): void {
  engine = createTerminalEngine(emitRows)
  appendTimestamps = []
  floodUntil = 0
  nextLineId = 1
  const lines = useTerminalLogs.getState().lines
  lines.length = 0
  useTerminalLogs.setState({
    lines,
    version: 0,
    animateFromIndex: 0,
    floodMode: false,
  })
}

/** 便捷引用（stLifecycle onLog 回调等非 React 上下文） */
export const terminalLogsActions = {
  appendLine: (text: string, stream?: 'stdout' | 'stderr') =>
    useTerminalLogs.getState().appendLine(text, stream),
  clear: () => useTerminalLogs.getState().clear(),
}
