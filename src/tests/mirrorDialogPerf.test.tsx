/**
 * 镜像源对话框性能门禁（2026-09-21 卡顿修复的固化断言）。
 *
 * 背景（实测数据见 scripts/bench-mirror-dialog.ts，createTestRoot 真实 GPUI 管线）：
 * ① 列表全量挂载 56 行 = 509 原生元素，GPUIX 每次滚动帧重排/重绘整个滚动子树
 *    → 单帧 37–68ms（≈15–25 FPS，滚动卡顿根因）；窗口化后 267 元素 / 4–5ms。
 * ② 测速逐站 setState = 55 次提交 / 21505 次原生 setStyle / 1431 次 insertBefore
 *    （行序在光标下反复搬动）→ 测速期间主线程满载，入场动画与滚动全被拖垮。
 * ③ ThemeProvider 的 shimmerPhase 并入主题 context：每 375ms 换一次 context value
 *    → 全部 useTheme 消费者重渲染（本对话框每次相位跳变 782 次 setStyle）。
 *
 * 本文件用结构性断言（元素数 / 提交数 / 原生 mutation 计数），不做耗时断言——
 * 耗时随机器负载漂移（实测同用例跨轮 1.5–2×），计数则是确定性的。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'
import type { TestRenderer, TestRoot } from '@gpuix/react/testing'
import type { MirrorProbe } from '../services/mirrors'

/** 窗口化生效的元素上限：窗口 24 行 ≈ 267 元素；回退为全量挂载则 ≥ 500 */
const WINDOWED_ELEMENT_LIMIT = 320
/** 测速链路提交上限：55 站合流到 10 次/秒（注入探针秒回 → 进度 1 次 + 收尾 1 次） */
const SPEED_TEST_COMMIT_LIMIT = 6
/** 测速链路 setStyle 上限：逐行 memo 后只有被测站那几行重发样式（修复前 21505） */
const SPEED_TEST_STYLE_LIMIT = 1000

let tempDir: string
let originalCwd: string

type DialogModule = {
  MirrorSettingsDialog: () => unknown
  __setMirrorDialogProbeForTests: (probe: MirrorProbe | null) => void
}

let dialogModule: DialogModule
let ThemeProvider: (props: { children: unknown }) => unknown
let TooltipProvider: (props: { children: unknown }) => unknown
let createElementFn: typeof import('react').createElement
let testRoot: TestRoot
let renderer: TestRenderer

/** 原生 mutation 计数：包装 applyBatch（batch facade 每次提交调一次） */
interface MutationStats {
  commits: number
  styles: number
  ops: Record<string, number>
}

function instrument(target: TestRenderer): MutationStats {
  const stats: MutationStats = { commits: 0, styles: 0, ops: {} }
  const original = target.applyBatch.bind(target)
  // applyBatch 在 TestRenderer 上是只读实例属性（batch facade 每次提交调一次）：
  // 探针用同签名的可写视图覆盖之，拿到原生 mutation 的确定性计数
  const patchable = target as unknown as { applyBatch: (json: string) => number[] }
  patchable.applyBatch = (json: string): number[] => {
    stats.commits += 1
    try {
      for (const op of JSON.parse(json) as unknown[][]) {
        const name = String(op[0])
        stats.ops[name] = (stats.ops[name] ?? 0) + 1
        if (name === 'setStyle') stats.styles += 1
      }
    } catch {
      stats.ops['<unparsed>'] = (stats.ops['<unparsed>'] ?? 0) + 1
    }
    return original(json)
  }
  return stats
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  renderer.flush()
}

/** 每个用例前重建根：对话框是模态（anchored 浮层），跨用例复用会带上残余状态 */
async function mountDialog(): Promise<void> {
  testRoot = createTestRoot({ width: 800, height: 644 })
  renderer = testRoot.renderer
  testRoot.root.render(
    createElementFn(
      ThemeProvider as never,
      null,
      createElementFn(TooltipProvider as never, null, createElementFn(dialogModule.MirrorSettingsDialog as never)),
    ),
  )
  await settle(40)
  const list = renderer.findByTestId('mirror-list')
  if (!list) throw new Error('对话框未挂载（mirror-list 不在树中）')
}

beforeAll(async () => {
  originalCwd = process.cwd()
  tempDir = mkdtempSync(join(tmpdir(), 'stl-mirror-gate-'))
  process.chdir(tempDir)
  const [react, theme, tooltip, dialog] = await Promise.all([
    import('react'),
    import('../ui/theme'),
    import('../ui/components/Tooltip'),
    import('../ui/dialogs/MirrorSettingsDialog'),
  ])
  createElementFn = react.createElement
  ThemeProvider = theme.ThemeProvider as never
  TooltipProvider = tooltip.TooltipProvider as never
  dialogModule = dialog as never
  const { getConfigStore } = await import('../services/configStore')
  getConfigStore().set('motionEnabled', false)
}, 60_000)

afterAll(() => {
  dialogModule.__setMirrorDialogProbeForTests(null)
  testRoot?.unmount()
  process.chdir(originalCwd)
  rmSync(tempDir, { recursive: true, force: true })
})

describe('镜像源对话框性能门禁①：列表窗口化', () => {
  it('56 站只挂视口附近的行；官方源行与首个镜像行在树（E2E 交互契约）', async () => {
    const { MIRROR_SOURCES } = await import('../services/mirrors')
    const { getConfigStore } = await import('../services/configStore')
    const { readSettings, useSettings } = await import('../stores/settings')
    // 复位测速结果：行序回注册表顺序，首行 = 首个镜像站
    getConfigStore().set('github.speedtest', { results: {}, failed: [], tested_at: '' })
    useSettings.setState(readSettings())
    await mountDialog()

    const retained = renderer.getRetainedElementCount()
    console.log(`[mirror-gate] 挂载元素 ${retained}（阈值 <${WINDOWED_ELEMENT_LIMIT}）`)
    expect(
      retained,
      `窗口化失效：原生保留元素 ${retained} ≥ ${WINDOWED_ELEMENT_LIMIT}（全量挂载 ≈509）`,
    ).toBeLessThan(WINDOWED_ELEMENT_LIMIT)

    expect(renderer.findByTestId('mirror-row-official'), '官方源行必须在树').toBeDefined()
    expect(
      renderer.findByTestId(`mirror-row-${MIRROR_SOURCES[0]!.host}`),
      '首个镜像行必须在树（E2E 点击目标）',
    ).toBeDefined()
    // 未挂载的下半段（窗口 24 行 < 56 行）
    const farHost = MIRROR_SOURCES[MIRROR_SOURCES.length - 1]!.host
    expect(
      renderer.findByTestId(`mirror-row-${farHost}`),
      '末位镜像行不应在树（证明只挂了窗口切片）',
    ).toBeUndefined()
  }, 60_000)

  it('行盒几何：所有行同宽且填满列表内宽（virtual-list 子项不会自动拉伸）', async () => {
    await mountDialog()

    // 行 → 列表 → 容器：容器的 bounds 可测（virtual-list 自身 getElementBounds 返回
    // null）。容器 bounds 即列表可用内宽（实测行宽与容器 bounds 全等，如 564/564），
    // 行宽应与之相等
    const list = renderer.findByTestId('mirror-list')!
    const listElement = renderer.getElement(list.id)!
    const container = listElement.parentId === null ? null : renderer.getElement(listElement.parentId)
    expect(container, '列表外层容器应在树中').toBeDefined()
    const containerBounds = renderer.getElementBounds(container!.id)
    expect(containerBounds, '容器 bounds 可测').not.toBeNull()
    const expected = Math.round(containerBounds!.width)

    const { MIRROR_SOURCES } = await import('../services/mirrors')
    const widths: number[] = []
    const testIds = [
      'mirror-row-official',
      ...MIRROR_SOURCES.map((source) => `mirror-row-${source.host}`),
    ]
    for (const testId of testIds) {
      const row = renderer.findByTestId(testId)
      if (!row) continue
      const bounds = renderer.getElementBounds(row.id)
      if (bounds) widths.push(Math.round(bounds.width))
    }
    console.log(
      `[mirror-gate] 行盒宽：容器内宽 ${expected} | 各行 ${JSON.stringify(widths)}`,
    )
    expect(widths.length, '至少应挂载数行参与几何断言').toBeGreaterThan(4)
    expect(
      new Set(widths).size,
      `各行宽度不一致（${widths.join('/')}）：行盒按内容宽排布（漏 width:'100%'）`,
    ).toBe(1)
    expect(
      Math.abs(widths[0]! - expected),
      `行宽 ${widths[0]} ≠ 列表内宽 ${expected}：行盒未填满列表（shrink-to-fit，实测 219–445px 参差）`,
    ).toBeLessThanOrEqual(1)
  }, 60_000)

  it('深滚推窗：可见区间跟着走，滚动窗口外的行卸载', async () => {
    const { MIRROR_SOURCES } = await import('../services/mirrors')
    const { getConfigStore } = await import('../services/configStore')
    const { readSettings, useSettings } = await import('../stores/settings')
    getConfigStore().set('github.speedtest', { results: {}, failed: [], tested_at: '' })
    useSettings.setState(readSettings())
    await mountDialog()

    const list = renderer.findByTestId('mirror-list')!
    const deepIndex = MIRROR_SOURCES.length - 2
    const deepHost = MIRROR_SOURCES[deepIndex]!.host
    renderer.scrollToItem(list.id, deepIndex)
    renderer.flush()
    renderer.dispatchNativeEvents()
    await settle()

    const anchor = renderer.getListScrollTop(list.id)
    console.log(`[mirror-gate] 滚到第 ${deepIndex} 行：锚 ${JSON.stringify(anchor)}`)
    expect(
      renderer.findByTestId(`mirror-row-${deepHost}`),
      '深滚后靠后的行必须已挂载（否则滚过窗口就是空白）',
    ).toBeDefined()
    expect(
      renderer.findByTestId('mirror-row-official'),
      '滚到列表尾部后官方源行应已卸载（窗口只保留视口附近的行）',
    ).toBeUndefined()
    expect(
      renderer.getRetainedElementCount(),
      '推窗后元素数仍应保持窗口量级（不是全量挂载）',
    ).toBeLessThan(WINDOWED_ELEMENT_LIMIT)
  }, 60_000)
})

describe('镜像源对话框性能门禁②：测速链路提交合流', () => {
  it('55 站秒回：提交 ≤ 上限、样式重发远低于全量（修复前 55 提交 / 21505 setStyle）', async () => {
    const { getConfigStore } = await import('../services/configStore')
    const { readSettings, useSettings } = await import('../stores/settings')
    // 关自动选优/加速：测速完只汇报，不触发 gitconfig/remote 同步（测的是 UI 链路）
    getConfigStore().set('github.auto', false)
    getConfigStore().set('github.enabled', false)
    getConfigStore().set('github.speedtest', { results: {}, failed: [], tested_at: '' })
    useSettings.setState(readSettings())
    dialogModule.__setMirrorDialogProbeForTests(async () => 413)

    await mountDialog()
    const stats = instrument(renderer)
    const button = renderer.findByTestId('mirror-speedtest')
    expect(button, '测速按钮必须在树').toBeDefined()
    const bounds = renderer.getElementBounds(button!.id)
    expect(bounds, '测速按钮必须有 bounds').not.toBeNull()

    renderer.nativeSimulateClick(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    // 逐帧驱动直到按钮回到空闲态（"一键测速"）或超时
    for (let i = 0; i < 200; i += 1) {
      await settle(10)
      if (renderer.getAllText().some((text) => text.includes('一键测速'))) break
    }

    console.log(
      `[mirror-gate] 测速链路：提交 ${stats.commits} 次 | setStyle ${stats.styles} | 全部 mutation ${JSON.stringify(stats.ops)}`,
    )
    expect(
      stats.commits,
      `测速进度未合流：${stats.commits} 次提交（上限 ${SPEED_TEST_COMMIT_LIMIT}，逐站提交时为 55+）`,
    ).toBeLessThanOrEqual(SPEED_TEST_COMMIT_LIMIT)
    expect(
      stats.styles,
      `样式重发未收敛：${stats.styles} 次 setStyle（上限 ${SPEED_TEST_STYLE_LIMIT}，修复前 21505）`,
    ).toBeLessThan(SPEED_TEST_STYLE_LIMIT)
    // 测速结果确实落了盘（门禁不得把功能断言掉）
    const github = getConfigStore().get<Record<string, unknown>>('github.speedtest')
    expect(
      Object.keys((github?.results as Record<string, number>) ?? {}).length,
      '测速结果应已落盘',
    ).toBeGreaterThan(0)
    dialogModule.__setMirrorDialogProbeForTests(null)
  }, 60_000)
})

describe('镜像源对话框性能门禁③：shimmer 相位不波及对话框', () => {
  it('动效开启空转 1s：对话框零提交（修复前每个 375ms 相位跳变都全列表重渲染）', async () => {
    const { getConfigStore } = await import('../services/configStore')
    getConfigStore().set('motionEnabled', true)
    await mountDialog()
    const stats = instrument(renderer)

    // 空转覆盖 2 个相位跳变窗口 + 裕度
    await settle(1000)

    console.log(
      `[mirror-gate] 空转 1s：提交 ${stats.commits} 次 | setStyle ${stats.styles}（motion 开）`,
    )
    expect(
      stats.commits,
      `shimmer 相位跳变波及对话框：空转 1s 出现 ${stats.commits} 次提交（相位应只重渲染 Skeleton）`,
    ).toBe(0)
    getConfigStore().set('motionEnabled', false)
  }, 60_000)
})

describe('镜像源对话框性能门禁④：高速滚动下悬停/选中唯一性', () => {
  /**
   * 2026-09-21 上报"高速滚动下选项异常重复高亮"。
   *
   * 根因：行内本地 hover 态只由**自己**的 mouseLeave 清除，而高速滚动一帧内 GPUI
   * 对滑过指针的多行连发 mouseEnter、leave 有丢失/乱序 → 各行的态各自为政，实测
   * 一帧亮 4–5 行（慢速滚动下 enter/leave 配对正常，故既有慢滚 E2E 覆盖不到）。
   * 修复 = 悬停状态提到父级单一槽位，"多行同亮"在数据结构上不可能。
   *
   * 复现钥匙：`dispatchScrollWheel`（不带 flush 的裸滚轮连发）制造一帧内大位移；
   * `nativeSimulateScrollWheel` 每次自带 flush，慢滚永远复现不出来。
   */
  it('滚动风暴后带 hover 底色的行 ≤ 1、选中行 ≤ 1（修复前实测 4–5 行同亮）', async () => {
    const { MIRROR_SOURCES } = await import('../services/mirrors')
    const { getConfigStore } = await import('../services/configStore')
    const { readSettings, useSettings } = await import('../stores/settings')
    // 选站在列表深部：滚动后进窗，检验选中态跨推窗仍唯一
    const selectedHost = MIRROR_SOURCES[Math.min(40, MIRROR_SOURCES.length - 1)]!.host
    getConfigStore().set('github.enabled', true)
    getConfigStore().set('github.auto', false)
    getConfigStore().set('github.mirror', selectedHost)
    getConfigStore().set('github.speedtest', { results: {}, failed: [], tested_at: '' })
    useSettings.setState(readSettings())
    await mountDialog()

    const list = renderer.findByTestId('mirror-list')!
    const listElement = renderer.getElement(list.id)!
    const container =
      listElement.parentId === null ? null : renderer.getElement(listElement.parentId)
    expect(container, '列表外层容器应在树中').toBeDefined()
    const containerBounds = renderer.getElementBounds(container!.id)
    expect(containerBounds, '容器 bounds 可测（virtual-list 自身无 bounds）').not.toBeNull()
    const cx = Math.round(containerBounds!.x + containerBounds!.width / 2)
    const cy = Math.round(containerBounds!.y + 60)

    /** 带 hover 底色的行（bg 只在"悬停且未选中"时非透明）与带选中勾的行 */
    const highlightRows = (): { hovered: string[]; selected: string[] } => {
      const hovered: string[] = []
      const selected: string[] = []
      const testIds = [
        'mirror-row-official',
        ...MIRROR_SOURCES.map((source) => `mirror-row-${source.host}`),
      ]
      for (const testId of testIds) {
        const row = renderer.findByTestId(testId)
        if (!row) continue
        const bg = String(row.style.backgroundColor ?? '')
        if (bg !== '' && bg !== 'transparent') hovered.push(testId.replace('mirror-row-', ''))
        const svg = row.children
          .map((id) => renderer.getElement(id))
          .find((el) => el !== undefined && el.type === 'svg')
        const color = String(svg?.style.color ?? '')
        if (color !== '' && color !== 'transparent') {
          selected.push(testId.replace('mirror-row-', ''))
        }
      }
      return { hovered, selected }
    }

    const storm = (deltaY: number, count: number): void => {
      for (let i = 0; i < count; i += 1) renderer.dispatchScrollWheel(cx, cy, 0, deltaY)
      renderer.flush()
      renderer.dispatchNativeEvents()
      renderer.flush()
    }

    renderer.nativeSimulateMouseMove(cx, cy)
    await settle(20)
    const anchorBefore = renderer.getListScrollTop(list.id)?.[0] ?? 0
    let anchorAfterFirstStorm = anchorBefore

    for (let round = 0; round < 4; round += 1) {
      storm(-240, 12)
      if (round === 0) anchorAfterFirstStorm = renderer.getListScrollTop(list.id)?.[0] ?? 0
      const down = highlightRows()
      console.log(
        `[mirror-gate] 风暴 ${round + 1}·下甩：锚 ${JSON.stringify(renderer.getListScrollTop(list.id))} | hover ${JSON.stringify(down.hovered)} | 选中 ${JSON.stringify(down.selected)}`,
      )
      expect(
        down.hovered.length,
        `高速下甩后多行同亮（${JSON.stringify(down.hovered)}）：逐行本地 hover 态累积回归`,
      ).toBeLessThanOrEqual(1)
      expect(
        down.selected.length,
        `高速下甩后选中态不唯一：${JSON.stringify(down.selected)}`,
      ).toBeLessThanOrEqual(1)

      storm(240, 8)
      const up = highlightRows()
      expect(
        up.hovered.length,
        `回甩后多行同亮（${JSON.stringify(up.hovered)}）`,
      ).toBeLessThanOrEqual(1)
      expect(
        up.selected.length,
        `回甩后选中态不唯一：${JSON.stringify(up.selected)}`,
      ).toBeLessThanOrEqual(1)
    }

    // 非空转保证：风暴确实推动了列表（否则断言恒真、测不到东西）
    expect(
      anchorAfterFirstStorm,
      `风暴未推动列表（锚 ${anchorBefore} → ${anchorAfterFirstStorm}）`,
    ).toBeGreaterThan(anchorBefore)
  }, 60_000)
})
