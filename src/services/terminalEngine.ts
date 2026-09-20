/**
 * 终端引擎：@xterm/headless 无头终端驱动的 ANSI 解析与视觉行提取（方案 B）。
 *
 * - 职责：把"一行日志文本"写入无头 xterm 终端，借其完整 VT/ANSI 状态机
 *   （16/256/真彩色、粗体、下划线、行中 \r 覆写、长行折行）解析后，
 *   从 buffer 提取"视觉行 + 颜色段"交回调用方渲染。
 * - 渲染仍由 GPUIX 完成（virtual-list + <text> 段）。本模块零 DOM 依赖，
 *   与 GPUIX 无 DOM / 无 webview / canvas 未实现的宿主约束天然兼容——
 *   xterm.js 的浏览器渲染器（DOM/Canvas2D/WebGL）在本项目不可用，故只用其引擎。
 * - ← stores/terminalLogs.ts parse_ansi_text 的替代：手写 SGR 正则解析退役；
 *   非 SGR CSI 的输入侧消毒正则保留迁移（防游标移动/擦除序列把光标搬离
 *   增量提取窗口，导致静默丢行——与旧版"剔除乱码序列"语义一致）。
 *
 * 增量提取原理（DEVIATION: 计划稿为 prevCursorAbs 手动计数；实现改用
 * registerMarker——marker 的 line 坐标在 scrollback 裁剪时由 xterm 自动平移，
 * 免去手动追踪 trim 计数，任何行数下不会错位）：
 * - write() 是异步解析的：若在前一行的解析回调前注册下一行的 marker，
 *   光标尚未推进，两个 marker 指向同一行，后到的回调会重复发射前行。
 *   因此写入必须串行化（泵模式）：上一行解析回调触发后才写入下一行，
 *   marker 恒注册在真实起始行，提取区间 [marker.line, baseY+cursorY)。
 */
import { Terminal } from '@xterm/headless'

export interface EngineSeg {
  text: string
  /** 前景色（十六进制）；undefined = 默认色（由渲染层主题决定） */
  color?: string
  /** 粗体 → fontWeight 500（对齐日志视图 error 行的 500 语义） */
  weight?: number
  underline?: boolean
}

export interface EngineRow {
  /** 行纯文本（段拼接；classifyLogLevel 兜底与测试断言用） */
  text: string
  segs: EngineSeg[]
  /** 透传调用方标签（store 用于 stdout/stderr 标记） */
  tag?: unknown
}

export interface TerminalEngine {
  /** 写入一行（引擎自行补 \n）；空行与纯 CSI 行跳过（对齐 readStreamLines 的 if(text)） */
  writeLine(text: string, tag?: unknown): void
  /** 丢弃终端与全部未决写入（清空日志用） */
  reset(): void
  /**
   * 视口折行列数校准（窗口宽 / 字号 / 字体变化时由视图层重算写入）。
   * xterm 按"列"折行（CJK 占 2 列），一列像素宽 = 当前字体 ASCII advance 宽。
   * 泵串行化保证 resize 只落在两次 write 解析回调之间，marker 不跨 resize
   * 存活，增量提取窗口不受影响；在途 write 仅以新几何折行，不损坏提取。
   */
  setCols(cols: number): void
}

/**
 * 初始折行列数：TerminalView 挂载前的占位（启动期日志），
 * 挂载后按实际窗宽/字号/字体经 setCols 校准为视口宽。
 */
const COLS = 1000
const ROWS = 10
/** 只需容纳在途 write 的 marker 行（提取即时发生，与展示回滚无关），2000 余量充足 */
const SCROLLBACK = 2000
/** 折行列数下限：防极小字号/极窄窗退化为逐字折行 */
export const MIN_COLS = 20
/** 视口宽度安全余量（px）：吸收字体 advance 估算误差，防末列被裁剪 */
const WRAP_SAFETY_PX = 4
/** 未收录字体的 advance 保守回退（按偏宽估算，宁可早折行也不溢出裁剪） */
const ADVANCE_EM_FALLBACK = 0.6

/** 常见等宽字体 ASCII 字符 advance 宽（em 占比；Consolas 0.55、Cascadia 0.586 为实测/官方值） */
const MONO_ADVANCE_EM: Readonly<Record<string, number>> = {
  consolas: 0.55,
  'cascadia mono': 0.586,
  'cascadia code': 0.586,
  'jetbrains mono': 0.6,
  'fira code': 0.6,
  'courier new': 0.6,
  'source code pro': 0.6,
  'sarasa mono sc': 0.5,
  'sarasa mono': 0.5,
  'simhei': 0.5,
  'nsimsun': 0.5,
  'ms gothic': 0.5,
}

/** 字体族串 → advance 系数：取逗号列表首项、去引号、小写匹配；未收录走保守回退 */
function advanceEmOf(fontFamily: string): number {
  const first = fontFamily.split(',')[0]?.trim().replace(/^["']|["']$/g, '').toLowerCase() ?? ''
  return MONO_ADVANCE_EM[first] ?? ADVANCE_EM_FALLBACK
}

/**
 * 日志区可用像素宽 → 引擎折行列数。
 * 纯函数便于单测；输入异常时返回下限保底。
 */
export function computeCols(availablePx: number, fontSize: number, fontFamily: string): number {
  const cellPx = fontSize * advanceEmOf(fontFamily)
  if (!(availablePx > 0) || !(cellPx > 0)) return MIN_COLS
  return Math.max(MIN_COLS, Math.floor((availablePx - WRAP_SAFETY_PX) / cellPx))
}

/**
 * 非 SGR 的 CSI 序列：输入侧剔除，避免游标移动/擦除序列把光标搬离增量窗口。
 * ← terminalLogs.ts 原正则迁移（终结符集含 ?25h/?25l 私有模式等；SGR 的 m
 * 终结符用 (?!m) 排除，留给 xterm 解析彩色与属性）。
 */
const ANSI_OTHER_CSI_RE = /\x1b\[[0-9:;<=>?]*[ -/]*(?!m)[@-~]/g

/** ← ANSI_COLORS 的索引式转写：palette 0-7 = SGR 30-37，8-15 = 90-97（深色底可见性优先） */
const PALETTE_0_15: readonly string[] = [
  '#929AA3',
  '#F18C96', '#89C5A2', '#E3BC75', '#91B9EA',
  '#D8A8DF', '#8FD4D4', '#EEF0F2',
  '#929AA3',
  '#F1A3AC', '#A9DDBF', '#EACD96', '#A9CBEF',
  '#E2BEE7', '#ACE4E4', '#FFFFFF',
]

/** 256 色 cube / 灰阶的阶跃值（xterm 标准） */
const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const

function hex2(v: number): string {
  return v.toString(16).padStart(2, '0').toUpperCase()
}

/** 24 位真彩整数 → #RRGGBB */
function rgbToHex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0').toUpperCase()}`
}

/** palette 下标 → 十六进制（16-231 立方体 + 232-255 灰阶，计算式免查表） */
function paletteIndexToHex(index: number): string | undefined {
  if (index < 0) return undefined
  if (index < 16) return PALETTE_0_15[index]
  if (index <= 231) {
    const i = index - 16
    const r = CUBE_STEPS[Math.floor(i / 36)] ?? 0
    const g = CUBE_STEPS[Math.floor(i / 6) % 6] ?? 0
    const b = CUBE_STEPS[i % 6] ?? 0
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  }
  if (index <= 255) {
    const v = 8 + (index - 232) * 10
    return `#${hex2(v)}${hex2(v)}${hex2(v)}`
  }
  return undefined
}

/** 单个视觉行 → 纯文本 + 颜色段（相邻同属性 cell 归并；尾部空白裁剪） */
function extractRow(term: Terminal, y: number): EngineRow {
  const line = term.buffer.active.getLine(y)
  if (!line) return { text: '', segs: [] }
  const segs: EngineSeg[] = []
  let text = ''
  let cell = line.getCell(0)
  for (let x = 0; x < line.length && cell !== undefined; x++) {
    if (cell.getWidth() > 0) {
      const chars = cell.getChars()
      if (chars !== '') {
        const color = cell.isFgDefault()
          ? undefined
          : cell.isFgPalette()
            ? paletteIndexToHex(cell.getFgColor())
            : rgbToHex(cell.getFgColor())
        const bold = cell.isBold() !== 0
        const underline = cell.isUnderline() !== 0
        const last = segs[segs.length - 1]
        if (
          last !== undefined &&
          (last.color ?? null) === (color ?? null) &&
          (last.weight !== undefined) === bold &&
          !!last.underline === underline
        ) {
          last.text += chars
        } else {
          segs.push({ text: chars, color, weight: bold ? 500 : undefined, underline: underline || undefined })
        }
        text += chars
      }
    }
    cell = line.getCell(x + 1, cell)
  }
  // 尾部空白裁剪（对齐行式日志的 rstrip 语义；段内空格保留）
  while (segs.length > 0) {
    const last = segs[segs.length - 1]
    if (last === undefined) break
    const trimmed = last.text.replace(/ +$/, '')
    if (trimmed !== '') {
      if (trimmed !== last.text) last.text = trimmed
      break
    }
    segs.pop()
  }
  text = text.replace(/ +$/, '')
  return { text, segs }
}

export function createTerminalEngine(emit: (rows: EngineRow[]) => void): TerminalEngine {
  let gen = 0
  /** 当前折行列数（setCols 校准；createTerm 读取，reset 后保持） */
  let cols = COLS
  let term = createTerm()
  /** 待写队列 + 泵状态：写入串行化，保证 marker 恒注册在真实起始行 */
  let queue: Array<{ text: string; tag?: unknown }> = []
  let pumping = false

  function createTerm(): Terminal {
    return new Terminal({
      cols,
      rows: ROWS,
      scrollback: SCROLLBACK,
      // buffer / markers 属实验性 API，读取缓冲必需（6.0 类型声明标注）
      allowProposedApi: true,
    })
  }

  function pump(): void {
    if (pumping) return
    const next = queue.shift()
    if (next === undefined) return
    pumping = true
    const myGen = gen
    const marker = term.registerMarker(0)
    // 行首 \r 校正：xterm 收窄 reflow 会把光标列挪到非 0（实测 50→20 列时空尾行
    // 光标落在 col 19），下一次写入会从行中偏移位置开始；\r 归位行首，
    // 常态（光标本就在行首）下是无害空操作
    term.write(`\r${next.text}\n`, () => {
      try {
        if (myGen === gen) {
          const buf = term.buffer.active
          const cursorAbs = buf.baseY + buf.cursorY
          const from =
            marker !== undefined && !marker.isDisposed && marker.line >= 0
              ? marker.line
              : Math.max(0, cursorAbs - 1) // 兜底：marker 失效时只取最后一行（极端 flood 下的降级）
          const rows: EngineRow[] = []
          for (let y = from; y < cursorAbs; y++) {
            rows.push({ ...extractRow(term, y), tag: next.tag })
          }
          if (rows.length > 0) emit(rows)
        }
      } finally {
        marker?.dispose()
        pumping = false
        pump()
      }
    })
  }

  function writeLine(text: string, tag?: unknown): void {
    if (text === '') return
    const sanitized = text.replace(ANSI_OTHER_CSI_RE, '')
    if (sanitized === '') return
    queue.push({ text: sanitized, tag })
    pump()
  }

  function reset(): void {
    gen++
    queue = []
    pumping = false
    term.dispose()
    term = createTerm()
  }

  function setCols(next: number): void {
    const clamped = Math.max(MIN_COLS, Math.floor(next))
    if (clamped === cols) return
    cols = clamped
    term.resize(clamped, ROWS)
  }

  return { writeLine, reset, setCols }
}
