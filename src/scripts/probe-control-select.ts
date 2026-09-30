/**
 * 探针（2026-09-30 拖拽误选 RCA 的补充取证，结论存档）：
 * offscreen 台架内 virtual-list 里的文本按下扫选恒 null（C1 新鲜状态亦然），
 * 真窗同手势正常选中（e2e 探针 P0）——offscreen/live 在 virtual-list 文本选择
 * 注册上的分歧（同程序化滚动 vr 事件前科）。后果：复制特性的对照断言只能在
 * e2e 做（terminal-scrollbar.test.ts 链路 4 对照腿），scrollBar.test.tsx 的
 * DEVIATION 注释引用本脚本。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRoot } from '@gpuix/react/testing'

async function main(): Promise<void> {
  const originalCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'stl-repro-ctl-'))
  process.chdir(tempDir)
  let testRoot: TestRoot | undefined
  try {
    const [{ ThemeProvider }, { TooltipProvider }, { TerminalView }, logs] = await Promise.all([
      import('../ui/theme'),
      import('../ui/components/Tooltip'),
      import('../ui/views/TerminalView'),
      import('../stores/terminalLogs'),
    ])
    const { getConfigStore } = await import('../services/configStore')
    getConfigStore().set('motionEnabled', false)
    logs.__resetTerminalLogsForTests()

    testRoot = createTestRoot({ width: 800, height: 644 })
    const renderer = testRoot.renderer
    const settle = async (ms = 50): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      renderer.flush()
      renderer.dispatchNativeEvents()
    }

    logs.useTerminalLogs.getState().appendBatch(
      Array.from({ length: 400 }, (_, i) => ({ text: `sel-test-${i}` })),
    )
    renderer.flush()
    testRoot.root.render(
      h(ThemeProvider, null, h(TooltipProvider, null,
        h('div', { style: { width: 800, height: 644, display: 'flex', flexDirection: 'column' } }, h(TerminalView, null)))),
    )
    await settle(100)

    const card = () => renderer.findByTestId('terminal-log-card')!
    const cardB = () => renderer.getElementBounds(card().id)!
    const center = (): [number, number] => [cardB().x + 100, cardB().y + cardB().height * 0.5]
    const painted = () => renderer.getPaintedText().slice(-3)

    // C1: 新鲜状态直接扫
    renderer.clearSelection()
    const c1 = renderer.dragSelect(center()[0], center()[1], center()[0] + 200, center()[1])
    console.log(`[C1] 新鲜状态卡片中心扫选: ${c1 ? `✅ "${c1.slice(0, 40)}"` : '❌ null'}；painted尾=${JSON.stringify(painted())}`)

    // C2: thumb 拖拽（同单测零选区段）后再扫
    const thumb = renderer.findByTestId('terminal-scrollbar-thumb')!
    const mb = renderer.getElementBounds(thumb.id)!
    const grabX = mb.x + mb.width / 2
    const grabY = mb.y + mb.height / 2
    renderer.clearSelection()
    renderer.nativeSimulateMouseDown(grabX, grabY)
    for (let i = 1; i <= 6; i++) {
      renderer.nativeSimulateMouseMove(grabX - i * 25, grabY - i * 8, 0)
      renderer.flush()
      renderer.dispatchNativeEvents()
    }
    renderer.nativeSimulateMouseUp(grabX - 150, grabY - 48)
    renderer.flush()
    renderer.dispatchNativeEvents()
    await settle()
    console.log(`[C2.零选区] thumb 拖拽后 getSelectedText=${renderer.getSelectedText() ?? 'null'} ✅`)
    renderer.clearSelection()
    const c2 = renderer.dragSelect(center()[0], center()[1], center()[0] + 200, center()[1])
    console.log(`[C2] 拖拽后卡片中心扫选: ${c2 ? `✅ "${c2.slice(0, 40)}"` : '❌ null'}；painted尾=${JSON.stringify(painted())}`)
  } finally {
    testRoot?.unmount()
    process.chdir(originalCwd)
    process.on('exit', () => {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // %TEMP% 残留可接受
      }
    })
  }
}

void main()
