/**
 * 终端引擎：@xterm/headless 无头终端驱动的 ANSI 解析与视觉行提取（方案 B）。
 *
 * - 职责：把"一行日志文本"写入无头 xterm 终端，借其完整 VT/ANSI 状态机
 *   （16/256/真彩色、粗体、下划线、行中 \r 覆写）解析后，从 buffer 提取
 *   "视觉行 + 颜色段"交回调用方渲染。折行**不**用 xterm 的整数列模型，
 *   见下方"像素折行"说明。
 * - 渲染仍由 GPUIX 完成（virtual-list + <text> 段）。本模块零 DOM 依赖，
 *   与 GPUIX 无 DOM / 无 webview / canvas 未实现的宿主约束天然兼容——
 *   xterm.js 的浏览器渲染器（DOM/Canvas2D/WebGL）在本项目不可用，故只用其引擎。
 * - ← stores/terminalLogs.ts parse_ansi_text 的替代：手写 SGR 正则解析退役；
 *   非 SGR CSI 的输入侧消毒正则保留迁移（防游标移动/擦除序列把光标搬离
 *   增量提取窗口，导致静默丢行——与旧版"剔除乱码序列"语义一致）。
 *
 * 像素折行（2026-09-30 重构，修"折行末字符距右边界过大"报障）：
 * - 旧模型按 xterm 整数列折行（CJK=2 列 × ASCII advance 当预算），真窗实测
 *   （scripts/probe-wrap-width.ts）CJK 字形实际 advance ≈ 1.0em = 11.95px@12px，
 *   而列预算按 2×6.6=13.2px 计——纯中文折行段每行白送 ~53px，末字符距右边界
 *   66px（ASCII 14px）。列格模型与 GPUIX 字形流排布结构性失配，修表救不了。
 * - 新模型：xterm 固定 1000 宽列（长逻辑行不再被列模型折断），提取时按
 *   isWrapped 归并出完整逻辑行，再按**像素预算**逐字符累计折行：
 *   xterm width-1 字符按字体 advance 表（MONO_ADVANCE_EM）估算，width-2
 *   （CJK/全角）按 1.0em 估算（各常见 CJK 字形/回退字体 advance 实测 ≈1em 整）。
 *   ASCII 估算 6.6 vs 实测 6.581、CJK 12.0 vs 11.953——两端误差 <0.5%，
 *   折行段可填满至"安全余量 + 末字符粒度"以内。
 *
 * 增量提取原理（DEVIATION: 计划稿为 prevCursorAbs 手动计数；实现改用
 * registerMarker——marker 的 line 坐标在 scrollback 裁剪时由 xterm 自动平移，
 * 免去手动追踪 trim 计数，任何行数下不会错位）：
 * - write() 是异步解析的：若在前一行的解析回调前注册下一行的 marker，
 *   光标尚未推进，两个 marker 指向同一行，后到的回调会重复发射前行。
 *   因此写入必须串行化（泵模式）：上一行解析回调触发后才写入下一行，
 *   marker 恒注册在真实起始行，提取区间 [marker.line, baseY+cursorY)。
 * - 泵合批（2026-09-21 性能修复）：microtask 内到达的同 tag 连续行合并为
 *   一个写块（上限 500 行/块），写/解析/发射从每行一次降为每块一次——
 *   涓流场景单行端到端成本实测 52ms@20k 行的主因之一就是逐行发射。
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

/** 折行几何：文本区可用像素宽 + 当前字体（字号/字体族），advance 由引擎自查表 */
export interface WrapGeometry {
  availablePx: number
  fontSize: number
  fontFamily: string
}

export interface TerminalEngine {
  /** 写入一行（引擎自行补 \n；空行与纯 CSI 行跳过（对齐 readStreamLines 的 if(text)） */
  writeLine(text: string, tag?: unknown): void
  /** 丢弃终端与全部未决写入（清空日志用） */
  reset(): void
  /**
   * 视口折行几何校准（窗口宽 / 字号 / 字体变化时由视图层重算写入）。
   * xterm 恒为 1000 宽列（不参与折行，见文件头"像素折行"），本调用只更新
   * 提取侧的像素预算；泵串行化保证几何变更只落在两次 write 解析回调之间，
   * 在途 write 仅以新几何折行，不损坏提取。
   */
  setWrapGeometry(geo: WrapGeometry): void
}

/**
 * xterm 固定列数：取足够宽使常规日志行不被列模型折断（超长行仍会被折断，
 * 提取时按 isWrapped 归并回完整逻辑行再像素折行，语义不受影响）。
 */
const TERM_COLS = 1000
const ROWS = 10
/** 只需容纳在途 write 的 marker 行（提取即时发生，与展示回滚无关），2000 余量充足 */
const SCROLLBACK = 2000
/** 折行列数下限（列口径保留）：防极小视口退化为逐字折行 */
export const MIN_COLS = 20
/** 视口宽度安全余量（px）：吸收 advance 表估算误差与 DPI 分数布局噪声，防末列被裁剪 */
const WRAP_SAFETY_PX = 4
/** 未收录字体的 advance 保守回退（按偏宽估算，宁可早折行也不溢出裁剪） */
const ADVANCE_EM_FALLBACK = 0.6
/**
 * 宽字符（xterm width-2：CJK/全角/emoji）advance 估算：按 1.0em。真窗实测
 * （probe-wrap-width，2026-09-30）Consolas 缺字回退（雅黑/宋体类）CJK 字形
 * advance = 11.95px@12px ≈ 0.996em，Sarasa/黑体类等宽 CJK 字体亦为 1em 整；
 * 按 1.0em 估算偏宽 ≤0.5%，折行宁早勿裁（裁剪比留白伤害大）。
 */
const WIDE_ADVANCE_EM = 1.0

/**
 * 默认折行几何：标准窗（800 宽）布局推导的占位，覆盖 TerminalView 挂载前
 * 到达的启动日志；挂载后由视图按实际窗宽/字号/字体经 setWrapGeometry 校准。
 * 推导：800 − 168 侧栏 − 1 分隔线 − 2×12 视图 padding − 2×1 卡片边框 −
 * 2×8 列表 padding − 16 滚动条轨道 = 573（与 TerminalView.terminalTextWidthPx 同源）。
 */
const DEFAULT_WRAP_GEO: WrapGeometry = { availablePx: 573, fontSize: 12, fontFamily: 'Consolas' }

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

/** 窄字符（xterm width-1）像素 advance */
export function narrowAdvancePx(fontSize: number, fontFamily: string): number {
  return fontSize * advanceEmOf(fontFamily)
}

/** 宽字符（xterm width-2，CJK/全角）像素 advance */
export function wideAdvancePx(fontSize: number): number {
  return fontSize * WIDE_ADVANCE_EM
}

/**
 * 折行像素预算（纯函数便于单测）：可用宽 − 安全余量，下限 MIN_COLS 个窄字符宽
 * （防极窄视口逐字折行）。输入异常时返回下限保底。
 */
export function wrapBudgetPx(geo: WrapGeometry): number {
  const narrow = narrowAdvancePx(geo.fontSize, geo.fontFamily)
  if (!(geo.availablePx > 0) || !(narrow > 0)) {
    // 输入异常（零宽/零字号）：退回默认几何的 MIN_COLS 下限预算
    return MIN_COLS * narrowAdvancePx(DEFAULT_WRAP_GEO.fontSize, DEFAULT_WRAP_GEO.fontFamily)
  }
  return Math.max(geo.availablePx - WRAP_SAFETY_PX, MIN_COLS * narrow)
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

/** 单个 cell 的提取快照（文本 + 颜色/属性 + xterm 宽度类） */
interface EngineCell {
  chars: string
  color?: string
  bold: boolean
  underline: boolean
  /** xterm 宽度类：1=窄（按字体 advance 表）、2=宽（CJK/全角，按 1em）、0=零宽（组合附标，advance 0） */
  width: number
}

/** 一个 buffer 行 → cells 快照（跳过空 cell；颜色/旗标解析同旧 extractRow） */
function cellsOfLine(term: Terminal, y: number): EngineCell[] {
  const line = term.buffer.active.getLine(y)
  if (!line) return []
  const cells: EngineCell[] = []
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
        cells.push({
          chars,
          color,
          bold: cell.isBold() !== 0,
          underline: cell.isUnderline() !== 0,
          width: cell.getWidth(),
        })
      }
    }
    cell = line.getCell(x + 1, cell)
  }
  return cells
}

/** 像素折行：按 advance 模型逐字符累计，超出预算即断行；宽字符放不进剩余
 *  空隙时整体移到下一行（不半裁），零宽字符恒随前字符同 row。预算比较带
 *  epsilon——advance 表值 × 字号的 IEEE 累加尘埃（20×6.6=132.00000000000003）
 *  不得移动折行点 */
function wrapCells(cells: EngineCell[], geo: WrapGeometry): EngineCell[][] {
  const budget = wrapBudgetPx(geo)
  const narrow = narrowAdvancePx(geo.fontSize, geo.fontFamily)
  const wide = wideAdvancePx(geo.fontSize)
  const rows: EngineCell[][] = [[]]
  let used = 0
  for (const cell of cells) {
    const adv = cell.width === 2 ? wide : cell.width === 1 ? narrow : 0
    const cur = rows[rows.length - 1]!
    if (cur.length > 0 && used + adv - budget > 1e-6) {
      rows.push([])
      used = 0
    }
    rows[rows.length - 1]!.push(cell)
    used += adv
  }
  return rows
}

/** 一行 cells → 纯文本 + 颜色段（相邻同属性归并；尾部空白裁剪，对齐行式日志的 rstrip 语义） */
function rowFromCells(cells: EngineCell[]): { text: string; segs: EngineSeg[] } {
  const segs: EngineSeg[] = []
  let text = ''
  for (const cell of cells) {
    const last = segs[segs.length - 1]
    if (
      last !== undefined &&
      (last.color ?? null) === (cell.color ?? null) &&
      (last.weight !== undefined) === cell.bold &&
      !!last.underline === cell.underline
    ) {
      last.text += cell.chars
    } else {
      segs.push({
        text: cell.chars,
        color: cell.color,
        weight: cell.bold ? 500 : undefined,
        underline: cell.underline || undefined,
      })
    }
    text += cell.chars
  }
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
  /** 当前折行几何（setWrapGeometry 校准；createTerm 不读它，提取侧像素折行用） */
  let wrapGeo = DEFAULT_WRAP_GEO
  let term = createTerm()
  /** 待写队列 + 泵状态：写入串行化，保证 marker 恒注册在真实起始行 */
  let queue: Array<{ text: string; tag?: unknown }> = []
  let pumping = false
  let pumpScheduled = false

  /**
   * 单块行数上限：合批与响应性的折中——无上限时一次 1 万行的 write 会在
   * xterm 解析与行提取上一次性占用过长，500 行/块在洪峰下仍把写次数
   * 降低两个数量级，单块解析保持亚毫秒~毫秒级。
   */
  const MAX_CHUNK_LINES = 500

  function createTerm(): Terminal {
    return new Terminal({
      cols: TERM_COLS,
      rows: ROWS,
      scrollback: SCROLLBACK,
      // buffer / markers 属实验性 API，读取缓冲必需（6.0 类型声明标注）
      allowProposedApi: true,
    })
  }

  function pump(): void {
    if (pumping) return
    const first = queue.shift()
    if (first === undefined) return
    pumping = true
    const myGen = gen
    // 同 tag 连续行合并为一个写块（stdout/stderr 各自成块，行标签不串）；
    // 写/解析/发射次数从"每行一次"降为"每块一次"
    const chunk = [first]
    while (queue.length > 0 && chunk.length < MAX_CHUNK_LINES && queue[0]!.tag === first.tag) {
      chunk.push(queue.shift()!)
    }
    const marker = term.registerMarker(0)
    // 行首 \r 校正（逐行语义见 writeLine 历史注释）：每行 \r 前缀、\n 分隔、
    // 尾部 \n——与逐行单独 write（'\r' + text + '\n'）的光标轨迹完全一致
    const payload = chunk.map((item) => `\r${item.text}`).join('\n') + '\n'
    term.write(payload, () => {
      try {
        if (myGen === gen) {
          const buf = term.buffer.active
          const cursorAbs = buf.baseY + buf.cursorY
          const from =
            marker !== undefined && !marker.isDisposed && marker.line >= 0
              ? marker.line
              : Math.max(0, cursorAbs - 1) // 兜底：marker 失效时只取最后一行（极端 flood 下的降级）
          // 按行首归并出完整逻辑行：xterm 1000 宽列下常规日志行不被列模型折断，
          // 超长行折断的续行（isWrapped）拼回同一逻辑行，再统一走像素折行
          const logical: EngineCell[][] = []
          for (let y = from; y < cursorAbs; y++) {
            const cells = cellsOfLine(term, y)
            if (buf.getLine(y)?.isWrapped && logical.length > 0) {
              logical[logical.length - 1]!.push(...cells)
            } else {
              logical.push(cells)
            }
          }
          const rows: EngineRow[] = []
          for (const cells of logical) {
            for (const rowCells of wrapCells(cells, wrapGeo)) {
              rows.push({ ...rowFromCells(rowCells), tag: first.tag })
            }
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

  function schedulePump(): void {
    if (pumpScheduled) return
    pumpScheduled = true
    // microtask 合批：同步突发（appendBatch 循环推入的多行）在泵启动前全部
    // 入队，作为一整块写出；涓流到达的行仍逐行即时处理，不增加可感知延迟
    queueMicrotask(() => {
      pumpScheduled = false
      pump()
    })
  }

  function writeLine(text: string, tag?: unknown): void {
    if (text === '') return
    const sanitized = text.replace(ANSI_OTHER_CSI_RE, '')
    if (sanitized === '') return
    queue.push({ text: sanitized, tag })
    schedulePump()
  }

  function reset(): void {
    gen++
    queue = []
    pumping = false
    pumpScheduled = false
    term.dispose()
    term = createTerm()
  }

  function setWrapGeometry(next: WrapGeometry): void {
    // xterm 恒为 1000 宽列，几何只影响提取侧像素折行（见文件头）；数值合法
    // 性在 wrapBudgetPx 收口，此处直接持有现值
    wrapGeo = next
  }

  return { writeLine, reset, setWrapGeometry }
}
