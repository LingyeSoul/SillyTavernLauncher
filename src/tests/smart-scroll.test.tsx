/**
 * SmartScrollArea 组件契约（定高用例，不依赖整窗应用）：
 * - 内容装得下 → 非滚动容器（getScrollOffset 为 null，滚轮无效）
 * - 内容超高 → 滚动容器（[0,0]，滚轮生效）
 * - contentKey 变化内容长高/变矮 → 500ms 看门狗自愈翻向
 * - 超高翻回装得下时残留偏移被 scrollTo(0,0) 清零（越界偏移破坏绘制的教训）
 * 独立 createTestRoot：offscreen 根按屏幕高布局（请求尺寸不生效），整窗 smoke
 * 只断言"装得下"分枝，超高分枝在此定高覆盖。
 */
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRoot } from '@gpuix/react/testing'
import { SmartScrollArea } from '../ui/components/SmartScroll'

let testRoot: TestRoot
const renderer = () => testRoot.renderer

async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  renderer().flush()
}

/** 20px 行 × n：内容高度 = 20n（无 margin） */
function Rows({ n }: { n: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} testId={`row-${i}`} style={{ height: 20, flexShrink: 0 }} />
      ))}
    </>
  )
}

/** 受控内容量（contentKey 联动），外层 260 定高钳住 SmartScrollArea */
function Harness({ rows }: { rows: number }) {
  return (
    <div style={{ height: 260, display: 'flex', flexDirection: 'column' }}>
      <SmartScrollArea contentKey={rows} testId="area">
        <Rows n={rows} />
      </SmartScrollArea>
    </div>
  )
}

/** 等 SmartScrollArea 的 500ms 看门狗完成一轮重测 */
async function settleWatchdog(): Promise<void> {
  for (let i = 0; i < 8; i++) await settle(120)
}

describe('SmartScrollArea 契约', () => {
  it('内容装得下 → 非滚动容器；超高 → 滚动容器且滚轮生效', async () => {
    testRoot = createTestRoot()
    // 260 视口 - 上下 padY 40 = 220 可用：5 行 100px 装得下
    testRoot.root.render(<Harness rows={5} />)
    await settleWatchdog()
    let area = renderer().findByTestId('area')!
    expect(renderer().getScrollOffset(area.id), '装得下 → 非滚动容器').toBeNull()

    // 20 行 400px > 220 → 滚动容器；滚轮下压应产生负偏移
    testRoot.root.render(<Harness rows={20} />)
    await settleWatchdog()
    area = renderer().findByTestId('area')!
    expect(renderer().getScrollOffset(area.id), '超高 → 滚动容器').toEqual([0, 0])
    const b = renderer().getElementBounds(area.id)!
    renderer().nativeSimulateScrollWheel(b.x + b.width / 2, b.y + b.height / 2, 0, -120)
    await settle()
    const offset = renderer().getScrollOffset(area.id)
    expect(offset![1], '超高时滚轮应滚动内容').toBeLessThan(0)
  }, 20_000)

  it('超高 → 变矮：残留偏移清零并翻回非滚动容器（自愈）', async () => {
    testRoot = createTestRoot()
    testRoot.root.render(<Harness rows={20} />)
    await settleWatchdog()
    const area = renderer().findByTestId('area')!
    expect(renderer().getScrollOffset(area.id), '前置：超高为滚动容器').toEqual([0, 0])

    // 滚出一段偏移，再切回 5 行：翻 'hidden' 前应 scrollTo(0,0) 清残留
    renderer().scrollTo(area.id, 0, -100)
    await settle()
    testRoot.root.render(<Harness rows={5} />)
    await settleWatchdog()
    const area2 = renderer().findByTestId('area')!
    expect(renderer().getScrollOffset(area2.id), '变矮后翻回非滚动容器').toBeNull()
    // 内容未被裁剪：第 5 行可见（bounds 在视口内）
    const row = renderer().findByTestId('row-4')!
    const rb = renderer().getElementBounds(row.id)!
    expect(rb.y).toBeGreaterThanOrEqual(0)
    expect(rb.y + rb.height).toBeLessThanOrEqual(260)
  }, 20_000)
})
