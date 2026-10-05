/**
 * 内置环境（env/）下载安装服务（2026-10-05）：
 * 系统模式（env_mode='system'）下探测不到 Git / Node.js 时，一键下载安装到
 * 内置环境 env/ 目录（即便携模式布局），安装完成后由调用方切换 env_mode='portable'。
 *
 * 发行版选型（均为 zip、免安装、可共混进同一 env/ 扁平布局）：
 * - Git：MinGit 2.56.0（git-for-windows GitHub Release，包内即 cmd/git.exe 扁平布局，
 *   与仓库既有懒人包 env/cmd/git.exe 同构；镜像前缀改写复用 mirrors.applyMirrorPrefix）
 * - Node.js：v24.21.0 LTS 官方 win-x64 zip（顶层 node-vX-win-x64/ 目录剥离后落 env/ 根），
 *   官方同步发布 SHASUMS256.txt —— 下载后做 SHA256 完整性校验（可执行文件必须校验）。
 *   下载源支持 npmmirror（github 镜像开启时镜像优先，反之官方源优先、镜像兜底）。
 *
 * 纪律：
 * - 下载一律经 fetchWithTlsFallback（Watt Toolkit 类劫持网络下系统证书库回退）；
 * - 解压逐 entry realpath 遏制（Zip-Slip 防护，与 extensions.installFromZip 同一语义）；
 * - 组件间相互独立：Git 失败不阻断 Node（不同下载域，失败面不同），失败可只重装剩余项；
 * - 全部网络/子进程失败均 logError + 结构化返回，不静默吞噬。
 *
 * 版本与 URL 事实核验（2026-10-05 实测）：
 * - MinGit-2.56.0-64-bit.zip：Content-Length 39,602,073；包内 376 entry，cmd/git.exe 就位；
 * - node-v24.21.0-win-x64.zip：Content-Length 37,618,919；2459 entry，
 *   唯一顶层目录 node-v24.21.0-win-x64/，SHA256 与 SHASUMS256.txt 一致。
 */
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { once } from 'node:events'
import { unzipSync } from 'fflate'
import { compareVersions, probeSystemGit, probeSystemNode, resolvePortableEnv } from './env'
import { isPathUnder } from './extensions'
import { realpathBestEffort } from './atomicFs'
import { errMsg, logError } from './errorLog'
import { fetchWithTlsFallback, type CaProvider, type FetchLikeX } from './httpClient'
import { activeMirrorHost, applyMirrorPrefix } from './mirrors'
import { readMirrorState } from './mirrors'
import { spawnSyncCmd, which } from './runtime'

// ---------------------------------------------------------------------------
// 版本与下载源（升级时改这里；URL 构建保持纯函数，测试零网络）
// ---------------------------------------------------------------------------

/** MinGit 版本（git-for-windows） */
export const ENV_INSTALL_GIT_VERSION = '2.56.0'
/** MinGit release tag 的构建后缀（v2.56.0.windows.1） */
export const ENV_INSTALL_GIT_BUILD_SUFFIX = '.windows.1'
/** Node.js LTS 版本 */
export const ENV_INSTALL_NODE_VERSION = '24.21.0'

const NODE_ZIP_NAME = `node-v${ENV_INSTALL_NODE_VERSION}-win-x64.zip`
/** Node 官方 zip 的唯一顶层目录（解压时剥离，使 node.exe/npm.cmd 落 env/ 根） */
const NODE_STRIP_PREFIX = `node-v${ENV_INSTALL_NODE_VERSION}-win-x64/`
const NODE_OFFICIAL_BASE = `https://nodejs.org/dist/v${ENV_INSTALL_NODE_VERSION}/`
const NODE_MIRROR_BASE = `https://npmmirror.com/mirrors/node/v${ENV_INSTALL_NODE_VERSION}/`

const GIT_ZIP_NAME = `MinGit-${ENV_INSTALL_GIT_VERSION}-64-bit.zip`
const GIT_GITHUB_URL =
  `https://github.com/git-for-windows/git/releases/download/` +
  `v${ENV_INSTALL_GIT_VERSION}${ENV_INSTALL_GIT_BUILD_SUFFIX}/${GIT_ZIP_NAME}`

/** Node 下载源（zip 与 SHASUMS 同源取，保证哈希文件与包一致） */
export interface NodeDownloadSource {
  zipUrl: string
  shasumsUrl: string
}

/** Node 候选下载源列表：镜像优先（GitHub 镜像开启 = 国内网络信号）或官方优先、互为兜底 */
export function nodeDownloadSources(mirrorFirst: boolean): NodeDownloadSource[] {
  const official: NodeDownloadSource = {
    zipUrl: `${NODE_OFFICIAL_BASE}${NODE_ZIP_NAME}`,
    shasumsUrl: `${NODE_OFFICIAL_BASE}SHASUMS256.txt`,
  }
  const mirror: NodeDownloadSource = {
    zipUrl: `${NODE_MIRROR_BASE}${NODE_ZIP_NAME}`,
    shasumsUrl: `${NODE_MIRROR_BASE}SHASUMS256.txt`,
  }
  return mirrorFirst ? [mirror, official] : [official, mirror]
}

/** MinGit 候选 URL 列表：镜像前缀优先（github.* 配置生效时）、官方 GitHub 兜底 */
export function minGitDownloadUrls(mirrorHost: string): string[] {
  const prefixed = applyMirrorPrefix(GIT_GITHUB_URL, mirrorHost)
  return prefixed !== GIT_GITHUB_URL ? [prefixed, GIT_GITHUB_URL] : [GIT_GITHUB_URL]
}

// ---------------------------------------------------------------------------
// 探测计划（对话框展示用：缺什么、为什么）
// ---------------------------------------------------------------------------

export interface EnvComponentProbe {
  missing: boolean
  message: string
}

export interface EnvInstallPlan {
  git: EnvComponentProbe
  node: EnvComponentProbe
}

/** 系统环境探测 → 安装计划（复用 env.ts 的 probeSystemGit/Node，whichFn 可注入） */
export function planEnvInstall(whichFn: (binary: string) => string | null = which): EnvInstallPlan {
  const git = probeSystemGit(whichFn)
  const node = probeSystemNode(whichFn)
  return {
    git: { missing: !git.ok, message: git.message },
    node: { missing: !node.ok, message: node.message },
  }
}

// ---------------------------------------------------------------------------
// 安装执行
// ---------------------------------------------------------------------------

export type EnvInstallComponent = 'git' | 'node'

export type EnvInstallPhase = 'download' | 'verify' | 'extract' | 'check' | 'done'

export interface EnvInstallProgress {
  component: EnvInstallComponent
  phase: EnvInstallPhase
  /** 0-100；null = 未知长度/无进度语义（解压、校验等） */
  percent: number | null
  /** 当前尝试的下载主机（换源重试时变化） */
  detail?: string
}

export interface EnvInstallFailure {
  component: EnvInstallComponent
  message: string
}

export interface EnvInstallResult {
  ok: boolean
  /** 成功装好的组件 */
  installed: EnvInstallComponent[]
  /** 失败的组件（重试时只需重装这些） */
  failures: EnvInstallFailure[]
  /** 汇总消息（toast / 对话框共用） */
  message: string
}

/** 组件可执行校验器：返回 null = 通过，否则为错误消息（测试可注入替身） */
export type EnvComponentVerifier = (component: EnvInstallComponent) => string | null

export interface EnvInstallOptions {
  fetchImpl?: FetchLikeX
  caProvider?: CaProvider
  /** env 根目录（默认 <cwd>/env；测试注入临时目录） */
  envRoot?: string
  /** MinGit 镜像 host（默认 activeMirrorHost()；测试注入） */
  mirrorHost?: string
  /** Node 下载源是否镜像优先（默认读 github.enabled；测试注入） */
  nodeMirrorFirst?: boolean
  /** 组件校验器（默认真实执行 exe --version；测试注入替身） */
  verifier?: EnvComponentVerifier
}

/** 下载整体超时：慢网下 40MB 也在分钟级完成，10 分钟兜底防挂死 */
const DOWNLOAD_TIMEOUT_MS = 600_000
/** SHASUMS256.txt 抓取超时（小文件） */
const SHASUMS_TIMEOUT_MS = 30_000
const USER_AGENT = 'SillyTavernLauncher/1.0'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 下载组件并安装进 env/。组件间相互独立：单个组件所有候选源都失败时记入
 * failures 并继续下一个组件（部分成功是合法终态，重试只装剩余项）。
 */
export async function installEnvComponents(
  components: readonly EnvInstallComponent[],
  onProgress?: (progress: EnvInstallProgress) => void,
  options: EnvInstallOptions = {},
): Promise<EnvInstallResult> {
  const envRoot = options.envRoot ?? resolvePortableEnv().baseDir
  const paths = resolvePortableEnv(envRoot)
  const mirrorHost = options.mirrorHost ?? activeMirrorHost()
  const nodeMirrorFirst = options.nodeMirrorFirst ?? readMirrorState().enabled
  const verifier = options.verifier ?? ((component) => verifyComponent(component, paths))

  mkdirSync(envRoot, { recursive: true })

  const installed: EnvInstallComponent[] = []
  const failures: EnvInstallFailure[] = []

  for (const component of components) {
    const progress = (p: Omit<EnvInstallProgress, 'component'>): void => {
      onProgress?.({ component, ...p })
    }
    const urls =
      component === 'git'
        ? minGitDownloadUrls(mirrorHost)
        : nodeDownloadSources(nodeMirrorFirst).map((s) => s.zipUrl)
    const zipName = component === 'git' ? GIT_ZIP_NAME : NODE_ZIP_NAME
    const stripPrefix = component === 'git' ? '' : NODE_STRIP_PREFIX

    const tempDir = mkdtempSync(join(tmpdir(), 'stlenv'))
    try {
      let lastError = '无可用下载源'
      for (const url of urls) {
        try {
          const zipPath = join(tempDir, zipName)
          progress({ phase: 'download', percent: 0, detail: hostOf(url) })
          await downloadToFile(
            url,
            zipPath,
            (received, total) =>
              progress({
                phase: 'download',
                percent: total > 0 ? Math.floor((received * 100) / total) : null,
                detail: hostOf(url),
              }),
            options,
          )

          if (component === 'node') {
            progress({ phase: 'verify', percent: null, detail: hostOf(url) })
            await verifyNodeZipSha256(zipPath, url, zipName, options)
          }

          progress({ phase: 'extract', percent: null, detail: hostOf(url) })
          extractZipToDir(zipPath, envRoot, stripPrefix)

          progress({ phase: 'check', percent: null, detail: hostOf(url) })
          const verifyError = verifier(component)
          if (verifyError !== null) throw new Error(verifyError)

          progress({ phase: 'done', percent: 100 })
          installed.push(component)
          break
        } catch (err) {
          lastError = errMsg(err)
          logError(`[envInstaller] ${component} 自 ${hostOf(url)} 安装失败: ${lastError}`)
          // 清掉半成品 zip，下一候选源从干净状态重试
          rmSync(join(tempDir, zipName), { force: true })
        }
      }
      if (!installed.includes(component)) {
        failures.push({ component, message: lastError })
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  const nameOf = (c: EnvInstallComponent): string => (c === 'git' ? 'Git' : 'Node.js')
  if (failures.length === 0) {
    const names = installed.map(nameOf).join('、')
    return { ok: true, installed, failures, message: `内置环境安装完成（${names}）` }
  }
  const failText = failures.map((f) => `${nameOf(f.component)}：${f.message}`).join('；')
  const partialNote = installed.length > 0 ? `；已装好：${installed.map(nameOf).join('、')}` : ''
  return { ok: false, installed, failures, message: `安装失败：${failText}${partialNote}` }
}

// ---------------------------------------------------------------------------
// 下载（流式落盘 + 进度回调）
// ---------------------------------------------------------------------------

/**
 * GET 下载到文件：流式写盘（不在内存里囤整个包），按 chunk 回调累计字节。
 * total 为 0（无 Content-Length）时回调 total=0，调用方显示不确定进度。
 */
async function downloadToFile(
  url: string,
  destPath: string,
  onBytes: (received: number, total: number) => void,
  options: Pick<EnvInstallOptions, 'fetchImpl' | 'caProvider'>,
): Promise<void> {
  const response = await fetchWithTlsFallback(
    url,
    {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    },
    { fetchImpl: options.fetchImpl, caProvider: options.caProvider },
  )
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  if (response.body === null) throw new Error('响应无内容')

  const total = Number(response.headers.get('Content-Length') ?? 0)
  const reader = response.body.getReader()
  const out = createWriteStream(destPath)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      onBytes(received, total)
      if (!out.write(value)) await once(out, 'drain')
    }
    out.end()
    await once(out, 'finish')
  } catch (err) {
    out.destroy()
    throw err
  }
}

/** 抓取 SHASUMS256.txt 文本（与 zip 同源） */
async function fetchShasumsText(
  shasumsUrl: string,
  options: Pick<EnvInstallOptions, 'fetchImpl' | 'caProvider'>,
): Promise<string> {
  const response = await fetchWithTlsFallback(
    shasumsUrl,
    {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(SHASUMS_TIMEOUT_MS),
    },
    { fetchImpl: options.fetchImpl, caProvider: options.caProvider },
  )
  if (!response.ok) throw new Error(`SHA256 清单下载失败 HTTP ${String(response.status)}`)
  return response.text()
}

/** 从 SHASUMS256.txt 文本解析目标文件的期望哈希（找不到条目返回 null） */
export function parseExpectedSha256(shasumsText: string, fileName: string): string | null {
  const re = new RegExp(`^([0-9a-fA-F]{64})\\s+\\*?${fileName}$`, 'm')
  const m = re.exec(shasumsText)
  return m ? m[1].toLowerCase() : null
}

/** Node zip 的 SHA256 校验：同源拉 SHASUMS256.txt，与落盘文件哈希不一致即抛错 */
async function verifyNodeZipSha256(
  zipPath: string,
  zipUrl: string,
  zipName: string,
  options: Pick<EnvInstallOptions, 'fetchImpl' | 'caProvider'>,
): Promise<void> {
  if (!zipUrl.endsWith(zipName)) throw new Error('无法推导 SHA256 清单地址')
  const shasumsUrl = zipUrl.slice(0, zipUrl.length - zipName.length) + 'SHASUMS256.txt'
  const expected = parseExpectedSha256(await fetchShasumsText(shasumsUrl, options), zipName)
  if (expected === null) throw new Error('SHA256 清单中无对应条目')
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  if (actual !== expected) throw new Error('SHA256 校验失败（文件损坏或被篡改）')
}

// ---------------------------------------------------------------------------
// 解压（fflate，Zip-Slip 遏制；Node zip 剥离顶层目录）
// ---------------------------------------------------------------------------

/**
 * 把 zip 解压到 targetDir：
 * - stripPrefix 非空时要求每个 entry 都以它开头（版本结构防错配），剥离后落目标根；
 * - 逐 entry realpath 遏制，越界路径抛错（与 extensions.installFromZip 同一语义）。
 */
export function extractZipToDir(zipPath: string, targetDir: string, stripPrefix = ''): void {
  const entries = unzipSync(readFileSync(zipPath))
  const realTarget = realpathBestEffort(targetDir)
  for (const [member, data] of Object.entries(entries)) {
    if (member.endsWith('/')) continue // 目录 entry（写入时按需 mkdir）
    let rel = member
    if (stripPrefix !== '') {
      if (!member.startsWith(stripPrefix)) {
        throw new Error(`ZIP 结构与预期不符（entry 缺少顶层前缀）: ${member}`)
      }
      rel = member.slice(stripPrefix.length)
    }
    if (rel.length === 0) continue
    const destPath = realpathBestEffort(resolve(targetDir, rel))
    if (!isPathUnder(realTarget, destPath)) {
      throw new Error(`ZIP 包含不安全的路径: ${member}`)
    }
    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(destPath, data)
  }
}

// ---------------------------------------------------------------------------
// 装后校验（真实执行；测试经 options.verifier 注入替身）
// ---------------------------------------------------------------------------

function verifyComponent(
  component: EnvInstallComponent,
  paths: ReturnType<typeof resolvePortableEnv>,
): string | null {
  if (component === 'git') {
    if (!existsSync(paths.gitExe)) return `解压后未找到 ${paths.gitExe}`
    return runVersionCheck(paths.gitExe, 'git')
  }
  if (!existsSync(paths.nodeExe)) return `解压后未找到 ${paths.nodeExe}`
  if (!existsSync(paths.npmCmd)) return `解压后未找到 ${paths.npmCmd}`
  return runVersionCheck(paths.nodeExe, 'node')
}

/** 执行 `<exe> --version`：git 只认退出码；node 额外校验 ≥18（与 probeSystemNode 同口径） */
function runVersionCheck(exePath: string, kind: 'git' | 'node'): string | null {
  try {
    const result = spawnSyncCmd([exePath, '--version'])
    if (result.exitCode !== 0) return `${kind} 运行校验失败（exit=${String(result.exitCode)}）`
    if (kind === 'node') {
      const version = result.stdout.trim().replace(/^v/, '')
      if (compareVersions(version, '18.0.0') < 0) return `Node 版本过低: ${version}`
    }
    return null
  } catch (err) {
    return `${kind} 运行校验异常: ${errMsg(err)}`
  }
}
