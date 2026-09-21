/**
 * 复现取证：镜像源对话框高速滚动下"选项异常重复高亮"（2026-09-21 上报）。
 *
 * 结论（修复前 → 修复后）：行内本地 hover 态只由自己的 mouseLeave 清除，高速滚动
 * 一帧内 GPUI 对滑过指针的多行连发 mouseEnter、leave 有丢失/乱序 → 一帧 4–5 行
 * 同时带 hover 底色；慢速滚动下 enter/leave 配对正常（1 行），故既有慢滚 E2E 覆盖不到。
 * 修复 = 悬停态提到父级单一槽位（见 MirrorSettingsDialog 文件头）。
 *
 * 既有 E2E（tests/e2e/mirror-dialog.test.ts）只覆盖慢滚（5×60px、间隔 150ms），
 * 高速滚动的复现钥匙是 dispatchScrollWheel —— 不带 flush 的裸滚轮连发，
 * 一帧内大位移，等价真实窗口里的甩动滚轮。
 *
 * 审计三类信号（每轮滚动风暴后扫描）：
 *  1. hover 洗涤行数（backgroundColor 非透明）——期望 ≤1，>1 即"重复高亮"
 *  2. 选中行数（checkmark svg color === ember）——期望 ≤1（选站在窗口内时恒 1）
 *  3. 重复挂载（可达树里同一 testId 出现多次）——期望 0（排查元素泄漏/切片重叠）
 *
 * 运行：cd src && bun scripts/repro-mirror-dup-highlight.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const tempDir = mkdtempSync(join(tmpdir(), 'stlrepro-mirror'))
const originalCwd = process.cwd()
process.chdir(tempDir)

const { createTestRoot } = await import('@gpuix/react/testing')
const { createElement: h } = await import('react')
const { ThemeProvider } = await import('../ui/theme')
const { TooltipProvider } = await import('../ui/components/Tooltip')
const { MirrorSettingsDialog } = await import('../ui/dialogs/MirrorSettingsDialog')
const { MIRROR_SOURCES } = await import('../services/mirrors')
const { getConfigStore } = await import('../services/configStore')
const { readSettings, useSettings } = await import('../stores/settings')

const HOSTS = MIRROR_SOURCES.map((source) => source.host)
/** 选站在列表深部（初始窗口 [0..23] 之外）：滚动后进窗，检验选中态唯一性 */
const SELECTED_HOST = HOSTS[40] ?? HOSTS[HOSTS.length - 1]!

// 配置：镜像开启 + 手动选定 + 无测速结果（行序 = 注册表序，下标可预测）
getConfigStore().set('github.enabled', true)
getConfigStore().set('github.auto', false)
getConfigStore().set('github.mirror', SELECTED_HOST)
getConfigStore().set('github.speedtest', { results: {}, failed: [], tested_at: '' })
useSettings.setState(readSettings())
getConfigStore().set('motionEnabled', false)

interface RowState {
  host: string
  bg: string
  check: string
  y: number | null
}

function scanRows(): RowState[] {
  const out: RowState[] = []
  for (const host of HOSTS) {
    const row = renderer.findByTestId(`mirror-row-${host}`)
    if (!row) continue
    const svg = row.children
      .map((id) => renderer.getElement(id))
      .find((el) => el !== undefined && el.type === 'svg')
    const bounds = renderer.getElementBounds(row.id)
    out.push({
      host,
      bg: String(row.style.backgroundColor ?? ''),
      check: String(svg?.style.color ?? ''),
      y: bounds ? Math.round(bounds.y) : null,
    })
  }
  return out
}

function audit(label: string): void {
  const rows = scanRows()
  const hovered = rows.filter((r) => r.bg !== '' && r.bg !== 'transparent')
  const checked = rows.filter((r) => r.check !== '' && r.check !== 'transparent')
  // 重复挂载：可达树里同一 testId 出现多次（原生元素泄漏/切片重叠的判别信号）
  const tree = JSON.stringify(renderer.toJSON())
  const dupTestIds = HOSTS.map((host) => ({
    host,
    n: tree.split(`"mirror-row-${host}"`).length - 1,
  })).filter((item) => item.n > 1)
  console.log(
    `[${label}] 挂载 ${String(rows.length).padStart(2)} 行 | hover ${hovered.length}（${hovered.map((r) => r.host).join(',')}）| 选中 ${checked.length}（${checked.map((r) => r.host).join(',')}）| 重复节点 ${dupTestIds.length}（${dupTestIds.slice(0, 3).map((d) => `${d.host}×${d.n}`).join(',')}）`,
  )
  if (hovered.length > 1 || checked.length > 1 || dupTestIds.length > 0) {
    console.log(
      `  !!! 异常：hover=${JSON.stringify(hovered.map((r) => [r.host, r.y]))} checked=${JSON.stringify(checked.map((r) => [r.host, r.y]))} dup=${JSON.stringify(dupTestIds)}`,
    )
  }
}

const testRoot = createTestRoot({ width: 800, height: 644 })
const renderer = testRoot.renderer
testRoot.root.render(h(ThemeProvider, null, h(TooltipProvider, null, h(MirrorSettingsDialog, null))))
await sleep(40)
renderer.flush()

const list = renderer.findByTestId('mirror-list')
if (!list) throw new Error('未找到 mirror-list')
// virtual-list 自身无 painted bounds（见 bench 脚本注释），取父容器作为坐标基准
const listElement = renderer.getElement(list.id)
const containerElement =
  listElement?.parentId == null ? undefined : renderer.getElement(listElement.parentId)
if (!containerElement) throw new Error('mirror-list 无父容器')
const listBounds = renderer.getElementBounds(containerElement.id)
if (!listBounds) throw new Error('mirror-list 容器无 bounds')
const cx = Math.round(listBounds.x + listBounds.width / 2)
const cy = Math.round(listBounds.y + 60)
console.log(
  `选站 ${SELECTED_HOST}（HOSTS[40]）| 列表 (${cx},${cy}) | 初始锚 ${JSON.stringify(renderer.getListScrollTop(list.id))}`,
)

audit('基线：未滚动未悬停')

// --- 阶段 1：慢速对照（既有 E2E 同款：move + 5×60px，每次独立派发）---
renderer.nativeSimulateMouseMove(cx, cy)
await sleep(20)
renderer.flush()
audit('慢速对照：悬停后')
for (let i = 0; i < 5; i += 1) {
  renderer.nativeSimulateScrollWheel(cx, cy, 0, -60)
  await sleep(20)
}
audit('慢速对照：5×60px 后')

// --- 阶段 2：高速风暴（dispatchScrollWheel 裸连发，一帧内大位移）---
function storm(deltaY: number, count: number, label: string): void {
  for (let i = 0; i < count; i += 1) renderer.dispatchScrollWheel(cx, cy, 0, deltaY)
  renderer.flush()
  renderer.dispatchNativeEvents()
  renderer.flush()
  audit(label)
}

storm(-120, 10, '高速·下 10×120px')
storm(-240, 10, '高速·下 10×240px（加速）')
storm(240, 6, '高速·上 6×240px（回甩）')
storm(-240, 14, '高速·下 14×240px（再甩到底）')

// --- 阶段 3：悬停后高速甩走，检验 hover 粘滞 ---
renderer.nativeSimulateMouseMove(cx, cy)
await sleep(20)
renderer.flush()
audit('悬停复位后')
storm(-240, 12, '高速·悬停中甩走')

// --- 阶段 4：真实感的混合轨迹（小步快频 + 抖动）---
for (let i = 0; i < 6; i += 1) {
  for (let j = 0; j < 4; j += 1) renderer.dispatchScrollWheel(cx, cy, 0, i % 2 === 0 ? -90 : 70)
  renderer.flush()
  renderer.dispatchNativeEvents()
  renderer.flush()
}
audit('混合轨迹后')

console.log(`\n保留元素数 ${renderer.getRetainedElementCount()}`)
testRoot.unmount()
await sleep(300)
try {
  rmSync(tempDir, { recursive: true, force: true })
} catch {
  // Windows 下 native 句柄偶有延迟释放（EBUSY）；临时目录留给系统清理
}
process.chdir(originalCwd)
