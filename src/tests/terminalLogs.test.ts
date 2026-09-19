/**
 * terminalLogs ANSI 解析测试（Bug#12：CSI 终结符全集 + SGR 39/49）。
 */
import { describe, expect, it } from 'vitest'
import { parseAnsiSegments } from '../stores/terminalLogs'

describe('parseAnsiSegments（← parse_ansi_text）', () => {
  it('SGR 颜色码分段 + 0 重置', () => {
    const segs = parseAnsiSegments('\x1b[31m错误\x1b[0m 普通')
    expect(segs).toEqual([
      { text: '错误', color: '#F18C96' },
      { text: ' 普通' },
    ])
  })

  it('非 SGR CSI 全终结符剔除（含 ?25h/?25l 私有模式，修复泄漏乱码）', () => {
    const text = '\x1b[?25l光标隐藏\x1b[?25h\x1b[2J\x1b[1;1H\x1b[G\x1b[10d清屏'
    expect(parseAnsiSegments(text)).toEqual([{ text: '光标隐藏清屏' }])
  })

  it('SGR 终结符 m 不被 CSI 剔除误伤', () => {
    const segs = parseAnsiSegments('\x1b[31m红\x1b[m默认')
    expect(segs).toEqual([
      { text: '红', color: '#F18C96' },
      { text: '默认' },
    ])
  })

  it('39 恢复默认前景色', () => {
    const segs = parseAnsiSegments('\x1b[31m红\x1b[39m默认')
    expect(segs).toEqual([
      { text: '红', color: '#F18C96' },
      { text: '默认' },
    ])
  })

  it('49（背景默认）不改变已建模的前景色', () => {
    const segs = parseAnsiSegments('\x1b[32m绿\x1b[49m仍绿')
    expect(segs[0]?.color).toBe('#89C5A2')
    expect(segs[1]?.color).toBe('#89C5A2')
  })

  it('复合 SGR 取最后一个被识别的颜色码（DEVIATION 保持）', () => {
    expect(parseAnsiSegments('\x1b[1;32mok')[0]?.color).toBe('#89C5A2')
  })

  it('空文本 → 空段数组', () => {
    expect(parseAnsiSegments('')).toEqual([])
  })
})
