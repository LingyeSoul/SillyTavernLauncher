/**
 * E2E：终端折行填充契约（2026-09-30"折行末字符距右边界过大"修复的回归锁）。
 *
 * 根因与修复（scripts/probe-wrap-width.ts 真窗取证 + services/terminalEngine
 * 文件头"像素折行"）：
 * 1. 旧折行走 xterm 整数列模型（CJK=2 列 × 窄字符 advance 当预算），CJK 字形
 *    实际 advance ≈1em，列预算高估 ~10%——纯中文满行段距右缘 66px。修复 =
 *    引擎像素折行（窄字按字体 advance 表、宽字按 1em 逐字符累计）。
 * 2. virtual-list 自身的 paddingLeft/Right 不内缩子项（真窗实证行盒 x=列表左
 *    缘），公式扣的 16px 全变右侧死区。修复 = TerminalView 包一层真实 padding
 *    的 wrapper，口径（LIST_PADDING_X_PX=16）物理对齐。
 *
 * 断言（真窗，字体栅格化/DPI 分数布局真实在场；offscreen 量不出这些）：
 * - 满行折行段（ASCII/CJK/混合）末字符右缘距滚动条轨道 ≤ 一字宽 + 安全余量
 *   （修复前 ASCII 22px / CJK 74px）；
 * - 不得反向溢出（距轨道 ≥ −1px，末字符被裁剪比留白伤害大）；
 * - 行盒左内缩 8px 真实生效（wrapper 修复锁）。
 * 播种行由 app.tsx STL_SEED_WRAP_LINES 延迟灌入（须在 setWrapGeometry 校准后）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { launchE2E, SHOTS_DIR, sleep } from './helpers'
import type { E2ESession } from './helpers'
import type { TreeNode } from '@gpuix/react/automation'

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

function walk(node: TreeNode, visit: (n: TreeNode, ancestors: TreeNode[]) => void, ancestors: TreeNode[] = []): void {
  visit(node, ancestors)
  for (const c of node.children ?? []) walk(c, visit, [...ancestors, node])
}

/** 从命中文本节点向上找行盒（内层 run 与外层 <text> 元素都是 type='text'） */
function rowBoxOf(ancestors: TreeNode[]): TreeNode | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]!
    if (a.type !== 'text') return a
  }
  return null
}

describe('终端折行填充（真窗口）', () => {
  it('满行折行段末字符贴右边界：ASCII/CJK/混合 ≤ 一字宽余量，无溢出，左内缩 8px', async () => {
    session = await launchE2E({
      setupCompleted: true,
      env: { STL_SEED_TERMINAL_LINES: '60', STL_SEED_WRAP_LINES: '1' },
    })
    const app = session.app
    await app.getByTestId('terminal-scrollbar-thumb').waitFor({ timeoutMs: 10_000 })
    // 播种在挂载后 1.5s 落地（app.tsx STL_SEED_WRAP_LINES），等折行段入库 + 绘制
    await sleep(3_000)

    const tree = (await app.call('getTree', {})).tree
    expect(tree, 'getTree 应返回树').toBeTruthy()

    let card: TreeNode | null = null
    let track: TreeNode | null = null
    const rows: Array<{ node: TreeNode; text: string }> = []
    const seen = new Set<number>()
    /** 播种折行段判定：WRAP 头段、A 续段（纯数字）、C/M 续段（中文开头） */
    const isWrapSeg = (text: string): boolean =>
      text.startsWith('WRAP') || /^[0-9]+$/.test(text) || /^[\u4e00-\u9fa5]/.test(text)
    walk(tree!, (n, ancestors) => {
      if (n.testId === 'terminal-log-card') card = n
      else if (n.testId === 'terminal-scrollbar') track = n
      else if (n.type === 'text' && typeof n.text === 'string' && isWrapSeg(n.text)) {
        const box = rowBoxOf(ancestors)
        if (box && !seen.has(box.id)) {
          seen.add(box.id)
          rows.push({ node: box, text: n.text })
        }
      }
    })
    expect(track, '滚动条轨道应存在').toBeTruthy()

    const boundsOf = async (n: TreeNode) => {
      const b = n.bounds ?? (await app.call('getBounds', { elementId: n.id })).bounds
      expect(b, `节点 ${n.testId ?? n.type} 应有 bounds`).toBeTruthy()
      return b!
    }
    const trackB = await boundsOf(track!)

    /** 满行折行段末字符右缘距轨道左缘（正 = 留白，负 = 溢出） */
    const gapToTrack = async (node: TreeNode): Promise<number> => {
      const b = await boundsOf(node)
      return trackB.x - (b.x + b.width - 1)
    }

    const asciiFull = rows.filter((r) => /^[0-9]+$/.test(r.text) && r.text.length >= 80)
    const cjkFull = rows.filter((r) => /^[\u4e00-\u9fa5]+$/.test(r.text) && [...r.text].length >= 40)
    const mixedFull = rows.filter((r) => r.text.startsWith('WRAP'))

    // ASCII 满行段：一字宽（≈6.6px）+ 内缩 8 + 安全 4 + DPI 余量 → ≤ 20
    expect(asciiFull.length, '应存在 ASCII 满行折行段（播种 307 字符行）').toBeGreaterThanOrEqual(2)
    for (const r of asciiFull) {
      const gap = await gapToTrack(r.node)
      expect(gap, `ASCII 满行段距轨道应 ≤20px（「${r.text.slice(0, 10)}…」got ${gap.toFixed(1)}）`).toBeLessThanOrEqual(20)
      expect(gap, '末字符不得溢出轨道（≥ −1px）').toBeGreaterThanOrEqual(-1)
    }

    // CJK 满行段：一字宽（≈12px）+ 内缩 8 + 安全 4 + DPI 余量 → ≤ 24（修复前 74）
    expect(cjkFull.length, '应存在 CJK 满行折行段（播种纯中文长行）').toBeGreaterThanOrEqual(2)
    for (const r of cjkFull) {
      const gap = await gapToTrack(r.node)
      expect(gap, `CJK 满行段距轨道应 ≤24px（修复前 74px；got ${gap.toFixed(1)}）`).toBeLessThanOrEqual(24)
      expect(gap, '末字符不得溢出轨道（≥ −1px）').toBeGreaterThanOrEqual(-1)
    }

    // 混合段（WRAPM 头段非末段）
    expect(mixedFull.length).toBeGreaterThanOrEqual(3)
    for (const r of mixedFull) {
      const gap = await gapToTrack(r.node)
      expect(gap, `混合段距轨道应 ≤24px（got ${gap.toFixed(1)}）`).toBeLessThanOrEqual(24)
      expect(gap, '末字符不得溢出轨道（≥ −1px）').toBeGreaterThanOrEqual(-1)
    }

    // 行盒左内缩：wrapper padding 8 真实生效（行盒 x = 卡内左缘 + 1 边框 + 8）
    const cardB = await boundsOf(card!)
    const probeRow = rows.find((r) => r.text.startsWith('WRAP'))!
    const probeB = await boundsOf(probeRow.node)
    expect(
      Math.abs(probeB.x - (cardB.x + 1 + 8)),
      `行盒左内缩应为 8px（x=${probeB.x.toFixed(1)}，期望 ≈${cardB.x + 9}）`,
    ).toBeLessThanOrEqual(1.5)

    // 视觉审计留档（gitignore 目录，人工/图像模型抽查用）
    await app.screenshot({ path: join(SHOTS_DIR, 'terminal-wrap-fill.png') })
  }, 120_000)
})
