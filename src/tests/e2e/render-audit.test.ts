/**
 * E2E 用例 7：全量 UI 渲染几何审计（越界/错位巡检工具，报告模式不作为门禁）。
 *
 * 原理：自动化协议 getTree 返回全树节点（含布局 bounds），逐节点比对基准帧
 * （= 树根 bounds，即 app 固定窗 800x644），结果落 __shots__/render-audit-*.json
 * 供人工/图像模型复核。每个状态先截图（强制绘制一帧）再取树。
 *
 * ⚠️ 已实测的两类测量伪影（复核时须排除，勿当缺陷）：
 * - anchored 弹窗子树的 bounds 与绘制位置系统性偏移（实测 whitelist 弹窗内容
 *   错报 ~180 逻辑像素；截图裁剪对比证伪）——弹窗内部越界标记一律作废。
 * - 滚动容器及子树的 bounds 含滚动位移（滚到底后视口 y 报 -146.7，实际裁剪
 *   未动、内容完整可达）——滚动子树"越界"不作越界证据。
 * - 文本互叠（text-overlap）告警在"anchored 浮层 vs 背后基础树"跨层时为遮挡
 *   伪影（浮层本就该盖住背后文字）；同层互叠才需人工复核。
 *
 * 2026-09-20 全量巡检结论：16 个 UI 状态（六视图/分 tab/下拉展开/三弹窗/
 * EULA/欢迎/浅色主题）截图目检全部像素干净；几何标记经逐一去伪后仅剩
 * PageScaffold 容器级溢出（绘制不可见）与滚动上缘 ~18px 裁剪泄漏（真实现象，
 * 详见当次 JSON 与巡检报告）。
 */
import { afterEach, describe, it } from 'vitest'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchE2E, sleep, expectShotExists, SHOTS_DIR } from './helpers'
import type { E2ESession } from './helpers'

interface ElemBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 自动化协议 TreeNode 的结构化最小类型（protocol.d.ts 同形，避免深路径导入） */
interface AuditNode {
  id: number
  type: string
  text?: string
  testId?: string
  style?: Record<string, unknown>
  bounds?: ElemBounds
  children?: AuditNode[]
}

interface Violation {
  state: string
  kind: 'out-of-window' | 'text-overlap'
  detail: string
}

const OVERFLOW_TOLERANCE = 1
const OVERLAP_RATIO = 0.4
const SETTLE_MS = 500

let session: E2ESession | null = null

afterEach(async () => {
  if (session) {
    await session.cleanup()
    session = null
  }
})

/** 窗口尺寸：initialize 幂等（helpers 同款二次握手），借道拿 window 宽高。
 *  实测 GPUIX_BACKGROUND 后台窗元数据与真实布局脱节（报 800x600，布局实为
 *  app.tsx 固定窗 800x644）：仅作兜底，权威基准帧取树根 bounds（见 auditState）。 */
async function getWindowSize(app: E2ESession['app']): Promise<ElemBounds> {
  const init = await app.call('initialize', { protocolVersion: 1, client: 'stl-render-audit' })
  return { x: 0, y: 0, width: init.window.width, height: init.window.height }
}

/** 矩形相交面积（不相交为 0） */
function intersectionArea(a: ElemBounds, b: ElemBounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** 节点定位串：testId 优先，退化到类型 + 文本前 12 字 */
function describeNode(node: AuditNode): string {
  const label = node.testId ?? node.text?.slice(0, 12) ?? ''
  return label ? `${node.type}(${label})` : node.type
}

/**
 * 单状态审计：截图（强制绘制一帧，bounds 随布局就绪）→ getTree 全树扫描。
 * 越界违规直接入 violations；文本互叠入 warnings（不入断言）。
 */
async function auditState(
  app: E2ESession['app'],
  state: string,
  win: ElemBounds,
  shotName: string,
  violations: Violation[],
  warnings: Violation[],
): Promise<void> {
  await app.screenshot({ path: join(SHOTS_DIR, shotName) })
  expectShotExists(shotName)
  const { tree } = await app.call('getTree', {})
  if (!tree) throw new Error(`${state}: getTree 返回空树`)
  // 权威基准帧 = 树根 bounds：后台窗模式下 initialize 的 window 元数据失真
  const frame = tree.bounds ?? win

  const texts: Array<{ node: AuditNode; b: ElemBounds }> = []
  const walk = (node: AuditNode): void => {
    const b = node.bounds
    if (b) {
      const out =
        b.x < -OVERFLOW_TOLERANCE ||
        b.y < -OVERFLOW_TOLERANCE ||
        b.x + b.width > frame.width + OVERFLOW_TOLERANCE ||
        b.y + b.height > frame.height + OVERFLOW_TOLERANCE
      if (out) {
        violations.push({
          state,
          kind: 'out-of-window',
          detail: `${describeNode(node)} bounds=(${b.x.toFixed(1)},${b.y.toFixed(1)} ` +
            `${b.width.toFixed(1)}x${b.height.toFixed(1)}) 基准帧=${frame.width}x${frame.height}`,
        })
      }
      if (node.type === 'text' && (node.text ?? '').trim() !== '') {
        texts.push({ node, b })
      }
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)

  // 文本互叠：O(n²) 两两比对（同屏文本量数百级，可接受）；同一父下相邻文本
  // 由 GPUIX 纵向堆叠语义天然不叠，相交即异常
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]
      const c = texts[j]
      const inter = intersectionArea(a.b, c.b)
      if (inter <= 0) continue
      const minArea = Math.min(a.b.width * a.b.height, c.b.width * c.b.height)
      if (inter / minArea > OVERLAP_RATIO) {
        warnings.push({
          state,
          kind: 'text-overlap',
          detail: `${describeNode(a.node)} ↔ ${describeNode(c.node)} 相交率 ` +
            `${((inter / minArea) * 100).toFixed(0)}%`,
        })
      }
    }
  }
}

/** 断言前把全部审计结果落盘 JSON（失败也可全文复核；按用例分流防覆盖） */
function flushReport(name: string, violations: Violation[], warnings: Violation[]): void {
  writeFileSync(
    join(SHOTS_DIR, `render-audit-${name}.json`),
    JSON.stringify({ violations, warnings }, null, 2),
  )
}

function fmt(list: Violation[]): string {
  return list.map((v) => `[${v.state}] ${v.kind}: ${v.detail}`).join('\n')
}

describe('全量 UI 渲染几何审计', () => {
  it('主界面：六视图 + 分 tab + 下拉展开 + 三弹窗，逐状态越界/互叠检测', async () => {
    session = await launchE2E({ setupCompleted: true, seedSt: true })
    const app = session.app
    const win = await getWindowSize(app)
    const violations: Violation[] = []
    const warnings: Violation[] = []
    const audit = (state: string, shot: string) =>
      auditState(app, state, win, shot, violations, warnings)

    for (const nav of ['terminal', 'version', 'sync', 'extensions', 'settings', 'about']) {
      await app.getByTestId(`nav-${nav}`).waitFor({ timeoutMs: 10_000 })
    }

    await audit('terminal', 'audit-terminal.png')

    // 版本视图（种子仓库 → 卡片渲染）+ 版本切换弹窗
    await app.getByTestId('nav-version').click()
    await app.getByTestId('version-switch-1.17.0').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('version', 'audit-version.png')
    await app.getByTestId('version-switch-1.17.0').click()
    await sleep(SETTLE_MS)
    await audit('version-switch-dialog', 'audit-version-switch-dialog.png')
    // Modal 退场动画 240ms：点取消按钮关闭（Escape 不响应非强模态焦点外的键），等退场完成
    await app.getByTestId('version-switch-cancel').click()
    await sleep(SETTLE_MS)

    await app.getByTestId('nav-sync').click()
    await app.getByTestId('sync-method').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('sync', 'audit-sync.png')

    await app.getByTestId('nav-extensions').click()
    await app.getByTestId('ext-git-install').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('extensions', 'audit-extensions.png')
    await app.getByTestId('extensions-tab-user').click()
    await sleep(SETTLE_MS)
    await audit('extensions-user-tab', 'audit-extensions-user-tab.png')

    // 设置三分 tab + Select 下拉展开态（anchored 菜单是越界高发面）
    await app.getByTestId('nav-settings').click()
    await app.getByTestId('setting-check-env').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('settings-env', 'audit-settings-env.png')
    await app.getByTestId('setting-mirror').click()
    await sleep(SETTLE_MS)
    await audit('settings-select-open', 'audit-settings-select-open.png')
    await app.call('keystrokes', { keys: 'escape' })
    await sleep(SETTLE_MS)

    // 镜像源设置对话框（2026-09-21 镜像增强）：55 行站点的模态长列表 + 模态滚动区
    // （Modal maxHeight 560）是越界高发面，单列一个审计状态
    await app.getByTestId('setting-mirror-open').click()
    await app.getByTestId('mirror-list').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('mirror-settings', 'audit-mirror-settings.png')
    await app.getByTestId('mirror-close').click()
    await sleep(SETTLE_MS)
    // 环境模式下拉三选一 + embedded 警告对话框（Embedded-All Phase 1 / D4）：
    // 种子 seedSt → env_mode='system'；点击目标项标签在"当前值 ≠ 目标值"时唯一
    // （触发器显示当前值标签，下拉项三选一，二者不重复命中）
    await app.getByTestId('setting-env-mode').click()
    await sleep(SETTLE_MS)
    await audit('settings-envmode-open', 'audit-settings-envmode-open.png')
    // 选 embedded → 兼容性风险确认对话框（四条风险逐字）
    await app.getByText('启动器内置运行时（实验性）').click()
    await app.getByTestId('env-embedded-confirm-cancel').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('env-embedded-confirm', 'audit-env-embedded-confirm.png')
    // 取消 → 不落盘，Select 由 settings 状态驱动回显种子值（system）
    await app.getByTestId('env-embedded-confirm-cancel').click()
    await sleep(SETTLE_MS)
    await audit('settings-env-after-cancel', 'audit-settings-env-after-cancel.png')
    // 再选 embedded → 确认 → env_mode=embedded，常驻 warning hint 出现
    await app.getByTestId('setting-env-mode').click()
    await sleep(SETTLE_MS)
    await app.getByText('启动器内置运行时（实验性）').click()
    await app.getByTestId('env-embedded-confirm-ok').waitFor({ timeoutMs: 10_000 })
    await app.getByTestId('env-embedded-confirm-ok').click()
    await app.getByTestId('setting-env-mode-warning').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('settings-env-embedded', 'audit-settings-env-embedded.png')
    // 恢复种子状态：切回系统环境（非 embedded 目标不弹确认框）
    await app.getByTestId('setting-env-mode').click()
    await sleep(SETTLE_MS)
    await app.getByText('系统环境（Git + Node.js）').click()
    await sleep(SETTLE_MS)
    await app.getByTestId('settings-tab-st').click()
    await sleep(SETTLE_MS)
    await audit('settings-st', 'audit-settings-st.png')
    await app.getByTestId('settings-tab-launcher').click()
    await sleep(SETTLE_MS)
    await audit('settings-launcher', 'audit-settings-launcher.png')

    await app.getByTestId('nav-about').click()
    await app.getByTestId('about-check-update').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('about', 'audit-about.png')

    // 白名单弹窗收尾（种子环境 ST 未运行，titlebar-close 点击=直接退进程，
    // 退出确认弹窗不可达——该弹窗为固定文案简单 Modal，由静态审计覆盖）。
    // 重进设置页默认 env tab，白名单入口在酒馆（st）tab 网络区，先切 tab
    await app.getByTestId('nav-settings').click()
    await app.getByTestId('settings-tab-st').waitFor({ timeoutMs: 10_000 })
    await app.getByTestId('settings-tab-st').click()
    await app.getByTestId('setting-edit-ip-whitelist').waitFor({ timeoutMs: 10_000 })
    await app.getByTestId('setting-edit-ip-whitelist').click()
    await sleep(SETTLE_MS)
    await audit('whitelist-dialog', 'audit-whitelist-dialog.png')

    flushReport("main", violations, warnings)
    console.log(`[render-audit] main: 违规 ${violations.length}、告警 ${warnings.length}（含测量伪影，见文件头说明）`)
    if (violations.length) console.log(fmt(violations))
  }, 180_000)

  it('首启链路：EULA → 欢迎问答，逐状态越界/互叠检测', async () => {
    session = await launchE2E({ env: { EULA_COUNTDOWN_SECONDS: '2' } })
    const app = session.app
    const win = await getWindowSize(app)
    const violations: Violation[] = []
    const warnings: Violation[] = []
    const audit = (state: string, shot: string) =>
      auditState(app, state, win, shot, violations, warnings)

    await app.getByTestId('eula-agree').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('eula', 'audit-eula.png')

    // 对齐 first-run 用例里程碑 4：等倒计时结束标记再点，否则同意被静默拦截
    await app.getByText('您现在可以同意协议了').waitFor({ timeoutMs: 45_000 })
    await app.getByTestId('eula-agree').click()
    await app.getByTestId('welcome-question').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('welcome', 'audit-welcome.png')

    flushReport("first-run", violations, warnings)
    console.log(`[render-audit] first-run: 违规 ${violations.length}、告警 ${warnings.length}（含测量伪影，见文件头说明）`)
    if (violations.length) console.log(fmt(violations))
  }, 120_000)

  it('浅色主题：版本/设置/关于，越界/互叠检测', async () => {
    session = await launchE2E({ setupCompleted: true, seedSt: true, theme: 'light' })
    const app = session.app
    const win = await getWindowSize(app)
    const violations: Violation[] = []
    const warnings: Violation[] = []
    const audit = (state: string, shot: string) =>
      auditState(app, state, win, shot, violations, warnings)

    for (const nav of ['terminal', 'version', 'sync', 'extensions', 'settings', 'about']) {
      await app.getByTestId(`nav-${nav}`).waitFor({ timeoutMs: 10_000 })
    }

    await app.getByTestId('nav-version').click()
    await app.getByTestId('version-switch-1.17.0').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('light-version', 'audit-light-version.png')

    await app.getByTestId('nav-settings').click()
    await app.getByTestId('setting-check-env').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('light-settings', 'audit-light-settings.png')

    await app.getByTestId('nav-about').click()
    await app.getByTestId('about-check-update').waitFor({ timeoutMs: 10_000 })
    await sleep(SETTLE_MS)
    await audit('light-about', 'audit-light-about.png')

    flushReport("light", violations, warnings)
    console.log(`[render-audit] light: 违规 ${violations.length}、告警 ${warnings.length}（含测量伪影，见文件头说明）`)
    if (violations.length) console.log(fmt(violations))
  }, 120_000)
})
