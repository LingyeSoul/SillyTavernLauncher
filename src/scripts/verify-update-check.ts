/**
 * 校验脚本：启动器"检查更新"链路真实网络取证（Bun，从 src/ 目录运行）。
 *
 *   bun scripts/verify-update-check.ts [--mirror <host>]
 *
 * 为什么不用单测：updater.test.ts 全部 mock 注入 fetch，只能证明逻辑正确，
 * 证明不了"远端源头真实可达、URL 指向的文件真实存在"——raw 主链路 404
 * （仓库根无 package.json，2026-10-07 修复为 src/ 路径）就是这么漏网的。
 * 本脚本对生产同款代码路径（services/updater）发起真实请求，逐环节取证：
 *
 *   A. 远端源头（不经 launcher 逻辑，直接 fetch 生产端点）：
 *     ① raw src/package.json（生产 RAW_PACKAGE_JSON_URL）→ 预期 200 + version；
 *     ② GitHub Releases 列表 API（含预发布；/releases/latest 滤掉全部
 *        prerelease → 纯预发布周期拿到陈旧稳定版，已修）→ 预期返回最新 tag。
 *   B. checkForUpdates 全链路（生产代码 + 真实网络）：
 *     ③ 当前版本视角 → 打印结果（has_error/has_update 均为有效证据）；
 *     ④ beta 用户视角（v2.0.0-beta.4）→ has_update 应为 true（对话框会弹；
 *        2026-10-07 修复的主目标——修复前 beta→beta 恒不提示）。
 *   C. 用户落点：
 *     ⑤ fetchChangelog → 应返回非空 markdown；
 *     ⑥ 官网更新说明页（UPDATE_PAGE_URL，"前往下载"的落点）→ 预期 200。
 *
 * --mirror <host>：经指定镜像站前缀重跑（默认 GitHub 官方源）。
 * GitHub 直连不可达不是脚本失败——那正是③要取的证据（错误提示链路，
 * 加速工具换证书场景 launcher 会走系统 CA 回退 + 提示切镜像）；②④⑤⑥
 * 任一失败才是链路缺陷。
 */
import { APP_VERSION } from '../version'
import {
  RAW_PACKAGE_JSON_URL,
  RELEASES_API_URL,
  UPDATE_PAGE_URL,
  checkForUpdates,
  fetchChangelog,
  fetchLatestVersionFromApi,
  fetchLatestVersionFromRaw,
  normalizeVersion,
} from '../services/updater'
import { OFFICIAL_MIRROR, applyMirrorPrefix } from '../services/mirrors'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 环境性跳过（不计失败）：直连被加速工具/网关换证书或封锁时，裸 fetch 探针
 *  无系统 CA 回退能力；launcher 真实链路（fetchWithTlsFallback）在 B 段取证 */
function skip(name: string, reason: string): void {
  console.log(`  [SKIP] ${name} — ${reason}`)
}

/** 裸 fetch 取证（带 UA 与超时；镜像前缀可选） */
async function probe(
  label: string,
  url: string,
  mirror: string,
): Promise<{ status: number; body: string } | null> {
  const target = mirror === OFFICIAL_MIRROR ? url : applyMirrorPrefix(url, mirror)
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': 'SillyTavernLauncher/1.0' },
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.text()
    console.log(`  [probe] ${label}: HTTP ${res.status} (${target})`)
    return { status: res.status, body }
  } catch (err) {
    console.log(`  [probe] ${label}: 网络错误 ${err instanceof Error ? err.message : String(err)} (${target})`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
let mirror = OFFICIAL_MIRROR
const mirrorFlag = argv.indexOf('--mirror')
if (mirrorFlag !== -1 && argv[mirrorFlag + 1]) {
  mirror = argv[mirrorFlag + 1] as string
}
const getMirror = (): string => mirror
console.log(`— 检查更新链路取证（镜像源: ${mirror === OFFICIAL_MIRROR ? 'GitHub官方源' : mirror}）—\n`)

// ===========================================================================
// A. 远端源头取证
// ===========================================================================
console.log('A. 远端源头（裸 fetch，不经 launcher 逻辑）')
// 探针口径：拿到 HTTP 状态码才是定论（非 200 = 链路缺陷，FAIL）；
// 网络/TLS 错误 = 环境性拦截（本机无系统 CA 回退能力），SKIP，B 段为权威取证
const raw = await probe('① raw src/package.json（生产 URL）', RAW_PACKAGE_JSON_URL, mirror)
if (raw === null) {
  skip('① 生产 raw URL 可达且携带 version', '直连网络错误（环境性拦截，见 B 段 launcher 链路取证）')
} else if (raw.status !== 200) {
  check('① 生产 raw URL 可达且携带 version', false, `HTTP ${raw.status}（404 = 远端 main 无此文件，链路缺陷）`)
} else {
  try {
    const version = (JSON.parse(raw.body) as { version?: unknown }).version
    check('① 生产 raw URL 可达且携带 version',
      typeof version === 'string' && version.length > 0, `version = ${String(version)}`)
  } catch {
    check('① 生产 raw URL 可达且携带 version', false, 'JSON 解析失败')
  }
}

const api = await probe('② Releases 列表 API（含预发布）', RELEASES_API_URL, mirror)
if (api === null) {
  skip('② Releases 列表返回最新 tag（含预发布）', '直连网络错误（环境性拦截，见 B 段 launcher 链路取证）')
} else if (api.status !== 200) {
  check('② Releases 列表返回最新 tag（含预发布）', false, `HTTP ${api.status}`)
} else {
  try {
    const list = JSON.parse(api.body) as Array<{ tag_name?: unknown }>
    const tag = Array.isArray(list) && list[0] ? list[0].tag_name : undefined
    check('② Releases 列表返回最新 tag（含预发布）',
      typeof tag === 'string' && tag.length > 0, `tag = ${String(tag)}`)
  } catch {
    check('② Releases 列表返回最新 tag（含预发布）', false, 'JSON 解析失败')
  }
}

// ===========================================================================
// B. checkForUpdates 全链路（生产代码路径）
// ===========================================================================
console.log('\nB. checkForUpdates（生产代码 + 真实网络）')
const options = { currentVersion: normalizeVersion(APP_VERSION), getMirror }

const viaRaw = await fetchLatestVersionFromRaw(options)
console.log(`  [info] fetchLatestVersionFromRaw → ${viaRaw ?? 'null'}`)
const viaApi = await fetchLatestVersionFromApi(options)
console.log(`  [info] fetchLatestVersionFromApi → ${viaApi ?? 'null'}`)

const resultNow = await checkForUpdates(options)
console.log(`  [info] 当前版本(${normalizeVersion(APP_VERSION)})视角: has_error=${resultNow.has_error}` +
  ` has_update=${resultNow.has_update} latest=${resultNow.latest_version ?? 'null'}` +
  `${resultNow.error_message ? ` err="${resultNow.error_message}"` : ''}`)
check('③ 当前版本视角检查无异常', !resultNow.has_error, resultNow.error_message ?? `latest=${resultNow.latest_version}`)

// ④ beta 周期核心场景：beta.4 用户必须被提示 beta.5（2026-10-07 修复的主目标）
const resultOld = await checkForUpdates({ currentVersion: 'v2.0.0-beta.4', getMirror })
console.log(`  [info] beta 用户(v2.0.0-beta.4)视角: has_error=${resultOld.has_error}` +
  ` has_update=${resultOld.has_update} latest=${resultOld.latest_version ?? 'null'}`)
check('④ beta 用户视角应发现更新（弹"发现新版本"对话框）',
  !resultOld.has_error && resultOld.has_update === true,
  resultOld.error_message ?? `v2.0.0-beta.4 → ${resultOld.latest_version}`)

// 正式版用户不被 beta 打扰（保留的设计语义；远端现为 beta → 不提示。仅记录，
// 不作断言：远端转正式版后该视角会翻转为提示，断言会随发布节奏失效）
const resultStable = await checkForUpdates({ currentVersion: 'v1.0.0', getMirror })
console.log(`  [info] 正式版用户(v1.0.0)视角: has_error=${resultStable.has_error}` +
  ` has_update=${resultStable.has_update} latest=${resultStable.latest_version ?? 'null'}（远端 beta → 按设计不提示）`)

// ===========================================================================
// C. 用户落点
// ===========================================================================
console.log('\nC. 用户落点（changelog + 前往下载页面）')
const changelog = await fetchChangelog({ currentVersion: 'v1.0.0' })
const changelogHead = changelog ? changelog.slice(0, 120).replace(/\n/g, ' ') : ''
check('⑤ changelog 抓取非空', changelog !== null && changelog.length > 0, changelogHead)

const updatePage = await probe('⑥ 官网更新说明页（前往下载落点）', UPDATE_PAGE_URL, OFFICIAL_MIRROR)
check('⑥ 更新说明页可达', updatePage !== null && updatePage.status === 200,
  updatePage === null ? '网络错误' : `HTTP ${updatePage.status}`)

// ===========================================================================
// 汇总
// ===========================================================================
console.log(`\n— 取证汇总: ${passed} pass / ${failed} fail —`)
if (failed > 0) process.exit(1)
