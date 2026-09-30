/**
 * 取证脚本：终端折行末字符 ↔ 右侧视觉边界 的实际间距（2026-09-30 报障 RCA）。
 *
 * 真窗量化（live 渲染器，DWM 缩放边/字体栅格化都真实在场；offscreen 台架量不出
 * 这些）：
 * - 窗口/日志卡/滚动条轨道的 bounds → 推"文本可用宽"与"右侧死区"分解
 * - 已知内容长行（app.tsx STL_SEED_WRAP_LINES：纯 ASCII/纯 CJK/混合）的折行段
 *   实际宽度 → 反推每字符真实 advance，对照 terminalEngine 的 advance 估算表
 *
 * 行定位走"text 节点 → 父级行盒"（LogRow 行盒无 testId，text 段是行盒直接子节点）。
 * 用法：bun scripts/probe-wrap-width.ts（自动起真窗，播种在挂载 1.5s 后落地）
 */
import { launchE2E, sleep } from '../tests/e2e/helpers'
import type { E2ESession } from '../tests/e2e/helpers'
import type { ElementBounds, TreeNode } from '@gpuix/react/automation'

function walk(node: TreeNode, visit: (n: TreeNode, ancestors: TreeNode[]) => void, ancestors: TreeNode[] = []): void {
  visit(node, ancestors)
  for (const c of node.children ?? []) walk(c, visit, [...ancestors, node])
}

/** 从命中文本节点向上找行盒：第一个非 text 祖先（内层文本 run 与外层 <text>
 *  元素都是 type='text'，逐级上爬到行盒 div） */
function rowBoxOf(ancestors: TreeNode[]): TreeNode | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]!
    if (a.type !== 'text') return a
  }
  return null
}

/** 播种折行行的判定：WRAP 头段、A 续行（纯数字）、C/M 续行（中文开头）、M 含 installing、
 *  短种子行 seed-log-0/59（验列表左内缩：0 在头部可能未绘制，59 在尾部可见） */
function isWrapRow(text: string): boolean {
  if (text.startsWith('WRAP')) return true
  if (/^seed-log-(0|59)$/.test(text)) return true
  if (/^[0-9]+$/.test(text)) return true
  if (/^[\u4e00-\u9fa5]/.test(text)) return true
  return text.includes('installing')
}

async function main(): Promise<void> {
  let session: E2ESession | null = null
  try {
    session = await launchE2E({
      setupCompleted: true,
      env: { STL_SEED_TERMINAL_LINES: '60', STL_SEED_WRAP_LINES: '1' },
    })
    const app = session.app
    await app.getByTestId('terminal-scrollbar-thumb').waitFor({ timeoutMs: 10_000 })
    // 播种在挂载后 1.5s 落地（见 app.tsx STL_SEED_WRAP_LINES），等行入库 + 渲染
    await sleep(3_000)

    const init = await app.call('initialize', { protocolVersion: 1, client: 'stl-probe-wrap' })
    console.log(`窗口尺寸（协议上报）: ${init.window.width} x ${init.window.height}`)

    const tree = (await app.call('getTree', {})).tree
    if (!tree) throw new Error('getTree 返回空')

    let card: TreeNode | null = null
    let track: TreeNode | null = null
    /** 命中播种行的 (行盒节点, 行文本) 列表：text 段的直接父级即行盒 */
    const rows: Array<{ node: TreeNode; text: string }> = []
    const seen = new Set<number>()
    walk(tree, (n, ancestors) => {
      if (n.testId === 'terminal-log-card') card = n
      else if (n.testId === 'terminal-scrollbar') track = n
      else if (n.type === 'text' && typeof n.text === 'string' && isWrapRow(n.text)) {
        const box = rowBoxOf(ancestors)
        if (box && !seen.has(box.id)) {
          seen.add(box.id)
          rows.push({ node: box, text: n.text })
        }
      }
    })

    const boundsOf = async (n: TreeNode): Promise<ElementBounds | null> => {
      const b = n.bounds ?? (await app.call('getBounds', { elementId: n.id })).bounds
      return b
    }

    const cardB = (await boundsOf(card!))!
    const trackB = (await boundsOf(track!))!
    console.log(`日志卡: x=${cardB.x} w=${cardB.width}（外右缘 ${cardB.x + cardB.width}）`)
    console.log(`轨道: x=${trackB.x} w=${trackB.width}`)

    // 文本可用宽口径：轨道左缘 − 列表 paddingRight 8 ↔ 卡内左缘 + 边框1 + 列表 paddingLeft 8
    const textLeft = cardB.x + 1 + 8
    const textRight = trackB.x - 8
    console.log(`文本可用区（实测）: [${textLeft}, ${textRight}] 宽 ${textRight - textLeft}px`)
    console.log(`（口径估算 terminalTextWidthPx(800)=573；死区分解：列表右 padding 8 + 轨道 ${trackB.width}）`)
    console.log('---')

    for (const { node, text } of rows) {
      const b = await boundsOf(node)
      // 滚出视口的行不被绘制（virtual-list 只画可视区），跳过
      if (!b) {
        console.log(`「${text.slice(0, 14)}…」 行盒未绘制（滚出视口），跳过`)
        continue
      }
      const chars = [...text]
      const cjk = chars.filter((c) => /[\u4e00-\u9fa5]/.test(c)).length
      const ascii = chars.length - cjk
      const textW = b.width - 2 // 行盒 padding 1×2
      const gapToTextRight = textRight - (b.x + b.width - 1) // 末字符右缘 ↔ 文本区右缘
      const gapToTrack = trackB.x - (b.x + b.width - 1) // 末字符右缘 ↔ 轨道左缘
      const perChar = chars.length > 0 ? textW / chars.length : 0
      console.log(
        `「${text.slice(0, 14)}${text.length > 14 ? '…' : ''}」 len=${chars.length}(CJK${cjk}/A${ascii})` +
          ` x=${b.x.toFixed(1)} 行宽=${b.width} 文本宽=${textW.toFixed(1)} 每字符=${perChar.toFixed(3)}px` +
          ` 距文本区右缘=${gapToTextRight.toFixed(1)}px 距轨道=${gapToTrack.toFixed(1)}px`,
      )
    }
  } finally {
    await session?.cleanup()
  }
}

await main()
