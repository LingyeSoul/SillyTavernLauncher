/**
 * flex 行内 <text> 收缩契约（ExtensionsView 标题行模式）：
 * AGENTS 规则 8 处方是 flexGrow:1 + minWidth:0 + whiteSpace:'normal'（ControlLabel
 * 标签独占伸展场景）；但卡片标题行（名称 + 相邻版本号）不希望 flexGrow 把兄弟
 * 项推到行尾。本用例实证：minWidth:0（无 flexGrow）同样解锁收缩折行——行超宽时
 * 长文本收缩换行、定宽行不溢出、兄弟项保持可见。
 */
import { describe, expect, it } from 'vitest'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRoot } from '@gpuix/react/testing'

let testRoot: TestRoot
const renderer = () => testRoot.renderer

async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  renderer().flush()
}

/** 超长无空格文案（模拟第三方 manifest displayName） */
const LONG_NAME = '超长扩展名称这是第三方清单里的显示名'.repeat(12)

describe('flex 行内 text 收缩（minWidth:0 无 flexGrow）', () => {
  it('长文本收缩折行：行不溢出、文本不越界、兄弟项可见', async () => {
    testRoot = createTestRoot()
    testRoot.root.render(
      <div style={{ width: 200, display: 'flex', flexDirection: 'row', alignItems: 'baseline', gap: 8 }} testId="row">
        <text style={{ fontSize: 13, minWidth: 0, whiteSpace: 'normal' }} testId="long-name">
          {LONG_NAME}
        </text>
        <text style={{ fontSize: 11 }} testId="ver">
          v9.9.9
        </text>
      </div>,
    )
    await settle()

    const row = renderer().getElementBounds(renderer().findByTestId('row')!.id)!
    const name = renderer().getElementBounds(renderer().findByTestId('long-name')!.id)!
    const ver = renderer().getElementBounds(renderer().findByTestId('ver')!.id)!

    // 定宽行不被撑爆（长文本收缩生效）
    expect(row.width, '行宽须保持 200（不被内容撑爆）').toBeLessThanOrEqual(201)
    // 长文本在行内折行（高度 > 单行 13px 字号的一行高，即发生换行）
    expect(name.height, '长文本应折行（高度增长）').toBeGreaterThan(18)
    expect(name.width, '折行后文本宽不越行').toBeLessThanOrEqual(row.width + 1)
    // 兄弟项仍完整落在行内（未被推出可视区）
    expect(ver.x + ver.width, '版本号右缘不越行').toBeLessThanOrEqual(row.x + row.width + 1)
  }, 10_000)
})
