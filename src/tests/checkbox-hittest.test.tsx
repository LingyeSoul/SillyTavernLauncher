/**
 * Checkbox 命中测试契约（BUG-S1 同机制回归）：
 * GPUIX 命中测试解析到最深可命中盒子——填充型 div 会吞掉点击且事件不冒泡到根
 * 节点 onClick（text/svg 会被跳过，div 盒子不会，见 Switch.tsx 头注释）。
 * Checkbox 选中态的 16×16 ember 盒正是填充盒：修复前点击勾选盒 onChange 不触发
 * （仅标签/间隙区可点）。本用例经 nativeSimulateClick 走真实命中链路，验证
 * 选中/未选中两态的盒区均可点。点击坐标由根 bounds 推算（盒 = 行首 16×16、
 * 垂直居中），不依赖组件内部结构。
 */
import { describe, expect, it } from 'vitest'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRoot } from '@gpuix/react/testing'
import { Checkbox } from '../ui/components/Checkbox'
import { ThemeProvider } from '../ui/theme'

let testRoot: TestRoot
const renderer = () => testRoot.renderer

async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  renderer().flush()
}

describe('Checkbox 命中测试（BUG-S1 同机制）', () => {
  it('点击勾选盒区域（未选中/选中两态）都应触发 onChange', async () => {
    testRoot = createTestRoot()
    const clicks: boolean[] = []

    // 未选中态：透明盒（无填充绘制）→ 点盒中心应触发 onChange(true)
    testRoot.root.render(
      <ThemeProvider>
        <Checkbox checked={false} onChange={(v) => clicks.push(v)} label="测试标签" testId="cb-unchecked" />
      </ThemeProvider>,
    )
    await settle()
    let rb = renderer().getElementBounds(renderer().findByTestId('cb-unchecked')!.id)!
    renderer().nativeSimulateClick(rb.x + 8, rb.y + rb.height / 2)
    await settle()
    expect(clicks, '未选中态点盒应触发 onChange').toEqual([true])

    // 选中态：ember 填充盒——修复前吞点击，此处不触发（BUG-S1 同机制）
    testRoot.root.render(
      <ThemeProvider>
        <Checkbox checked={true} onChange={(v) => clicks.push(v)} label="测试标签" testId="cb-checked" />
      </ThemeProvider>,
    )
    await settle()
    rb = renderer().getElementBounds(renderer().findByTestId('cb-checked')!.id)!
    renderer().nativeSimulateClick(rb.x + 8, rb.y + rb.height / 2)
    await settle()
    expect(clicks, '选中态点盒应触发 onChange（填充盒不吃点击）').toEqual([true, false])
  }, 10_000)
})
