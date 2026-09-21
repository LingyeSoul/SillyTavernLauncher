/**
 * 镜像源对话框真窗口几何/交互回归（2026-09-21 卡顿修复后的行盒缺陷回归）。
 *
 * 背景：列表改 `virtual-list` 窗口化后，行盒按内容宽排布（不像 flex 列容器那样拉伸
 * 子项）——实测各行 219–445px、列表内宽 564px，行底色与分隔线右缘参差成"阶梯"，
 * 被当成"选中高亮异常 + 选项宽度异常"上报。修复 = 行样式加 `width:'100%'`
 * （实测按边框盒解析，padding 不外溢；`alignSelf:'stretch'` 对列表子项无效）。
 *
 * 本用例在**真实窗口**上用自动化树断言相对几何（同一浮层内行间比较，规避
 * "anchored 子树 bounds 系统性偏移"的已知测量伪影），并落截图供人工/图像模型复核：
 *  - 已测速态（种子 github.speedtest）：行序按延迟升序、ms 与「推荐」芯片可见；
 *  - 各行等宽且等于列表容器宽（漏 width:'100%' 立即失败）；
 *  - 指针停在列表上滚轮滚动：至多一行带 hover 底色（悬停高亮不得累积）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { launchE2E, sleep, expectShotExists, SHOTS_DIR } from './helpers'
import type { E2ESession } from './helpers'

/** 种子测速结果：固定延迟值 → 行序与文案确定（快/中/慢三档各覆盖若干站） */
const SEED_RESULTS: Record<string, number> = {
  'gh.ddlc.top': 412,
  'github.dpik.top': 497,
  'ghp.keleyaa.com': 509,
  'github.boringhex.top': 513,
  'ghfile.geekertao.top': 522,
  'ghproxy.xzhouqd.com': 530,
  'gh.chalin.tk': 613,
  'ghm.078465.xyz': 620,
  'tvv.tw': 1068,
  'gh-proxy.com': 1200,
}

interface AuditNode {
  id: number
  type: string
  testId?: string
  style?: Record<string, unknown>
  bounds?: { x: number; y: number; width: number; height: number }
  children?: AuditNode[]
}

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

/** 打开镜像源设置对话框（设置页环境 tab 的入口） */
async function openMirrorDialog(s: E2ESession): Promise<void> {
  await s.app.getByTestId('nav-settings').click()
  await s.app.getByTestId('setting-mirror-open').waitFor({ timeoutMs: 10_000 })
  await s.app.getByTestId('setting-mirror-open').click()
  await s.app.getByTestId('mirror-list').waitFor({ timeoutMs: 10_000 })
}

/** 收集自动化树里的列表行节点（testId 前缀 mirror-row-） */
function collectRows(node: AuditNode, out: AuditNode[] = []): AuditNode[] {
  if (node.testId?.startsWith('mirror-row-')) out.push(node)
  for (const child of node.children ?? []) collectRows(child, out)
  return out
}

async function rowsWithBounds(s: E2ESession): Promise<AuditNode[]> {
  const { tree } = await s.app.call('getTree', {})
  if (!tree) throw new Error('getTree 返回空树')
  return collectRows(tree as AuditNode).filter((row) => row.bounds !== undefined)
}

/** 找某节点的父节点（自动化树只给 children，无 parentId） */
function findParentOf(node: AuditNode, id: number): AuditNode | null {
  for (const child of node.children ?? []) {
    if (child.id === id) return node
    const found = findParentOf(child, id)
    if (found) return found
  }
  return null
}

/** 列表外层容器（virtual-list 自身无 painted bounds，宽度基准取它的父 div） */
async function listContainer(s: E2ESession): Promise<AuditNode> {
  const { tree } = await s.app.call('getTree', {})
  if (!tree) throw new Error('getTree 返回空树')
  const listNode = collectNodes(tree as AuditNode).find((node) => node.testId === 'mirror-list')
  expect(listNode, 'mirror-list 应在树中').toBeDefined()
  const container = findParentOf(tree as AuditNode, listNode!.id)
  expect(container, 'mirror-list 的父容器应在树中').not.toBeNull()
  return container!
}

function collectNodes(node: AuditNode, out: AuditNode[] = []): AuditNode[] {
  out.push(node)
  for (const child of node.children ?? []) collectNodes(child, out)
  return out
}

describe('镜像源对话框：已测速态几何与悬停', () => {
  it('行盒等宽且填满列表；行序按延迟升序；截图落盘', async () => {
    session = await launchE2E({ setupCompleted: true, githubSpeedtest: { results: SEED_RESULTS } })
    const app = session.app
    await openMirrorDialog(session)
    await sleep(500)

    const rows = await rowsWithBounds(session)
    expect(rows.length, '挂载的行数应大于 4（窗口化后仍有可见行）').toBeGreaterThan(4)

    const widths = rows.map((row) => Math.round(row.bounds!.width))
    const labels = rows.map((row) => row.testId!.replace('mirror-row-', ''))
    console.log(`[mirror-e2e] 行宽 ${JSON.stringify(widths)} | 行序 ${JSON.stringify(labels)}`)
    // 同一浮层内行间相对比较：绕开 anchored 子树 bounds 偏移的测量伪影
    expect(new Set(widths).size, `各行宽度不一致：${widths.join('/')}（漏 width:'100%'）`).toBe(1)

    // 行宽应覆盖列表容器宽度（内容宽排布时实测 219–445，容器 564）
    const container = await listContainer(session)
    const containerWidth = Math.round(container.bounds!.width)
    expect(
      widths[0]!,
      `行宽 ${widths[0]} 应填满列表容器 ${containerWidth}（内容宽排布会明显偏窄）`,
    ).toBeGreaterThan(containerWidth - 8)

    // 已测速态：按延迟升序（首个镜像行 = 种子最快站），延迟文案与「推荐」芯片在树中
    expect(labels[0], '官方源行应在首位').toBe('official')
    expect(labels[1], '按延迟升序：最快站在官方源行之后').toBe('gh.ddlc.top')
    const texts = await app.getByType('text').all()
    const allText = texts.map((node) => node.text ?? '').join('\n')
    expect(allText, '最快站延迟应显示').toContain('412 ms')
    expect(allText, '推荐芯片应可见').toContain('推荐')

    await app.screenshot({ path: join(SHOTS_DIR, 'mirror-seeded.png') })
    expectShotExists('mirror-seeded.png')
  }, 120_000)

  it('指针停在列表上滚轮滚动：hover 底色至多一行（不累积）', async () => {
    session = await launchE2E({ setupCompleted: true, githubSpeedtest: { results: SEED_RESULTS } })
    const app = session.app
    await openMirrorDialog(session)
    await sleep(500)

    const before = await rowsWithBounds(session)
    const anchor = before[2] ?? before[0]
    expect(anchor, '应有可悬停的行').toBeDefined()
    const cx = anchor!.bounds!.x + anchor!.bounds!.width / 2
    const cy = anchor!.bounds!.y + anchor!.bounds!.height / 2

    await app.mouse.move({ x: cx, y: cy })
    await sleep(200)
    const hovered = async (): Promise<string[]> => {
      const rows = await rowsWithBounds(session!)
      return rows
        .filter((row) => {
          const bg = String(row.style?.['backgroundColor'] ?? '')
          return bg !== '' && bg !== 'transparent'
        })
        .map((row) => row.testId!)
    }
    const firstHover = await hovered()
    console.log(`[mirror-e2e] 悬停后带底色的行：${JSON.stringify(firstHover)}`)
    expect(firstHover.length, `悬停应至多高亮一行，实测 ${JSON.stringify(firstHover)}`).toBeLessThanOrEqual(1)

    // 指针不动、滚轮滚动 5 次：滑动经过指针的行不得留下累积高亮
    for (let i = 0; i < 5; i += 1) {
      await app.mouse.wheel({ x: cx, y: cy }, 0, -60)
      await sleep(150)
    }
    const afterScroll = await hovered()
    console.log(`[mirror-e2e] 滚动 5 次后带底色的行：${JSON.stringify(afterScroll)}`)
    expect(
      afterScroll.length,
      `滚动后 hover 底色累积（${afterScroll.length} 行）：${JSON.stringify(afterScroll)}`,
    ).toBeLessThanOrEqual(1)

    await app.screenshot({ path: join(SHOTS_DIR, 'mirror-scrolled-hover.png') })
    expectShotExists('mirror-scrolled-hover.png')
  }, 120_000)
})
