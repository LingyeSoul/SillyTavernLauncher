/**
 * ← src/features/update/checker.py（VersionChecker 的纯逻辑部分）
 *
 * - normalizeVersion：'v1.3.11测试版3' → '1.3.11-beta.3'（设计计划 D5，
 *   语义化 pre-release，供原生 checkUpdate 与 semver 比较使用）。
 * - isBetaVersion / compareLauncherVersions：与 Python 1:1（含中文测试版N、
 *   beta N 两种后缀的完整比较链）。
 * - 远端版本抓取：raw.githubusercontent 的 package.json version（DEVIATION：
 *   Python 抓 src/version.py 的 RELEASES_VERSION，TS 版仓库无该文件等价物，
 *   改抓 package.json version），失败回退 GitHub Releases API tag_name。
 * - changelog：VitePress 页面 vp-doc 区块提取 + HTML→Markdown 纯文本
 *   （_parse_changelog_to_components 是 Flet UI 组件逻辑，不迁移；
 *   UI 层直接 <markdown> 渲染，设计计划 §3）。
 * - @gpuix/native 的 checkUpdate：延迟动态 import + 可注入 loader
 *   （vitest/Node 下 import .node 二进制会挂，测试全部注入 mock）。
 *   DEVIATION: checkNativeUpdate 封装（本文件尾部）当前无生产调用方，仅
 *   tests/updater.test.ts 注入 mock 引用；生产更新检查链路是 checkForUpdates
 *   自行抓 raw.githubusercontent / GitHub Releases API 版本号并本地 semver
 *   比对，不经原生 checkUpdate。原生链路留待后续接入，封装与测试保留备接线。
 */
import { errMsg, logError } from './errorLog'
import { activeMirrorHost, applyMirrorPrefix } from './mirrors'
import {
  fetchWithTlsFallback,
  type CaProvider,
  type FetchLikeX,
  TlsInterceptError,
} from './httpClient'

export interface UpdateCheckResult {
  has_error: boolean
  error_message: string | null
  current_version: string
  latest_version: string | null
  has_update: boolean
}

export const CHANGELOG_URL = 'https://sillytavern.lingyesoul.top/changelog'
const REPO_OWNER = 'LingyeSoul'
const REPO_NAME = 'SillyTavernLauncher'
const RAW_PACKAGE_JSON_URL =
  `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/refs/heads/main/package.json`
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
const USER_AGENT = 'SillyTavernLauncher/1.0'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** 版本抓取链路的失败归因（供 checkForUpdates 组装针对性错误提示） */
export interface UpdateFetchOutcome {
  /** raw + API 任一链路命中 TLS 拦截（加速工具/网关换证书） */
  tlsIntercepted?: boolean
}

export interface UpdaterOptions {
  currentVersion: string
  /** 镜像读取（默认 configStore 的 github.mirror；测试注入） */
  getMirror?: () => string
  fetchImpl?: FetchLike
  /** 系统证书库 PEM 提供者（证书校验失败时回退注入；测试注入避免触 PowerShell） */
  caProvider?: CaProvider
  /** 远端请求超时（毫秒），默认 10000 */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// 版本规范化与比较（纯函数）
// ---------------------------------------------------------------------------

/**
 * ← 设计计划 D5：版本号规范化为 semver pre-release。
 * 'v1.3.11测试版3' → '1.3.11-beta.3'；'v1.3.11测试版' → '1.3.11-beta'；
 * '1.3.11-beta.2' 原样；无后缀只去 v 前缀。
 */
export function normalizeVersion(input: string): string {
  let s = input.trim()
  if (/^[vV]\d/.test(s)) s = s.slice(1)
  const match = /^(\d+(?:\.\d+)*)\s*(.*)$/.exec(s)
  if (!match) return s
  const main = match[1] ?? ''
  const suffix = (match[2] ?? '').trim()
  if (!suffix) return main
  // 中文测试版N / beta N 两种后缀（beta 后可跟空格/点/直接数字）
  const betaMatch = /(?:测试版|beta)[.\s]*(\d*)/i.exec(suffix)
  if (betaMatch) {
    const num = betaMatch[1]
    return num ? `${main}-beta.${num}` : `${main}-beta`
  }
  // 其他后缀（alpha/rc 等已带连字符的 semver pre-release 形态）：先去前导
  // 分隔符再拼 '-'，避免 '2.0.0--alpha.0' 双横线；空白折叠为 '.' 作分隔
  const cleanSuffix = suffix.replace(/^[\s.-]+/, '').replace(/\s+/g, '.')
  return cleanSuffix ? `${main}-${cleanSuffix}` : main
}

/** ← is_beta_version：测试版标识清单（大小写变体逐一列出，1:1） */
const BETA_PATTERN =
  /测试版|beta|Beta|BETA|test|Test|TEST|alpha|Alpha|ALPHA|rc|RC|pre|Preview|dev|Dev/

export function isBetaVersion(versionStr: string): boolean {
  return BETA_PATTERN.test(versionStr)
}

/**
 * ← compare_versions：1 本地更新 / -1 远端更新 / 0 相同。
 * 远端是测试版时恒 0（不提示更新）；中文测试版N/beta N 双后缀比较链 1:1。
 */
export function compareLauncherVersions(localVersion: string, remoteVersion: string): number {
  // 如果远程版本是测试版，无论本地版本是什么，都不认为有更新
  if (isBetaVersion(remoteVersion)) return 0

  // 移除版本号中的前缀"v"（Python str.replace 只替换首个出现，1:1）
  const localClean = localVersion.replace('v', '')
  const remoteClean = remoteVersion.replace('v', '')

  // 使用正则表达式分离版本号和可能的后缀
  const localMatch = /^(\d+(?:\.\d+)*)\s*(.*)$/.exec(localClean)
  const remoteMatch = /^(\d+(?:\.\d+)*)\s*(.*)$/.exec(remoteClean)

  const localMain = localMatch?.[1] ?? localClean
  const localSuffix = localMatch?.[2] ?? ''
  const remoteMain = remoteMatch?.[1] ?? remoteClean
  const remoteSuffix = remoteMatch?.[2] ?? ''

  // 如果主要版本号不同，按主要版本号比较
  if (localMain !== remoteMain) {
    const localNums = localMain.split('.').filter((x) => x !== '' && /^\d+$/.test(x)).map(Number)
    const remoteNums = remoteMain.split('.').filter((x) => x !== '' && /^\d+$/.test(x)).map(Number)
    const length = Math.max(localNums.length, remoteNums.length)
    for (let i = 0; i < length; i++) {
      const localNum = i < localNums.length ? localNums[i] : 0
      const remoteNum = i < remoteNums.length ? remoteNums[i] : 0
      const l = localNum ?? 0
      const r = remoteNum ?? 0
      if (l > r) return 1
      if (l < r) return -1
    }
  }

  // 主要版本号相同的情况下，检查后缀
  const localHasSuffix = localSuffix.length > 0
  const remoteHasSuffix = remoteSuffix.length > 0
  const localIsBeta = isBetaVersion(localSuffix)
  const remoteIsBeta = isBetaVersion(remoteSuffix)

  // 本地是测试版而远程不是 → 远端更新
  if (localIsBeta && !remoteIsBeta) return -1

  if (localHasSuffix && !remoteHasSuffix) return -1
  if (!localHasSuffix && remoteHasSuffix) return 1
  if (localHasSuffix && remoteHasSuffix) {
    // 都是测试版格式：比较 测试版N / beta N
    const localBetaMatch = /测试版\s*(\d*)|beta\s*(\d*)/i.exec(localSuffix)
    const remoteBetaMatch = /测试版\s*(\d*)|beta\s*(\d*)/i.exec(remoteSuffix)
    if (localBetaMatch && remoteBetaMatch) {
      const localBetaNum = localBetaMatch[1] ?? localBetaMatch[2] ?? ''
      const remoteBetaNum = remoteBetaMatch[1] ?? remoteBetaMatch[2] ?? ''
      if (localBetaNum && remoteBetaNum) {
        const l = Number(localBetaNum)
        const r = Number(remoteBetaNum)
        if (l > r) return 1
        if (l < r) return -1
        return 0
      }
      if (localBetaNum && !remoteBetaNum) return 1
      if (!localBetaNum && remoteBetaNum) return -1
      return 0
    }
    // 后缀不同，简单比较字符串
    if (localSuffix < remoteSuffix) return -1
    if (localSuffix > remoteSuffix) return 1
    return 0
  }
  return 0
}

// ---------------------------------------------------------------------------
// 镜像 URL（← get_github_mirror + raw/api URL 构造）
// ---------------------------------------------------------------------------

/** ← get_github_mirror：当前生效镜像（官方源 = 'github'；读取口径统一在 mirrors.ts） */
export function getGithubMirror(getMirror?: () => string): string {
  return (getMirror ?? activeMirrorHost)()
}

/**
 * 镜像前缀 URL 构造。
 * DEVIATION（2026-09-21 镜像增强）：前缀规则已收敛到 mirrors.applyMirrorPrefix
 * （注册表门禁 + GitHub 域名判定），本函数保留为薄委托以兼容既有导入与测试。
 */
export function withMirrorPrefix(mirror: string, url: string): string {
  return applyMirrorPrefix(url, mirror)
}

// ---------------------------------------------------------------------------
// 远端版本抓取
// ---------------------------------------------------------------------------

/**
 * 单 URL 抓取：证书校验失败时经系统证书库回退重试（httpClient 层）。
 * TlsInterceptError 记入 outcome 后按普通网络失败返回 null。
 */
async function fetchText(
  url: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  caProvider: CaProvider | undefined,
  outcome: UpdateFetchOutcome | undefined,
): Promise<string | null> {
  try {
    const response = await fetchWithTlsFallback(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    }, { fetchImpl: fetchImpl as unknown as FetchLikeX, caProvider })
    if (response.status === 200) return await response.text()
    logError(`[updater] 请求失败，状态码: ${response.status} url: ${url}`)
    return null
  } catch (err) {
    if (err instanceof TlsInterceptError && outcome) outcome.tlsIntercepted = true
    logError(`[updater] 网络错误: ${errMsg(err)} url: ${url}`)
    return null
  }
}

/**
 * ← get_latest_release_version_from_raw（DEVIATION：抓 package.json version
 * 替代 src/version.py 的 RELEASES_VERSION）。
 */
export async function fetchLatestVersionFromRaw(
  options: UpdaterOptions,
  outcome?: UpdateFetchOutcome,
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const fetchImpl = options.fetchImpl ?? fetch
  const mirror = getGithubMirror(options.getMirror)
  const rawUrl = withMirrorPrefix(mirror, RAW_PACKAGE_JSON_URL)
  const content = await fetchText(rawUrl, timeoutMs, fetchImpl, options.caProvider, outcome)
  if (content === null) return null
  try {
    const data = JSON.parse(content) as { version?: unknown }
    if (typeof data.version === 'string' && data.version.length > 0) return data.version
    return null
  } catch {
    return null
  }
}

/** ← get_latest_release_version 的 API 回退（releases/latest tag_name） */
export async function fetchLatestVersionFromApi(
  options: UpdaterOptions,
  outcome?: UpdateFetchOutcome,
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const fetchImpl = options.fetchImpl ?? fetch
  const mirror = getGithubMirror(options.getMirror)
  const apiUrl = withMirrorPrefix(mirror, RELEASES_API_URL)
  const content = await fetchText(apiUrl, timeoutMs, fetchImpl, options.caProvider, outcome)
  if (content === null) return null
  try {
    const data = JSON.parse(content) as { tag_name?: unknown; name?: unknown }
    if (typeof data.tag_name === 'string') return data.tag_name
    if (typeof data.name === 'string') return data.name
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// changelog 抓取（← fetch_changelog + _html_to_markdown）
// ---------------------------------------------------------------------------

/** Python html.unescape 的常用子集（命名 + 十进制 + 十六进制实体） */
export function unescapeHtml(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    copy: '©',
    reg: '®',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
  }
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return namedEntities[entity] ?? whole
  })
}

/** ← _html_to_markdown：VitePress HTML → Markdown 字符串（纯文本管线 1:1） */
export function htmlToMarkdown(htmlContent: string): string {
  // HTML 解码
  htmlContent = unescapeHtml(htmlContent)

  // 移除所有 script 和 style 标签
  htmlContent = htmlContent.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  htmlContent = htmlContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')

  // 移除 header-anchor 链接
  htmlContent = htmlContent.replace(/<a class="header-anchor"[^>]*>[\s\S]*?<\/a>/g, '')

  // 在每个开始标签前添加换行（除了闭合标签）
  htmlContent = htmlContent.replace(/<(?!\/)([a-z0-9]+)/gi, '\n<$1')

  // 移除所有闭合标签，但保留内容
  htmlContent = htmlContent.replace(/<\/[a-z0-9]+>/gi, '')

  const markdownLines: string[] = []
  const lines = htmlContent.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = (lines[i] ?? '').trim()
    if (!line) {
      i++
      continue
    }

    // h1 标题
    if (line.startsWith('<h1')) {
      const text = line.replace(/<h1[^>]*>/, '').replace(/<[^>]+>/g, '').trim()
      if (text) markdownLines.push(`# ${text}`)
      i++
    }
    // h2 标题（版本标题）
    else if (line.startsWith('<h2')) {
      const text = line.replace(/<h2[^>]*>/, '').replace(/<[^>]+>/g, '').trim()
      if (text) markdownLines.push(`## ${text}`)
      i++
    }
    // h3 标题（章节标题）
    else if (line.startsWith('<h3')) {
      const text = line.replace(/<h3[^>]*>/, '').replace(/<[^>]+>/g, '').trim()
      if (text) markdownLines.push(`### ${text}`)
      i++
    }
    // <p> 标签
    else if (line.startsWith('<p>')) {
      const text = line.replace(/<[^>]+>/g, '').trim()
      if (text) {
        if (line.includes('<strong>') || line.includes('<b>')) {
          const strongMatch = /<(strong|b)>([\s\S]*?)<\/\1>/.exec(line)
          if (strongMatch?.[2]) {
            markdownLines.push(`- **${strongMatch[2].trim()}**`)
          } else {
            markdownLines.push(text)
          }
        } else {
          markdownLines.push(text)
        }
      }
      i++
    }
    // 列表项（收集后续的 code 标签）
    else if (line.startsWith('<li>')) {
      const text = line.replace(/<li>/, '').trim()
      const listParts: string[] = [text]
      let j = i + 1
      while (j < lines.length) {
        const nextLine = (lines[j] ?? '').trim()
        if (nextLine.startsWith('<code>')) {
          const codeMatch = /<code>([\s\S]*?)<\/code>/.exec(nextLine)
          if (codeMatch?.[1]) listParts.push(codeMatch[1])
          j++
        } else if (nextLine.startsWith('<') && !nextLine.startsWith('<code')) {
          break
        } else {
          if (nextLine) listParts.push(nextLine)
          j++
        }
      }
      const combinedText = listParts.join(' - ')
      markdownLines.push(`- ${combinedText}`)
      i = j
    }
    // hr 分隔线
    else if (line.startsWith('<hr')) {
      markdownLines.push('---')
      i++
    }
    // <ul>/<ol> 跳过
    else if (
      line.startsWith('<ul>') ||
      line.startsWith('<ol>') ||
      line.startsWith('</ul>') ||
      line.startsWith('</ol>')
    ) {
      i++
    }
    // 普通文本行
    else if (!line.startsWith('<')) {
      const text = line.replace(/<[^>]+>/g, '').trim()
      if (text) markdownLines.push(text)
      i++
    }
    // 其他情况，跳过
    else {
      i++
    }
  }

  return markdownLines.join('\n\n')
}

/** ← fetch_changelog：抓取页面并提取 vp-doc 区块（证书校验失败时系统 CA 回退） */
export async function fetchChangelog(options: UpdaterOptions = { currentVersion: '' }): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const fetchImpl = (options.fetchImpl ?? fetch) as unknown as FetchLikeX
  try {
    const response = await fetchWithTlsFallback(
      CHANGELOG_URL,
      {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      },
      { fetchImpl, caProvider: options.caProvider },
    )
    if (response.status !== 200) {
      logError(`[updater] 获取更新日志失败，状态码: ${response.status}`)
      return null
    }
    const htmlContent = await response.text()

    // 查找主内容区域 (vp-doc class)
    const vpDocStart = htmlContent.indexOf('class="vp-doc')
    if (vpDocStart === -1) {
      console.warn('[updater] 未找到 vp-doc 容器')
      return null
    }
    // 回溯到 <div 标签开始
    const divStart = htmlContent.lastIndexOf('<div', vpDocStart)
    // 找到 </main> 作为结束位置
    const mainEnd = htmlContent.indexOf('</main>', divStart)
    if (mainEnd === -1) {
      console.warn('[updater] 未找到 </main> 标签')
      return null
    }
    // 提取 vp-doc 的内容（跳过开始的 <div> 标签）
    const firstGt = htmlContent.indexOf('>', divStart) + 1
    const extractedHtml = htmlContent.slice(firstGt, mainEnd)
    const markdownText = htmlToMarkdown(extractedHtml)
    if (markdownText) return markdownText
    console.warn('[updater] 无法从页面中提取更新日志')
    return null
  } catch (err) {
    logError(`[updater] 获取更新日志时出错: ${errMsg(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 检查入口（← check_for_updates；对话框展示是 UI 层的事）
// ---------------------------------------------------------------------------

export async function checkForUpdates(options: UpdaterOptions): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion
  const outcome: UpdateFetchOutcome = {}

  let latestVersion = await fetchLatestVersionFromRaw(options, outcome)
  if (latestVersion === null) {
    // 尝试使用API方式获取
    latestVersion = await fetchLatestVersionFromApi(options, outcome)
  }

  if (latestVersion === null) {
    return {
      has_error: true,
      error_message: outcome.tlsIntercepted
        ? '无法获取最新版本信息：检测到网络证书被拦截（常见于 Watt Toolkit/Steam++ 等 GitHub 加速工具或企业网关）。' +
          '可在设置的 GitHub 镜像源中切换镜像后重试，或暂时关闭相关加速功能。'
        : '无法获取最新版本信息，请检查网络连接或稍后重试',
      current_version: currentVersion,
      latest_version: null,
      has_update: false,
    }
  }

  try {
    const comparison = compareLauncherVersions(currentVersion, latestVersion)
    return {
      has_error: false,
      error_message: null,
      current_version: currentVersion,
      latest_version: latestVersion,
      has_update: comparison < 0,
    }
  } catch (err) {
    return {
      has_error: true,
      error_message: `版本比较时出错: ${err instanceof Error ? err.message : String(err)}`,
      current_version: currentVersion,
      latest_version: latestVersion,
      has_update: false,
    }
  }
}

// ---------------------------------------------------------------------------
// 原生 checkUpdate（@gpuix/native 延迟 import + 可注入）
// ---------------------------------------------------------------------------

/** @gpuix/native 模块的 checkUpdate 相关类型面（type-only import，运行时零成本） */
export type NativeCheckUpdate = (
  currentVersion: string,
  options: NativeCheckUpdateOptions,
) => Promise<NativeAvailableUpdate | null>

export interface NativeCheckUpdateOptions {
  endpoints: string[]
  pubkey: string
  headers?: Array<{ key: string; value: string }>
  timeoutMs?: number
  installerArgs?: string[]
  installMode?: string
}

export interface NativeAvailableUpdate {
  currentVersion: string
  version: string
  notes: string | null
  date: string | null
  downloadUrl: string
  format: string
}

export type NativeModuleLoader = () => Promise<{ checkUpdate: NativeCheckUpdate }>

/** 默认 loader：动态 import（仅生产 Bun 宿主调用；测试必须注入 mock） */
const defaultNativeLoader: NativeModuleLoader = () =>
  import('@gpuix/native') as Promise<{ checkUpdate: NativeCheckUpdate }>

/**
 * 原生更新检查封装（D5：normalizeVersion 后的 semver 喂给 checkUpdate）。
 * 延迟 import + 可注入——vitest/Node 下 import .node 二进制会挂。
 */
export async function checkNativeUpdate(
  currentVersion: string,
  options: NativeCheckUpdateOptions,
  loader: NativeModuleLoader = defaultNativeLoader,
): Promise<NativeAvailableUpdate | null> {
  const mod = await loader()
  return mod.checkUpdate(normalizeVersion(currentVersion), options)
}
