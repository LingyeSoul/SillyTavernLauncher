/**
 * terminalLogs store（D3：完整缓冲 + 上限 10 万行软限制）。
 *
 * - 行级动画限流（§4.1 anti-pattern A4 对策）：append 时给"本批新增"行打 animate 标记；
 *   进程输出速率超过 60 行/秒持续 2 秒进入 flood 模式，全局禁用行级动画直到速率回落。
 * - 同时维护设计文档要求的 animateFromIndex（>= 该索引且 !floodMode 的行动画）与 floodMode。
 * - ANSI 解析 ← src/core/terminal.py parse_ansi_text（语义移植：SGR 颜色码 → 段数组；
 *   Python 的 Flet 色名换成 GPUIX 十六进制等值）。
 */
import { create } from 'zustand'

export interface AnsiSegment {
  text: string
  color?: string
}

export interface TerminalLine {
  id: number
  text: string
  stream: 'stdout' | 'stderr'
  /** 本行是否播放入场动画（append 时按 flood 状态决定） */
  animate: boolean
}

/** ← terminal.py 的软限制等价物：内存完整缓冲，10 万行 LRU */
export const MAX_LINES = 100_000
/** flood 判定：滑动窗口内速率（行/秒）超过该值持续 FLOOD_WINDOW_MS 进入 flood 模式 */
export const FLOOD_RATE = 60
export const FLOOD_WINDOW_MS = 2000

const ANSI_COLOR_RE = /\x1b\[([0-9;]*)m/g
/**
 * 非 SGR 的 CSI 序列：直接剔除，避免日志区出现乱码方块。
 * 终结符取 CSI 全集 0x40-0x7E（含 ?25h/?25l 私有模式、r/d/G 等，修复原 [A-HJKSTfsu]
 * 缺终结符导致 \x1b[?25l 泄漏渲染成乱码）；SGR 终结符 m 用 (?!m) 排除留给彩色解析。
 * 参数字节 0x30-0x3F（含 :;<=>? 私有前缀），中间字节 0x20-0x2F。
 */
const ANSI_OTHER_CSI_RE = /\x1b\[[0-9:;<=>?]*[ -/]*(?!m)[@-~]/g

/** ← COLOR_MAP 的十六进制转写（深色底可见性优先） */
const ANSI_COLORS: Record<string, string> = {
  '30': '#929AA3',
  '31': '#F18C96', '32': '#89C5A2', '33': '#E3BC75', '34': '#91B9EA',
  '35': '#D8A8DF', '36': '#8FD4D4', '37': '#EEF0F2',
  '90': '#929AA3', '91': '#F1A3AC', '92': '#A9DDBF', '93': '#EACD96',
  '94': '#A9CBEF', '95': '#E2BEE7', '96': '#ACE4E4', '97': '#FFFFFF',
}

/**
 * 解析 ANSI 文本为带颜色的段数组（← parse_ansi_text）。
 * 复合 SGR（如 1;32）取最后一个被识别的颜色码（DEVIATION: Python 仅精确匹配单码）。
 */
export function parseAnsiSegments(text: string): AnsiSegment[] {
  if (!text) return []
  const cleaned = text.replace(ANSI_OTHER_CSI_RE, '')
  const segments: AnsiSegment[] = []
  let currentColor: string | undefined
  let lastIndex = 0
  for (const match of cleaned.matchAll(ANSI_COLOR_RE)) {
    const index = match.index ?? 0
    const chunk = cleaned.slice(lastIndex, index)
    if (chunk) segments.push({ text: chunk, color: currentColor })
    const codes = (match[1] ?? '').split(';')
    const last = codes[codes.length - 1] ?? ''
    // '' / 0 = 全重置；39 = 前景恢复默认（49 背景默认未建模，自然为 no-op）
    if (last === '' || last === '0' || last === '39') currentColor = undefined
    else if (ANSI_COLORS[last]) currentColor = ANSI_COLORS[last]
    lastIndex = index + match[0].length
  }
  const tail = cleaned.slice(lastIndex)
  if (tail) segments.push({ text: tail, color: currentColor })
  return segments
}

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
/** flood 检测的滑动窗口（append 时间戳） */
let appendTimestamps: number[] = []
let floodUntil = 0

function updateFloodState(): { flood: boolean } {
  const now = Date.now()
  appendTimestamps.push(now)
  appendTimestamps = appendTimestamps.filter((ts) => now - ts <= FLOOD_WINDOW_MS)
  const rate = appendTimestamps.length / (FLOOD_WINDOW_MS / 1000)
  if (rate > FLOOD_RATE) floodUntil = now + FLOOD_WINDOW_MS
  return { flood: now < floodUntil }
}

export const useTerminalLogs = create<TerminalLogsState>((set, get) => ({
  lines: [],
  animateFromIndex: 0,
  floodMode: false,

  appendBatch: (items) => {
    if (items.length === 0) return
    const { flood } = updateFloodState()
    const { lines } = get()
    const startIndex = lines.length
    const newLines: TerminalLine[] = items.map((item) => ({
      id: nextLineId++,
      text: item.text,
      stream: item.stream ?? 'stdout',
      // flood 模式下本批全部禁用动画（A4 限流）
      animate: !flood,
    }))
    let all = [...lines, ...newLines]
    // 软限制：超 10 万行从头丢弃
    if (all.length > MAX_LINES) all = all.slice(all.length - MAX_LINES)
    set({
      lines: all,
      floodMode: flood,
      animateFromIndex: flood ? all.length : Math.max(get().animateFromIndex, startIndex),
    })
  },

  appendLine: (text, stream = 'stdout') => {
    get().appendBatch([{ text, stream }])
  },

  clear: () => {
    appendTimestamps = []
    floodUntil = 0
    set({ lines: [], animateFromIndex: 0, floodMode: false })
  },
}))

/** 便捷引用（stLifecycle onLog 回调等非 React 上下文） */
export const terminalLogsActions = {
  appendLine: (text: string, stream?: 'stdout' | 'stderr') =>
    useTerminalLogs.getState().appendLine(text, stream),
  clear: () => useTerminalLogs.getState().clear(),
}
