/**
 * 复现脚本：拖拽终端滚动条时 thumb 是否跟随（2026-09-30 缺陷取证）。
 *
 * 结论存档：本 offscreen 台架内 thumb 始终正常跟随（缺陷仅在 live 真窗路径：
 * live 渲染器对程序化 scrollToItem 不发 onVisibleRange 事件，offscreen 却即时
 * 连发——详见 tests/e2e/terminal-scrollbar.test.ts 与 TerminalView 锚点数据流
 * 注释）。保留本脚本作"harness 判定不了真窗链路"的对照证据（AGENTS.md 口径）。
 *
 * 与既有契约测试的差异＝真实感拖拽：多步 move（每步 20px）逐步读 thumb 位置。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRoot } from '@gpuix/react/testing'

async function main(): Promise<void> {
  const originalCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'stl-repro-thumb-'))
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
      Array.from({ length: 400 }, (_, i) => ({ text: `repro-drag-${i}` })),
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

    const track = () => renderer.findByTestId('terminal-scrollbar')
    const thumb = () => renderer.findByTestId('terminal-scrollbar-thumb')
    const list = () => renderer.findByTestId('terminal-log-list')
    const anchorOf = (): number => {
      const l = list()
      if (!l) return -1
      return renderer.getListScrollTop(l.id)?.[0] ?? -1
    }
    const thumbY = (): number => {
      const th = thumb()
      if (!th) return Number.NaN
      return renderer.getElementBounds(th.id)?.y ?? Number.NaN
    }

    const tb0 = renderer.getElementBounds(track()!.id)!
    console.log(`[基线] 轨道 y=${tb0.y.toFixed(1)} h=${tb0.height.toFixed(1)}；锚行=${anchorOf()}；thumbY=${thumbY().toFixed(1)}（尾部应贴底）`)

    // —— 真实感拖拽：按住 thumb（尾部），每步上移 20px，共 12 步 ——
    const startX = tb0.x + tb0.width / 2
    const startY = thumbY() + 8
    renderer.nativeSimulateMouseDown(startX, startY)
    console.log('\n[拖拽] step  anchor  thumbY')
    let lastY = startY
    for (let step = 1; step <= 12; step++) {
      lastY -= 20
      renderer.nativeSimulateMouseMove(startX, lastY, 0)
      console.log(`       ${String(step).padStart(2)}  ${String(anchorOf()).padStart(6)}  ${thumbY().toFixed(1).padStart(7)}`)
      await new Promise((r) => setTimeout(r, 16))
    }
    const finalY = thumbY()
    renderer.nativeSimulateMouseUp(startX, lastY)
    await settle(100)

    console.log(`\n[判定] 12 步后 thumbY=${finalY.toFixed(1)}（起点 ${startY.toFixed(1)}）；释后 anchor=${anchorOf()}`)
    const moved = Math.abs(finalY - startY) > 10
    console.log(moved ? '✅ offscreen 台架内 thumb 正常跟随（对照结论成立）' : '❌ offscreen 台架内 thumb 也卡死（与 2026-09-30 结论不符，请复核）')
    if (!moved) process.exitCode = 2
  } finally {
    testRoot?.unmount()
    process.chdir(originalCwd)
    // 删目录挂到自有的 exit 钩子：configStore 的 exit 保存（首次 import 时注册，
    // 绝对路径指向临时目录）必须先跑，删在它前面会 ENOENT 报噪音
    process.on('exit', () => {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // %TEMP% 残留一个目录可接受（_verifyLib 同口径）
      }
    })
  }
}

void main()
