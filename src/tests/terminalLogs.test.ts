/**
 * 终端引擎 + terminalLogs 测试（方案 B：@xterm/headless）。
 *
 * - 引擎层：← 旧 parseAnsiSegments 7 用例迁移（Bug#12：CSI 终结符全集 +
 *   SGR 39/49），并扩充 256 色 / 真彩 / 粗体下划线 / \r 覆写 / 长行折行。
 * - store 层：异步发射入库、stream 标签透传、clear 复位、flood 限流
 *   （旧版无覆盖，本次补上）与 classifyLogLevel。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalEngine,
  MIN_COLS,
  narrowAdvancePx,
  wideAdvancePx,
  wrapBudgetPx,
  type EngineRow,
  type WrapGeometry,
} from '../services/terminalEngine'
import {
  __resetTerminalLogsForTests,
  classifyLogLevel,
  useTerminalLogs,
} from '../stores/terminalLogs'

/** 12px Consolas 的窄/宽字符 advance（像素折行预算设计用） */
const NARROW = 6.6
const WIDE = 12
/** 折 N 个窄字符/行的几何（预算 = N×advance + 安全余量 4） */
const geoNarrow = (n: number): WrapGeometry => ({ availablePx: n * NARROW + 4, fontSize: 12, fontFamily: 'Consolas' })
/** 折 N 个宽字符（CJK）/行的几何 */
const geoWide = (n: number): WrapGeometry => ({ availablePx: n * WIDE + 4, fontSize: 12, fontFamily: 'Consolas' })

/**
 * 写入并等待引擎发射：期望 expectedRows 行（引擎行数只增不减，
 * 回调 FIFO，精确计数一旦达成即稳定）。
 */
async function runEngine(
  lines: Array<{ text: string; tag?: unknown }>,
  expectedRows: number,
): Promise<EngineRow[]> {
  const batches: EngineRow[][] = []
  const engine = createTerminalEngine((rows) => batches.push(rows))
  for (const line of lines) engine.writeLine(line.text, line.tag)
  await vi.waitFor(() => {
    expect(batches.flat().length).toBe(expectedRows)
  })
  return batches.flat()
}

describe('terminalEngine（← parse_ansi_text 迁移 + 扩充）', () => {
  it('SGR 颜色码分段 + 0 重置', async () => {
    const rows = await runEngine([{ text: '\x1b[31m错误\x1b[0m 普通' }], 1)
    expect(rows[0]?.segs).toEqual([
      { text: '错误', color: '#F18C96' },
      { text: ' 普通' },
    ])
  })

  it('非 SGR CSI 全终结符剔除（含 ?25h/?25l 私有模式，修复泄漏乱码）', async () => {
    const rows = await runEngine(
      [{ text: '\x1b[?25l光标隐藏\x1b[?25h\x1b[2J\x1b[1;1H\x1b[G\x1b[10d清屏' }],
      1,
    )
    expect(rows[0]?.segs).toEqual([{ text: '光标隐藏清屏' }])
  })

  it('SGR 终结符 m 不被 CSI 剔除误伤（\\x1b[m 空参 = 重置）', async () => {
    const rows = await runEngine([{ text: '\x1b[31m红\x1b[m默认' }], 1)
    expect(rows[0]?.segs).toEqual([
      { text: '红', color: '#F18C96' },
      { text: '默认' },
    ])
  })

  it('39 恢复默认前景色', async () => {
    const rows = await runEngine([{ text: '\x1b[31m红\x1b[39m默认' }], 1)
    expect(rows[0]?.segs).toEqual([
      { text: '红', color: '#F18C96' },
      { text: '默认' },
    ])
  })

  it('49（背景默认）不改变前景色（同属性段归并为一）', async () => {
    const rows = await runEngine([{ text: '\x1b[32m绿\x1b[49m仍绿' }], 1)
    expect(rows[0]?.segs).toEqual([{ text: '绿仍绿', color: '#89C5A2' }])
  })

  it('复合 SGR（1;32）粗体与颜色同时生效（旧版 DEVIATION 只取末位色，现完整解析）', async () => {
    const rows = await runEngine([{ text: '\x1b[1;32mok' }], 1)
    expect(rows[0]?.segs).toEqual([{ text: 'ok', color: '#89C5A2', weight: 500 }])
  })

  it('空文本与纯 CSI 行不产生任何行（对齐 readStreamLines 的 if(text)）', async () => {
    const batches: EngineRow[][] = []
    const engine = createTerminalEngine((rows) => batches.push(rows))
    engine.writeLine('')
    engine.writeLine('\x1b[?25l')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(batches).toHaveLength(0)
  })

  it('256 色（38;5;208 → xterm 标准 #FF8700）', async () => {
    const rows = await runEngine([{ text: '\x1b[38;5;208m橙\x1b[0m' }], 1)
    expect(rows[0]?.segs[0]?.color).toBe('#FF8700')
  })

  it('真彩（38;2;10;200;30 → #0AC81E）', async () => {
    const rows = await runEngine([{ text: '\x1b[38;2;10;200;30m绿\x1b[0m' }], 1)
    expect(rows[0]?.segs[0]?.color).toBe('#0AC81E')
  })

  it('粗体 + 下划线旗标映射', async () => {
    const rows = await runEngine([{ text: '\x1b[1;4mbu\x1b[0m' }], 1)
    expect(rows[0]?.segs[0]).toEqual({ text: 'bu', weight: 500, underline: true })
  })

  it('行中 \\r 覆写：最终视觉行为最后一次写入（进度条语义）', async () => {
    const rows = await runEngine([{ text: '45%\r46%' }], 1)
    expect(rows[0]?.text).toBe('46%')
  })

  it('超长行按默认几何（573px@12px Consolas → 86 字符/行）像素折行', async () => {
    const rows = await runEngine([{ text: 'a'.repeat(1500) }], 18)
    expect(rows[0]?.text).toHaveLength(86)
    expect(rows[16]?.text).toHaveLength(86)
    expect(rows[17]?.text).toHaveLength(38)
  })

  it('CJK 行按 1em advance 折行（2026-09-30 报障回归锁：列模型 2×窄 advance 高估 ~10%）', async () => {
    const batches: EngineRow[][] = []
    const engine = createTerminalEngine((rows) => batches.push(rows))
    engine.setWrapGeometry(geoWide(24))
    engine.writeLine('酒'.repeat(30))
    await vi.waitFor(() => {
      expect(batches.flat().length).toBe(2)
    })
    expect(batches.flat().map((r) => r.text)).toEqual(['酒'.repeat(24), '酒'.repeat(6)])
  })

  it('混合行窄/宽 advance 分别累计（预算内尽量装满）', async () => {
    const batches: EngineRow[][] = []
    const engine = createTerminalEngine((rows) => batches.push(rows))
    // 预算 288：10 CJK（120px）后还能装 25 个 ASCII（165px），第 26 个（171.6）下移
    engine.setWrapGeometry(geoWide(24))
    engine.writeLine('酒'.repeat(10) + 'a'.repeat(30))
    await vi.waitFor(() => {
      expect(batches.flat().length).toBe(2)
    })
    const rows = batches.flat()
    expect(rows[0]?.text).toBe('酒'.repeat(10) + 'a'.repeat(25))
    expect(rows[1]?.text).toBe('a'.repeat(5))
  })

  it('宽字符放不进剩余空隙时整体下移（不半裁）', async () => {
    const batches: EngineRow[][] = []
    const engine = createTerminalEngine((rows) => batches.push(rows))
    // 预算 132：20 个 ASCII 后剩 0px，尾随 CJK 整体下移
    engine.setWrapGeometry(geoNarrow(20))
    engine.writeLine('a'.repeat(20) + '酒')
    await vi.waitFor(() => {
      expect(batches.flat().length).toBe(2)
    })
    expect(batches.flat().map((r) => r.text)).toEqual(['a'.repeat(20), '酒'])
  })

  it('setWrapGeometry 收窄后新行按新预算折行，既有行不重排', async () => {
    const batches: EngineRow[][] = []
    const engine = createTerminalEngine((rows) => batches.push(rows))
    engine.writeLine('a'.repeat(50))
    await vi.waitFor(() => {
      expect(batches.flat().length).toBe(1)
    })
    engine.setWrapGeometry(geoNarrow(20))
    engine.writeLine('b'.repeat(50))
    await vi.waitFor(() => {
      expect(batches.flat().length).toBe(4)
    })
    const rows = batches.flat()
    expect(rows[0]?.text).toHaveLength(50)
    expect(rows.slice(1).map((r) => r.text)).toEqual(['b'.repeat(20), 'b'.repeat(20), 'b'.repeat(10)])
  })

  it('setWrapGeometry 放宽后新行按更宽预算折行', async () => {
    const batches: EngineRow[][] = []
    const engine = createTerminalEngine((rows) => batches.push(rows))
    engine.setWrapGeometry(geoNarrow(80))
    engine.writeLine('c'.repeat(150))
    await vi.waitFor(() => {
      expect(batches.flat().length).toBe(2)
    })
    const rows = batches.flat()
    expect(rows[0]?.text).toHaveLength(80)
    expect(rows[1]?.text).toHaveLength(70)
  })

  it('setWrapGeometry 极窄视口按 MIN_COLS 列宽下限钳制', async () => {
    const batches: EngineRow[][] = []
    const engine = createTerminalEngine((rows) => batches.push(rows))
    engine.setWrapGeometry({ availablePx: 30, fontSize: 12, fontFamily: 'Consolas' })
    engine.writeLine('d'.repeat(45))
    await vi.waitFor(() => {
      expect(batches.flat().length).toBe(3)
    })
    expect(batches.flat().map((r) => r.text)).toEqual(['d'.repeat(20), 'd'.repeat(20), 'd'.repeat(5)])
  })

  it('多行写入保序 + tag 透传', async () => {
    const rows = await runEngine(
      [
        { text: 'first', tag: 'stdout' },
        { text: 'second', tag: 'stderr' },
      ],
      2,
    )
    expect(rows.map((r) => r.text)).toEqual(['first', 'second'])
    expect(rows[0]?.tag).toBe('stdout')
    expect(rows[1]?.tag).toBe('stderr')
  })
})

describe('terminalLogs store（引擎接线）', () => {
  beforeEach(() => {
    __resetTerminalLogsForTests()
  })

  it('appendBatch 异步入库：segs / stream / id 就位', async () => {
    useTerminalLogs.getState().appendBatch([
      { text: '\x1b[31mR\x1b[0m ok', stream: 'stderr' },
      { text: 'plain', stream: 'stdout' },
    ])
    await vi.waitFor(() => {
      expect(useTerminalLogs.getState().lines).toHaveLength(2)
    })
    const [a, b] = useTerminalLogs.getState().lines
    expect(a?.segs[0]?.color).toBe('#F18C96')
    expect(a?.stream).toBe('stderr')
    expect(a?.animate).toBe(true)
    expect(b?.text).toBe('plain')
    expect(b?.segs).toEqual([{ text: 'plain' }])
  })

  it('clear 复位 store 且后续写入正常', async () => {
    useTerminalLogs.getState().appendLine('before')
    await vi.waitFor(() => {
      expect(useTerminalLogs.getState().lines).toHaveLength(1)
    })
    useTerminalLogs.getState().clear()
    expect(useTerminalLogs.getState().lines).toHaveLength(0)
    useTerminalLogs.getState().appendLine('after')
    await vi.waitFor(() => {
      expect(useTerminalLogs.getState().lines).toHaveLength(1)
    })
    expect(useTerminalLogs.getState().lines[0]?.text).toBe('after')
  })

  it('setWrapGeometry 透传引擎：收窄后 append 的长行按新预算入库', async () => {
    useTerminalLogs.getState().setWrapGeometry({ availablePx: 20 * 6.6 + 4, fontSize: 12, fontFamily: 'Consolas' })
    useTerminalLogs.getState().appendLine('e'.repeat(50))
    await vi.waitFor(() => {
      expect(useTerminalLogs.getState().lines).toHaveLength(3)
    })
    expect(useTerminalLogs.getState().lines.map((l) => l.text)).toEqual([
      'e'.repeat(20),
      'e'.repeat(20),
      'e'.repeat(10),
    ])
  })

  it('flood 限流：超 60 行/秒进入 flood 模式并禁用新行动画', async () => {
    for (let i = 0; i < 130; i++) {
      useTerminalLogs.getState().appendLine(`line-${i}`)
    }
    await vi.waitFor(
      () => {
        expect(useTerminalLogs.getState().floodMode).toBe(true)
        expect(useTerminalLogs.getState().lines).toHaveLength(130)
      },
      { timeout: 5000 },
    )
    const last = useTerminalLogs.getState().lines[129]
    expect(last?.animate).toBe(false)
    expect(last?.text).toBe('line-129')
  })
})

describe('折行 advance 模型与预算（像素折行纯函数）', () => {
  // 默认布局：800 窗宽推导 589px（无滚动条预留口径的旧值，验算减法本身）
  const DEFAULT_PX = 589

  it('窄字符 advance：字体表命中 0.55em，大小写/逗号列表首项不敏感', () => {
    expect(narrowAdvancePx(12, 'Consolas')).toBeCloseTo(6.6, 10)
    expect(narrowAdvancePx(12, 'consolas')).toBeCloseTo(6.6, 10)
    expect(narrowAdvancePx(12, 'Cascadia Mono, Consolas')).toBeCloseTo(narrowAdvancePx(12, 'cascadia mono'), 10)
  })

  it('未收录字体按 0.6em 保守回退（宁可早折行也不溢出）', () => {
    expect(narrowAdvancePx(12, 'Some Unknown Mono')).toBeCloseTo(7.2, 10)
  })

  it('宽字符（CJK/全角）advance 恒 1.0em，与字体无关', () => {
    expect(wideAdvancePx(12)).toBe(12)
    expect(wideAdvancePx(24)).toBe(24)
  })

  it('字号增大 advance 等比放大', () => {
    expect(narrowAdvancePx(24, 'Consolas')).toBeCloseTo(13.2, 10)
  })

  it('wrapBudgetPx = 可用宽 − 安全余量 4', () => {
    expect(wrapBudgetPx({ availablePx: DEFAULT_PX, fontSize: 12, fontFamily: 'Consolas' })).toBeCloseTo(585, 10)
  })

  it('极端窄窗/非法输入钳制到 MIN_COLS 窄字符宽下限', () => {
    const floor = MIN_COLS * 6.6
    expect(wrapBudgetPx({ availablePx: 30, fontSize: 12, fontFamily: 'Consolas' })).toBeCloseTo(floor, 10)
    expect(wrapBudgetPx({ availablePx: 0, fontSize: 12, fontFamily: 'Consolas' })).toBeCloseTo(floor, 10)
    expect(wrapBudgetPx({ availablePx: NaN, fontSize: 12, fontFamily: 'Consolas' })).toBeCloseTo(floor, 10)
    expect(wrapBudgetPx({ availablePx: DEFAULT_PX, fontSize: 0, fontFamily: 'Consolas' })).toBeCloseTo(floor, 10)
  })
})

describe('classifyLogLevel（dt §1.E 行级语义分级）', () => {
  it('错误 / 警告 / 提示 / 默认 四级', () => {
    expect(classifyLogLevel('发生错误: x')).toBe('error')
    expect(classifyLogLevel('ERROR boom')).toBe('error')
    expect(classifyLogLevel('WARNING: deprecated')).toBe('warning')
    expect(classifyLogLevel('Info: ready')).toBe('info')
    expect(classifyLogLevel('just a log')).toBe('default')
  })
})
