/**
 * 镜像源对话框性能探针（2026-09-21 卡顿修复的取证与回归脚本）。
 *
 * 用 createTestRoot 的真实 GPUI 管线（build_element → apply_styles → layout → paint）
 * 量化七组数据（数字为实测值；同用例跨轮受机器负载影响 1.5–2× 漂移，比值稳定）：
 *
 *  A. 对照帧：空树 flush 成本（隔离"对话框成本"与"管线固定成本"）
 *  B. 行数缩放：模态内滚动容器挂 N 行时的脏帧成本 —— 证明成本随**挂载行数**线性
 *     （8 行 2.6–7.4ms / 32 行 10.2–22.4ms / 56 行 16.6–36.7ms）
 *  C. 窗口化 A/B：同一批行、同一模态，全量挂载对照体 vs 真实（窗口化）对话框
 *     修复前 503–509 元素 / 37–68ms 单帧  →  修复后 267 元素 / 4.3–4.9ms 单帧
 *  D. 测速风暴（store 驱动渐进写入）：逐站写入延迟时的提交数 / 原生 mutation
 *     修复前 55 提交 / 21505 setStyle / 1431 insertBefore → 修复后同提交数但
 *     setStyle 1841（行 memo + 窗口化：每次提交只重发被测行的样式）
 *  D2. 真实测速链路（注入探针）：onResult → 进度合流 → 落盘全链路的提交与 mutation
 *     修复前 55 提交 / 21505→23317 mutation  →  修复后 2 提交 / 255 mutation
 *  E. 推窗正确性：深滚后靠后的行必须挂载、官方源行卸载（否则滚过窗口就是空白）
 *  F. 同类风险扫描：版本视图长列表（60 个 tag → 857 元素 / 31ms 帧，同款风险）
 *
 * 运行：cd src && bun scripts/bench-mirror-dialog.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MB = 1048576

const tempDir = mkdtempSync(join(tmpdir(), 'stlbench-mirror'))
const originalCwd = process.cwd()
process.chdir(tempDir)

const { createTestRoot } = await import('@gpuix/react/testing')
const { createElement: h } = await import('react')
const typeOnly = await import('react')
type ReactNode = import('react').ReactNode
void typeOnly
const { ThemeProvider } = await import('../ui/theme')
const { TooltipProvider } = await import('../ui/components/Tooltip')
const { Modal } = await import('../ui/components/Modal')
const { Chip } = await import('../ui/components/Chip')
const { ICONS } = await import('../ui/components/icons')
const { MirrorSettingsDialog } = await import('../ui/dialogs/MirrorSettingsDialog')
const { MIRROR_SOURCES } = await import('../services/mirrors')
const { getConfigStore } = await import('../services/configStore')
const { readSettings, useSettings } = await import('../stores/settings')

getConfigStore().set('motionEnabled', false)

const HOSTS = MIRROR_SOURCES.map((source) => source.host)

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

// ---------------------------------------------------------------------------
// A. 对照帧
// ---------------------------------------------------------------------------
async function measureControlFrame(): Promise<void> {
  const testRoot = createTestRoot({ width: 800, height: 644 })
  const renderer = testRoot.renderer
  testRoot.root.render(
    h(ThemeProvider, null, h('div', { style: { display: 'flex' } }, h('text', null, '对照'))),
  )
  await sleep(30)
  renderer.flush()
  const frames: number[] = []
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now()
    renderer.flush()
    frames.push(performance.now() - t0)
  }
  console.log('=== A. 对照帧（空树 flush ×20）===')
  console.log(
    `  空树                          元素 ${String(renderer.getRetainedElementCount()).padStart(4)} | 帧 p50 ${median(frames).toFixed(2)}ms | max ${Math.max(...frames).toFixed(2)}ms`,
  )
  testRoot.unmount()
  await sleep(20)
}

// ---------------------------------------------------------------------------
// B/C 用例的行与列表构件（与 MirrorRow 同形，供对照体使用）
// ---------------------------------------------------------------------------
const rowStyle = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  minHeight: 40,
  paddingLeft: 10,
  paddingRight: 10,
  borderBottomWidth: 1,
  borderColor: '#2a2a2a',
}

function replicaRow(host: string, index: number, selected: boolean): ReactNode {
  return h(
    'div',
    { key: host, style: rowStyle },
    h('svg', {
      source: ICONS.check,
      style: { width: 12, height: 12, color: selected ? '#e06c3a' : 'transparent' },
    }),
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 } },
      h('text', { style: { fontSize: 13, color: '#e6e6e6', fontFamily: 'Consolas' } }, host),
      index === 0
        ? h(
            'text',
            { style: { fontSize: 11, color: '#8a8a8a', fontFamily: 'Microsoft YaHei' } },
            '不使用加速镜像，直连 GitHub（国内网络可能较慢或不可达）',
          )
        : null,
    ),
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 } },
      index % 4 === 0 ? h(Chip, { accent: true, children: '推荐' }) : null,
      h(
        'text',
        { style: { fontSize: 11, fontFamily: 'Consolas', color: '#8a8a8a', minWidth: 64 } },
        `${400 + index} ms`,
      ),
    ),
  )
}

/** 全量挂载对照体（= 修复前的形状：滚动容器内一次挂 N 行） */
function ReplicaList({ count }: { count: number }): ReactNode {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: '#2a2a2a' } },
    h(
      'div',
      {
        testId: 'replica-list',
        style: { height: 300, display: 'flex', flexDirection: 'column', overflow: 'scroll' },
      },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', flexShrink: 0 } },
        Array.from({ length: count }, (_, i) =>
          replicaRow(`probe-host-${i}.example.com`, i, i === 0),
        ) as never,
      ),
    ),
  )
}

/** 滚动采样：scrollTo 交替位移 + flush（脏帧口径） */
function sampleScroll(
  target: { id: number },
  renderer: { scrollTo: (id: number, x: number, y: number) => void; flush: () => void },
  frameCount = 20,
): number[] {
  const frames: number[] = []
  for (let i = 0; i < frameCount; i += 1) {
    const t0 = performance.now()
    renderer.scrollTo(target.id, 0, i % 2 === 0 ? -120 : -40)
    renderer.flush()
    frames.push(performance.now() - t0)
  }
  return frames
}

// ---------------------------------------------------------------------------
// B. 行数缩放（模态内滚动容器）
// ---------------------------------------------------------------------------
async function measureRowScaling(): Promise<void> {
  console.log('\n=== B. 行数缩放（Modal + 滚动容器，脏帧口径）===')
  for (const count of [8, 16, 32, 56]) {
    const testRoot = createTestRoot({ width: 800, height: 644 })
    const renderer = testRoot.renderer
    testRoot.root.render(
      h(
        ThemeProvider,
        null,
        h(
          TooltipProvider,
          null,
          h(
            Modal,
            { open: true, title: '镜像源设置', width: 600, maxHeight: 560, onClose: () => undefined },
            h(ReplicaList, { count }) as never,
          ) as never,
        ),
      ),
    )
    await sleep(40)
    renderer.flush()
    const list = renderer.findByTestId('replica-list')
    if (!list) {
      console.log(`  行数 ${count}: 未找到滚动容器`)
      testRoot.unmount()
      continue
    }
    const frames = sampleScroll(list, renderer)
    console.log(
      `  行数 ${String(count).padStart(2)}                       元素 ${String(
        renderer.getRetainedElementCount(),
      ).padStart(4)} | 帧 p50 ${median(frames).toFixed(2).padStart(6)}ms | max ${Math.max(...frames).toFixed(2).padStart(6)}ms`,
    )
    testRoot.unmount()
    await sleep(20)
  }
}

// ---------------------------------------------------------------------------
// C. 窗口化 A/B（同一批行 → 全量挂载 vs 真实窗口化对话框）
// ---------------------------------------------------------------------------
async function measureWindowAb(): Promise<void> {
  console.log('\n=== C. 窗口化 A/B（同轮交替，消除机器负载漂移）===')
  for (let round = 1; round <= 2; round += 1) {
    const replica = createTestRoot({ width: 800, height: 644 })
    replica.root.render(
      h(
        ThemeProvider,
        null,
        h(
          TooltipProvider,
          null,
          h(
            Modal,
            { open: true, title: '镜像源设置', width: 600, maxHeight: 560, onClose: () => undefined },
            h(ReplicaList, { count: HOSTS.length + 1 }) as never,
          ) as never,
        ),
      ),
    )
    await sleep(40)
    replica.renderer.flush()
    const replicaList = replica.renderer.findByTestId('replica-list')
    if (replicaList) {
      const frames = sampleScroll(replicaList, replica.renderer)
      console.log(
        `  轮次 ${round} 对照·全量挂载（${HOSTS.length + 1} 行）  元素 ${String(
          replica.renderer.getRetainedElementCount(),
        ).padStart(4)} | 帧 p50 ${median(frames).toFixed(2).padStart(6)}ms | max ${Math.max(...frames).toFixed(2).padStart(6)}ms`,
      )
    }
    replica.unmount()
    await sleep(20)

    const real = createTestRoot({ width: 800, height: 644 })
    real.root.render(h(ThemeProvider, null, h(TooltipProvider, null, h(MirrorSettingsDialog, null))))
    await sleep(40)
    real.renderer.flush()
    const realList = real.renderer.findByTestId('mirror-list')
    if (realList) {
      const frames = sampleScroll(realList, real.renderer)
      console.log(
        `  轮次 ${round} 修复后·窗口化对话框        元素 ${String(
          real.renderer.getRetainedElementCount(),
        ).padStart(4)} | 帧 p50 ${median(frames).toFixed(2).padStart(6)}ms | max ${Math.max(...frames).toFixed(2).padStart(6)}ms`,
      )
    }
    real.unmount()
    await sleep(20)
  }
}

// ---------------------------------------------------------------------------
// D. 测速风暴（真实对话框，渐进结果写入）
// ---------------------------------------------------------------------------
interface OpStats {
  batches: number
  ops: Record<string, number>
  nativeMs: number
}

function instrument(renderer: { applyBatch: (json: string) => number[] }): OpStats {
  const stats: OpStats = { batches: 0, ops: {}, nativeMs: 0 }
  const original = renderer.applyBatch.bind(renderer)
  renderer.applyBatch = (json: string): number[] => {
    stats.batches += 1
    try {
      for (const op of JSON.parse(json) as unknown[][]) {
        const name = String(op[0])
        stats.ops[name] = (stats.ops[name] ?? 0) + 1
      }
    } catch {
      stats.ops['<unparsed>'] = (stats.ops['<unparsed>'] ?? 0) + 1
    }
    const t0 = performance.now()
    const result = original(json)
    stats.nativeMs += performance.now() - t0
    return result
  }
  return stats
}

function opsDelta(before: OpStats, after: OpStats): string {
  const entries = Object.entries(after.ops)
    .map(([key, value]) => [key, value - (before.ops[key] ?? 0)] as const)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
  const total = entries.reduce((sum, [, value]) => sum + value, 0)
  return `${total}（${entries.map(([key, value]) => `${key}=${value}`).join(' ') || '无'}）`
}

/**
 * 测速风暴：逐站把延迟写进 config 并 reload（等价对话框 onResult 的渐进重渲染）。
 * 延迟按注册表逆序递增——每个新结果都排到已测站最前，强制真实重排
 * （正序时排序结果恰等于注册表序，测不出位移成本）。
 */
async function measureSpeedStorm(): Promise<void> {
  console.log('\n=== D. 测速风暴（渐进写入 55 站结果）===')
  for (const round of [1, 2]) {
    const testRoot = createTestRoot({ width: 800, height: 644 })
    const renderer = testRoot.renderer
    const stats = instrument(renderer as unknown as { applyBatch: (json: string) => number[] })
    testRoot.root.render(h(ThemeProvider, null, h(TooltipProvider, null, h(MirrorSettingsDialog, null))))
    await sleep(40)
    renderer.flush()
    const results: Record<string, number> = {}
    const before: OpStats = { batches: 0, ops: { ...stats.ops }, nativeMs: 0 }
    const batchesBefore = stats.batches
    const nativeBefore = stats.nativeMs
    const t0 = performance.now()
    for (let i = 0; i < HOSTS.length; i += 1) {
      results[HOSTS[i]!] = 400 + (HOSTS.length - i) * 13
      getConfigStore().set('github.speedtest', {
        results: { ...results },
        failed: [],
        tested_at: new Date().toISOString(),
      })
      useSettings.setState(readSettings())
      await sleep(0)
      renderer.flush()
    }
    const totalMs = performance.now() - t0
    const batches = stats.batches - batchesBefore
    console.log(
      `  轮次 ${round}: ${totalMs.toFixed(0)}ms 总耗时 | 提交 ${batches} 次（${(
        batches / HOSTS.length
      ).toFixed(2)} 次/站）| native applyBatch ${(stats.nativeMs - nativeBefore).toFixed(1)}ms | mutation ${opsDelta(before, stats)}`,
    )
    testRoot.unmount()
    await sleep(20)
  }
}

// ---------------------------------------------------------------------------
// D2. 真实测速链路（注入探针，零网络驱动完整 onResult → 合流 → 落盘）
// ---------------------------------------------------------------------------
async function measureRealSpeedTest(): Promise<void> {
  console.log('\n=== D2. 真实测速链路（注入探针 413ms）===')
  const { __setMirrorDialogProbeForTests } = await import('../ui/dialogs/MirrorSettingsDialog')
  __setMirrorDialogProbeForTests(async () => 413)
  // 关自动选优与加速：测速完只 toast 汇报，不触发 gitconfig/remote 同步（测的是 UI 链路）
  getConfigStore().set('github.auto', false)
  getConfigStore().set('github.enabled', false)
  getConfigStore().set('github.speedtest', { results: {}, failed: [], tested_at: '' })
  useSettings.setState(readSettings())

  for (const round of [1, 2]) {
    const testRoot = createTestRoot({ width: 800, height: 644 })
    const renderer = testRoot.renderer
    const stats = instrument(renderer as unknown as { applyBatch: (json: string) => number[] })
    testRoot.root.render(h(ThemeProvider, null, h(TooltipProvider, null, h(MirrorSettingsDialog, null))))
    await sleep(40)
    renderer.flush()
    const button = renderer.findByTestId('mirror-speedtest')
    if (!button) {
      console.log('  未找到 mirror-speedtest')
      testRoot.unmount()
      continue
    }
    const bounds = renderer.getElementBounds(button.id)
    const before: OpStats = { batches: 0, ops: { ...stats.ops }, nativeMs: 0 }
    const batchesBefore = stats.batches
    const nativeBefore = stats.nativeMs
    const t0 = performance.now()
    if (bounds) {
      renderer.nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    }
    // 等测速链路收尾：探针脚本无 ToastHost（toast 不落树），以按钮文案回到空闲态为准
    for (let i = 0; i < 400; i += 1) {
      await sleep(10)
      renderer.flush()
      if (renderer.getAllText().some((text) => text.includes('一键测速'))) break
    }
    const totalMs = performance.now() - t0
    const batches = stats.batches - batchesBefore
    console.log(
      `  轮次 ${round}: ${totalMs.toFixed(0)}ms 总耗时 | 提交 ${batches} 次（${(
        batches / HOSTS.length
      ).toFixed(2)} 次/站）| native applyBatch ${(stats.nativeMs - nativeBefore).toFixed(1)}ms | mutation ${opsDelta(before, stats)}`,
    )
    testRoot.unmount()
    await sleep(20)
    getConfigStore().set('github.speedtest', { results: {}, failed: [], tested_at: '' })
    useSettings.setState(readSettings())
  }
  __setMirrorDialogProbeForTests(null)
}

// ---------------------------------------------------------------------------
// E. 推窗正确性
// ---------------------------------------------------------------------------
async function measureWindowSlide(): Promise<void> {
  console.log('\n=== E. 推窗正确性（深滚后靠后的行必须挂载）===')
  // 复位测速结果：行序回到注册表顺序，挂载区间才好按注册表下标读数
  getConfigStore().set('github.speedtest', { results: {}, failed: [], tested_at: '' })
  useSettings.setState(readSettings())
  const testRoot = createTestRoot({ width: 800, height: 644 })
  const renderer = testRoot.renderer
  testRoot.root.render(h(ThemeProvider, null, h(TooltipProvider, null, h(MirrorSettingsDialog, null))))
  await sleep(40)
  renderer.flush()
  const list = renderer.findByTestId('mirror-list')
  if (!list) {
    console.log('  未找到 mirror-list')
    testRoot.unmount()
    return
  }
  const mountedRange = (): string => {
    const mounted: number[] = []
    for (let i = 0; i < HOSTS.length; i += 1) {
      if (renderer.findByTestId(`mirror-row-${HOSTS[i]}`)) mounted.push(i)
    }
    const official = renderer.findByTestId('mirror-row-official') !== undefined
    const first = mounted[0]
    const last = mounted[mounted.length - 1]
    return `镜像行 [${first === undefined ? '无' : `${first}..${last}`}]（${mounted.length} 行）| 官方源行 ${official ? '在' : '不在'}`
  }
  console.log(
    `  初始          锚 ${JSON.stringify(renderer.getListScrollTop(list.id))} | ${mountedRange()}`,
  )
  for (const target of [20, 40, HOSTS.length - 1]) {
    renderer.scrollToItem(list.id, target)
    renderer.flush()
    renderer.dispatchNativeEvents()
    await sleep(20)
    renderer.flush()
    console.log(
      `  滚到第 ${String(target).padStart(2)} 行  锚 ${JSON.stringify(renderer.getListScrollTop(list.id))} | ${mountedRange()}`,
    )
  }
  testRoot.unmount()
  await sleep(20)
}

// ---------------------------------------------------------------------------
// F. 同类风险扫描：版本视图长列表（SillyTavern 仓库 tag 常态 60+）
// ---------------------------------------------------------------------------
async function measureVersionListRisk(): Promise<void> {
  console.log('\n=== F. 同类风险：版本视图（注入 N 个版本条目，脏帧口径）===')
  const { VersionView } = await import('../ui/views/VersionView')
  const { useVersionState } = await import('../stores/versionState')
  for (const count of [3, 30, 60]) {
    const versions = Array.from({ length: count }, (_, i) => ({
      version: `1.${18 - (i % 18)}.${i}`,
      tag: {
        commit: `deadbeef${i}`,
        date: `2026-0${(i % 9) + 1}-15T10:00:00+08:00`,
        tag_name: `v1.${18 - (i % 18)}.${i}`,
      },
    }))
    useVersionState.setState({ versions, loading: false, error: null })
    const testRoot = createTestRoot({ width: 800, height: 644 })
    const renderer = testRoot.renderer
    testRoot.root.render(
      h(
        ThemeProvider,
        null,
        h(
          TooltipProvider,
          null,
          h('div', { style: { width: '100%', height: '100%', display: 'flex' } }, h(VersionView as never)),
        ),
      ),
    )
    await sleep(60)
    renderer.flush()
    const scroll = renderer.findByTestId('page-scroll')
    if (!scroll) {
      console.log(`  版本数 ${count}: 未找到滚动区`)
      testRoot.unmount()
      continue
    }
    const frames = sampleScroll(scroll, renderer)
    console.log(
      `  版本数 ${String(count).padStart(2)}                      元素 ${String(
        renderer.getRetainedElementCount(),
      ).padStart(4)} | 帧 p50 ${median(frames).toFixed(2).padStart(6)}ms | max ${Math.max(...frames).toFixed(2).padStart(6)}ms`,
    )
    testRoot.unmount()
    await sleep(20)
  }
}

try {
  console.log('=== 镜像源对话框性能探针 ===')
  console.log(`镜像站 ${HOSTS.length} 站 | 堆 ${(process.memoryUsage().heapUsed / MB).toFixed(0)}MB\n`)
  await measureControlFrame()
  await measureRowScaling()
  await measureWindowAb()
  await measureSpeedStorm()
  await measureRealSpeedTest()
  await measureWindowSlide()
  await measureVersionListRisk()
  console.log('\n=== 完成 ===')
} finally {
  process.chdir(originalCwd)
  await sleep(300)
  rmSync(tempDir, { recursive: true, force: true })
}
