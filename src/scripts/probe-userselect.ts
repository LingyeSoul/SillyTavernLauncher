/**
 * 探针脚本（2026-09-30 拖拽误选缺陷 RCA 取证，结论存档）。
 *
 * 最终结论（offscreen TerminalView 台架二分 + 真窗 e2e 探针双重实证）：
 *  1. 原生文本选择的锚点在 mouseDown 即武装——与按下点落在什么元素无关；
 *     拖动路径扫过可选文本（userSelect≠none）即成选区，释放点无关。
 *  2. 例外：按下触发 scrollToItem 跳转（thumb 外轨道点击）时，手势中的内容
 *     位移会意外抑制选择（T2/T3 + 真窗 P6）——此前 e2e 探针 P1/P2 按 0.8 轨高
 *     恰好全走此路径，漏测了用户真实形态。
 *  3. 用户报障形态 = thumb 命中区按下（无跳转）+ 拖动扫过日志行 = 选中
 *     （T1/T4 + 真窗 P5 复现）。
 *  4. userSelect:'none' 可继承豁免子树（S5/S6）；镜像源列表行自带豁免故免疫。
 *  5. offscreen 台架局限：virtual-list 内的文本按下扫选恒 null（C 组），
 *     真窗正常（P0）——复制特性对照只能在 e2e 断言（terminal-scrollbar 链路 4）。
 *
 * 修复：ScrollBar 拖拽会话逐 move clearSelection + 轨道可见化加宽（16px 常显
 * 底色）。回归锁：scrollBar.test.tsx 零选区用例 + terminal-scrollbar.test.ts 链路 4。
 *
 * 本脚本保留 T1-T4 二分矩阵作"harness 判定不了全部真窗链路"的对照证据
 * （AGENTS.md 口径，同 repro-scroll-thumb-drag.ts）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRoot } from '@gpuix/react/testing'

async function main(): Promise<void> {
  const originalCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'stl-repro-sel-'))
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
      h(
        ThemeProvider,
        null,
        h(
          TooltipProvider,
          null,
          h(
            'div',
            { style: { width: 800, height: 644, display: 'flex', flexDirection: 'column' } },
            h(TerminalView, null),
          ),
        ),
      ),
    )
    await settle(100)

    const track = () => renderer.findByTestId('terminal-scrollbar')!
    const thumb = () => renderer.findByTestId('terminal-scrollbar-thumb')!
    const tb = renderer.getElementBounds(track().id)!
    const mb = renderer.getElementBounds(thumb().id)!
    const row = renderer.findByText('sel-test-390')
    const rowB = row ? renderer.getElementBounds(row.id) : null
    console.log(
      `[几何] 轨道 y=${tb.y.toFixed(0)} h=${tb.height.toFixed(0)} x=${tb.x.toFixed(0)} w=${tb.width.toFixed(0)}；thumb y=${mb.y.toFixed(0)} h=${mb.height.toFixed(0)}；sel-test-390 bounds=${rowB ? `y=${rowB.y.toFixed(0)} x=${rowB.x.toFixed(0)} h=${rowB.height.toFixed(0)}` : 'null'}`,
    )

    // 窗口内文本区定点（列表卡中部，不依赖子树 bounds）
    const inWinText: [number, number] = [tb.x - 200, tb.y + tb.height * 0.5]
    const trackAboveThumb: [number, number] = [tb.x + tb.width / 2, tb.y + tb.height * 0.8]
    const thumbCenter: [number, number] = [mb.x + mb.width / 2, mb.y + mb.height / 2]

    type Case = { name: string; press: [number, number]; target: [number, number] }
    const cases: Case[] = [
      { name: 'T1 thumb 内按下（无跳转）→ 窗内文本点', press: thumbCenter, target: inWinText },
      { name: 'T2 thumb 外按下（跳转路径）→ 窗内文本点', press: trackAboveThumb, target: inWinText },
      {
        name: 'T3 thumb 外按下 → 子树 bounds 终点（内容坐标复现单测失败形态）',
        press: trackAboveThumb,
        target: rowB ? [rowB.x + 40, rowB.y + rowB.height / 2] : inWinText,
      },
      { name: 'T4 thumb 内按下 → 子树 bounds 终点', press: thumbCenter, target: rowB ? [rowB.x + 40, rowB.y + rowB.height / 2] : inWinText },
    ]
    for (const c of cases) {
      renderer.clearSelection()
      await settle(30)
      const sel = renderer.dragSelect(c.press[0], c.press[1], c.target[0], c.target[1])
      console.log(
        `${sel ? '❌ 选中' : '✅ 未选中'}  ${c.name}${sel ? `  → "${sel.slice(0, 60).replace(/\n/g, '⏎')}"` : ''}`,
      )
      await settle(30)
    }
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
