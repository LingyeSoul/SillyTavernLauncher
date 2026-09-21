/**
 * IsoGit 服务（Embedded-All 设计计划 §8 / D2 / D6，Phase 4）。
 *
 * 职责：
 * - fetch 桥接 http 插件（F5/F6 实测方案）：isomorphic-git 的 GitHttpRequest/
 *   GitHttpResponse 契约 ↔ 平台 fetch；TLS 策略整体复用 httpClient.ts 的
 *   fetchWithTlsFallback（首次失败且 isTlsVerifyError → Bun 私有 tls.ca 重试一次）；
 * - StRepoOps 接口（§8.2 签名逐字对齐）：embedded（IsoGitOps，进程内 isomorphic-git）
 *   与 portable/system（SpawnGitOps，包装 git.ts 既有行为）双实现共契约，
 *   stLifecycle 依赖接口而非实现；
 * - 镜像加速（D6）：内存 URL 前缀 https://<mirror>/<url>（与 extensions.ts 的
 *   applyGithubMirror 同构），绝不改写 gitconfig；
 * - onProgress → 合成终端日志行（「正在接收对象 x/y」，500ms 节流）注入 onLog。
 *
 * 纪律：
 * - git.ts / httpClient.ts 本体不改，仅 import 复用（D3 零回归红线）；
 * - 所有失败 try-catch 收口为 BoolMessage，绝不静默吞噬（errorLog 记录）；
 * - fetchImpl / caProvider / getMirror 全部可注入——单元测试不打网络（AGENTS 纪律）。
 */
import * as nodeFs from 'node:fs'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  checkout as isoCheckout,
  clone as isoClone,
  fastForward as isoFastForward,
  fetch as isoFetch,
  getConfig as isoGetConfig,
  listFiles as isoListFiles,
  listTags as isoListTags,
  log as isoLog,
  readCommit as isoReadCommit,
  readObject as isoReadObject,
  readTag as isoReadTag,
  resolveRef as isoResolveRef,
  setConfig as isoSetConfig,
  statusMatrix as isoStatusMatrix,
  writeRef as isoWriteRef,
} from 'isomorphic-git'
import type {
  GitHttpRequest,
  GitHttpResponse,
  HttpClient,
  ProgressCallback,
  StatusRow,
} from 'isomorphic-git'
import {
  fetchWithTlsFallback,
  getWindowsCaPem,
  type CaProvider,
  type FetchInitX,
  type FetchLikeX,
} from './httpClient'
import { TAG_NAME_RE, VERSION_TAG_RE, normalizeVersion, versionGte1130 } from './git'
import { compareVersions } from './env'
import { errMsg, logError } from './errorLog'
import { activeMirrorHost, applyMirrorPrefix } from './mirrors'
import type { BoolMessage, TagsResult } from './types'

// ---------------------------------------------------------------------------
// fetch 桥接 http 插件（F5/F6：进程内 Git 的唯一 TLS 通道）
// ---------------------------------------------------------------------------

/** 桥接插件可注入项（测试 mock fetch / caProvider，不打网络） */
export interface IsoFetchPluginOptions {
  /** fetch 实现（默认平台 fetch；测试注入） */
  fetchImpl?: FetchLikeX
  /** Windows 系统 CA PEM 提供者（默认 getWindowsCaPem；测试注入） */
  caProvider?: CaProvider
}

/**
 * 请求 body 收集为单个 Uint8Array（合并 body 使 fetch 发出 Content-Length，
 * 对齐官方 node 插件 "send it as a single buffer" 的行为）。
 * iso 1.42.2 实际传入形态是 Uint8Array 数组（`body: [packbuffer]`，.d.ts 的
 * AsyncIterableIterator 声明滞后）——数组 / 异步迭代器 / 带 next 的对象都兼容。
 */
async function collectAsyncIterable(
  input: AsyncIterableIterator<Uint8Array> | Uint8Array[],
): Promise<Uint8Array<ArrayBuffer>> {
  const buffers: Uint8Array[] = []
  if (Array.isArray(input)) {
    buffers.push(...input.filter((chunk) => chunk.byteLength > 0))
  } else {
    for (;;) {
      const { value, done } = await input.next()
      if (done) break
      if (value !== undefined && value.byteLength > 0) buffers.push(value)
    }
  }
  let size = 0
  for (const buffer of buffers) size += buffer.byteLength
  const result = new Uint8Array(new ArrayBuffer(size))
  let offset = 0
  for (const buffer of buffers) {
    result.set(buffer, offset)
    offset += buffer.byteLength
  }
  return result
}

/** ReadableStream → 异步迭代器（契约要求 GitHttpResponse.body 为 AsyncIterableIterator；
 *  手写 reader 轮询，跨 Bun/Node 通用且不依赖平台的 stream asyncIterator 支持） */
function streamToAsyncIterator(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader()
  return {
    async next() {
      const { value, done } = await reader.read()
      if (done) return { value: undefined, done: true as const }
      return { value, done: false as const }
    },
    async return() {
      try {
        await reader.cancel()
      } catch {
        // 已释放
      }
      return { value: undefined, done: true as const }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/**
 * isomorphic-git http 插件：契约对齐 GitHttpRequest/GitHttpResponse。
 * - 请求 body（异步迭代器）→ 收集单个 Uint8Array；
 * - 响应 body（ReadableStream）→ 异步迭代器；
 * - 响应头小写化（fetch Headers.entries 天然小写，此处兜底保证契约）；
 * - TLS：复用 fetchWithTlsFallback——首次 fetch 失败且 isTlsVerifyError 时以
 *   Bun 私有 `tls: { ca: await getWindowsCaPem() }` 重试一次（F5 实测：劫持网络
 *   下 node:https Agent 不透传 ca，F6，fetch 桥接是唯一通道）。
 */
export function createIsoFetchPlugin(options: IsoFetchPluginOptions = {}): HttpClient {
  const fetchImpl: FetchLikeX = options.fetchImpl ?? (fetch as unknown as FetchLikeX)
  // 默认真接 getWindowsCaPem（F6 契约：劫持网络下 TLS 回退是 embedded Git 的唯一
  // 生存通道）；非 Windows / 导出失败时 provider 返回 null，回退自然放弃，无害
  const caProvider = options.caProvider ?? getWindowsCaPem
  return {
    request: async (request: GitHttpRequest): Promise<GitHttpResponse> => {
      const method = request.method ?? 'GET'
      const init: FetchInitX = {
        method,
        headers: request.headers,
        // POST body 收集为单缓冲（Content-Length 必需；官方 node 插件同语义）
        body: request.body ? await collectAsyncIterable(request.body) : undefined,
        // 官方 node 插件经 simple-get 默认跟随重定向——fetch 默认 'follow' 对齐
        redirect: 'follow',
      }
      const response = await fetchWithTlsFallback(request.url, init, { fetchImpl, caProvider })
      const headers: Record<string, string> = {}
      for (const [key, value] of response.headers.entries()) {
        headers[key.toLowerCase()] = value
      }
      return {
        url: request.url,
        method,
        headers,
        body: response.body ? streamToAsyncIterator(response.body) : undefined,
        statusCode: response.status,
        statusMessage: response.statusText,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 镜像 URL 前缀（D6：内存前缀，与 extensions.applyGithubMirror 同构，勿动 gitconfig）
// ---------------------------------------------------------------------------

/**
 * GitHub 官方 URL → 镜像前缀 URL（D6）。
 * DEVIATION（2026-09-21 镜像增强）：名单与前缀规则收敛到 mirrors.applyMirrorPrefix
 * （原先此处硬编码两站白名单）；'github' / 空 / 注册表外主机名 → 原样返回，与
 * extensions.applyGithubMirror 的失败语义（不加速）保持一致。
 */
export function applyStMirrorPrefix(url: string, mirror: string): string {
  return applyMirrorPrefix(url, mirror)
}

// ---------------------------------------------------------------------------
// StRepoOps 接口（设计计划 §8.2 签名逐字对齐）
// ---------------------------------------------------------------------------

/**
 * StRepoOps 操作结果：仓库 BoolMessage 惯例 + exitCode。
 * exitCode = null 表示进程创建失败（仅 spawn 实现有此形态，对齐
 * installSt 原有的 `pullProcess ? exitCode : null` 区分）；iso 实现恒 0/1。
 */
export type RepoOpResult = BoolMessage & { exitCode: number | null }

/**
 * ST 仓库 Git 操作契约（embedded 与 spawn 双实现共契约；stLifecycle 依赖本接口）。
 * 语义对照（设计计划 §8.2）：
 * - cloneRelease：ref 'release' 全量克隆（带 tags；F5 实测 103 tags）；
 * - fetchOrigin：抓取 origin 全部分支 + tags；
 * - pullFastForward：fetch + fastForward；非快进 → backup/ 快照 + reset --hard
 *   （对齐 spawn 路径 package-lock 冲突恢复的防御语义，embedded 无 rebase）；
 * - checkoutTag：statusMatrix 脏检查（白名单 package-lock.json + bun.lock 兜底）
 *   → checkout + reset --hard；
 * - statusPorcelain：statusMatrix 合成 `git status --porcelain` 形态，
 *   供既有 checkGitStatus 白名单逻辑复用；
 * - listTags / currentCommit / setRemote：版本页数据源 / HEAD 校验 / 远程指向。
 */
export interface StRepoOps {
  cloneRelease(url: string, dir: string): Promise<RepoOpResult>
  fetchOrigin(dir: string): Promise<RepoOpResult>
  pullFastForward(dir: string): Promise<RepoOpResult>
  checkoutTag(tag: string, dir: string): Promise<RepoOpResult>
  statusPorcelain(dir: string): Promise<string>
  listTags(dir: string): Promise<string[]>
  currentCommit(dir: string): Promise<string | null>
  setRemote(url: string, dir: string): Promise<RepoOpResult>
  /**
   * DEVIATION（对设计 §8.2 的扩展）：origin/release 远端跟踪 ref 的 commit。
   * checkForStUpdate 在 spawn 侧用 `git diff release..origin/release`（stLifecycle
   * 直查 runGit）判定差异；embedded 侧无 diff 命令，需等价读取远端 ref。
   * 可选成员：spawn 路径不走本方法（SpawnGitOps 不实现）。
   */
  originReleaseCommit?(dir: string): Promise<string | null>
}

// ---------------------------------------------------------------------------
// porcelain 合成（statusMatrix → `git status --porcelain` v1 形态）
// ---------------------------------------------------------------------------

/**
 * statusMatrix 行 → porcelain XY 状态对；null = 干净行（不输出）。
 * 映射表逐条来自 isomorphic-git statusMatrix 文档的官方对照表：
 * | HEAD | WORKDIR | STAGE | git status --short |
 * （X = index 状态，Y = worktree 状态；?? = 未跟踪）
 */
function statusRowToPorcelain(row: StatusRow): string[] | null {
  const [file, head, workdir, stage] = row
  if (head === 1 && workdir === 1 && stage === 1) return null // 干净
  if (head === 0 && workdir === 2 && stage === 0) return [`?? ${file}`]
  if (head === 0 && workdir === 0 && stage === 3) return [`AD ${file}`]
  if (head === 0 && workdir === 2 && stage === 2) return [`A  ${file}`]
  if (head === 0 && workdir === 2 && stage === 3) return [`AM ${file}`]
  if (head === 1 && workdir === 0 && stage === 0) return [`D  ${file}`]
  if (head === 1 && workdir === 0 && stage === 1) return [` D ${file}`]
  if (head === 1 && workdir === 0 && stage === 3) return [`MD ${file}`]
  if (head === 1 && workdir === 1 && stage === 0) return [`D  ${file}`, `?? ${file}`]
  if (head === 1 && workdir === 1 && stage === 3) return [`MM ${file}`]
  if (head === 1 && workdir === 2 && stage === 0) return [`D  ${file}`, `?? ${file}`]
  if (head === 1 && workdir === 2 && stage === 1) return [` M ${file}`]
  if (head === 1 && workdir === 2 && stage === 2) return [`M  ${file}`]
  if (head === 1 && workdir === 2 && stage === 3) return [`MM ${file}`]
  // 未覆盖组合（如 0,0,0）：保守按未跟踪输出，宁可误报脏也不漏报
  return [`?? ${file}`]
}

/** statusMatrix → porcelain 行序列（纯函数，供等价性测试直接断言）。
 *  输出顺序对齐 git：跟踪区条目（按路径字节序）在前，未跟踪（??，按路径字节序）在后 */
export function synthesizePorcelain(matrix: StatusRow[]): string[] {
  const lines: string[] = []
  for (const row of matrix) {
    const parts = statusRowToPorcelain(row)
    if (parts !== null) lines.push(...parts)
  }
  const byPath = (a: string, b: string): number => {
    const pathA = a.slice(3)
    const pathB = b.slice(3)
    if (pathA < pathB) return -1
    if (pathA > pathB) return 1
    return 0
  }
  const tracked = lines.filter((line) => !line.startsWith('?? ')).sort(byPath)
  const untracked = lines.filter((line) => line.startsWith('?? ')).sort(byPath)
  return [...tracked, ...untracked]
}

// ---------------------------------------------------------------------------
// SpawnGitOps：包装既有 spawn 行为（D3：命令串与现状逐字节一致）
// ---------------------------------------------------------------------------

/** 流式命令执行器（stLifecycle.executeCommand 的绑定形态：返回退出码，null=创建失败） */
export type SpawnCommandExecutor = (command: string, workdir: string) => Promise<number | null>

export interface SpawnGitOpsOptions {
  /** git 可执行文件（portable env/cmd/git.exe 或系统 git） */
  gitExe: string
  /** 命令执行器（必须走 stLifecycle.executeCommand 以保持终端流式日志与命令串） */
  execCommand: SpawnCommandExecutor
}

/**
 * portable/system 模式的 StRepoOps 实现：命令串与 Phase 4 之前逐字节一致
 * （clone/pull/fetch 由 stLifecycle 既有 buildXxxCommand 同构拼装、经原
 * executeCommand 执行；D3 零回归红线由 tests/stLifecycle.test.ts 命令串断言焊死）。
 */
export function createSpawnGitOps(options: SpawnGitOpsOptions): StRepoOps {
  const { gitExe, execCommand } = options
  /** 与 buildGitCloneCommand 同构（url 恒为 ST_REPO_URL，字节一致） */
  const cloneCommand = (url: string): string => `"${gitExe}" clone ${url} -b release`
  const pullCommand = (): string => `"${gitExe}" pull --rebase --autostash`
  const fetchCommand = (): string => `"${gitExe}" fetch --all`

  const exec = async (command: string, workdir: string): Promise<RepoOpResult> => {
    try {
      const exitCode = await execCommand(command, workdir)
      if (exitCode === null) {
        return { ok: false, message: '创建git进程失败', exitCode: null }
      }
      return { ok: exitCode === 0, message: exitCode === 0 ? '成功' : `进程返回错误码: ${exitCode}`, exitCode }
    } catch (err) {
      const message = errMsg(err)
      logError(`[isoGit] spawn git 命令执行异常: ${command} → ${message}`)
      return { ok: false, message, exitCode: 1 }
    }
  }

  return {
    cloneRelease: (url, dir) => exec(cloneCommand(url), dirname(dir)),
    // spawn 路径的 package-lock 冲突恢复链留在 stLifecycle 编排层（重试语义 1:1）
    pullFastForward: (dir) => exec(pullCommand(), dir),
    fetchOrigin: (dir) => exec(fetchCommand(), dir),
    // 纯本地操作在 spawn 模式下不走本接口（stLifecycle 直用 git.ts，D3 不改路径），
    // 此三方法仅满足接口形状——直接以失败结果显式暴露误用，不静默走错通道
    async checkoutTag() {
      return { ok: false, message: 'SpawnGitOps 不支持 checkoutTag（spawn 路径直用 git.ts）', exitCode: 1 }
    },
    async statusPorcelain() {
      throw new Error('SpawnGitOps 不支持 statusPorcelain（spawn 路径直用 git.ts）')
    },
    async listTags() {
      return []
    },
    async currentCommit() {
      return null
    },
    async setRemote() {
      return { ok: false, message: 'SpawnGitOps 不支持 setRemote（spawn 路径直用 git.ts）', exitCode: 1 }
    },
  }
}

// ---------------------------------------------------------------------------
// IsoGitOps：embedded 模式的进程内 Git 实现
// ---------------------------------------------------------------------------

/** 镜像配置读取（默认 configStore github.mirror；测试注入） */
export type MirrorGetter = () => string

export interface IsoGitOpsOptions {
  /** fetch 实现（桥接插件注入；测试 mock，不打网络） */
  fetchImpl?: FetchLikeX
  /** Windows 系统 CA 提供者（默认 httpClient.getWindowsCaPem；测试注入） */
  caProvider?: CaProvider
  /** 镜像配置读取（默认 configStore github.mirror；测试注入） */
  getMirror?: MirrorGetter
  /** 终端日志回调（进度/错误合成行注入；对齐 spawn 链路的用户可见性） */
  onLog?: (message: string) => void
}

/** isomorphic-git 进度阶段 → 终端日志文案 */
const PROGRESS_PHASE_LABELS: Record<string, string> = {
  'Counting objects': '正在统计对象',
  'Compressing objects': '正在压缩对象',
  'Receiving objects': '正在接收对象',
  'Receiving blobs': '正在接收对象',
  'Receiving deltas': '正在接收差异',
  'Resolving deltas': '正在解析差异',
  'Updating files': '正在更新文件',
}

/** 进度日志节流间隔（克隆 ST 全量约数百次回调，终端只留有信息量的行） */
const PROGRESS_LOG_INTERVAL_MS = 500

/** 判定为「网络层失败」的错误（不值得走本地重置兜底）：
 *  isomorphic-git 网络类错误码，或任何非 isomorphic-git 错误（桥接层原生 fetch 异常） */
const NETWORK_ERROR_CODES = new Set([
  'HttpError',
  'SmartHttpError',
  'UrlParseError',
  'UnknownTransportError',
  'EmptyServerResponseError',
  'MaxDepthError',
])

function isIsoGitError(err: unknown): boolean {
  return (err as { isIsomorphicGitError?: boolean } | null | undefined)?.isIsomorphicGitError === true
}

function isNetworkError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true
  // 桥接 fetch 抛出的原生 TypeError/TlsInterceptError 等不是 isomorphic 错误
  return !isIsoGitError(err)
}

/** 快照目录名时间戳（本地时间，可读性优先） */
function backupTimestamp(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * embedded 模式的 StRepoOps 实现 + 扩展安装浅克隆变体 cloneDepth。
 *
 * 镜像策略（D6）：cloneRelease / fetchOrigin / pullFastForward 内部按
 * github.mirror 对官方 URL 做内存前缀（远端 remote.origin.url 恒存官方地址，
 * 与 spawn 模式 insteadOf 语义对齐——外部工具读到的始终是 GitHub）；
 * cloneDepth 接收最终 URL（扩展侧已有自己的 applyGithubMirror 前缀逻辑）。
 */
export class IsoGitOps implements StRepoOps {
  private readonly http: HttpClient
  private readonly caProvider: CaProvider
  private readonly getMirror: MirrorGetter
  private readonly onLog: (message: string) => void

  constructor(options: IsoGitOpsOptions = {}) {
    // CA 默认同 createIsoFetchPlugin：生产链路必须真接 getWindowsCaPem（F6），
    // 此前误默认 () => null 会让劫持网络下的 TLS 回退整链失效（Phase 4 收尾修复）
    this.caProvider = options.caProvider ?? getWindowsCaPem
    this.getMirror = options.getMirror ?? activeMirrorHost
    this.onLog = options.onLog ?? (() => undefined)
    this.http = createIsoFetchPlugin({ fetchImpl: options.fetchImpl, caProvider: this.caProvider })
  }

  private log(message: string): void {
    this.onLog(message)
  }

  /** onProgress → 终端日志行合成（500ms 节流；100% 档必出） */
  private progressLogger(): ProgressCallback {
    let lastLogAt = 0
    return ({ phase, loaded, total }) => {
      const now = Date.now()
      const finished = total > 0 && loaded >= total
      if (!finished && now - lastLogAt < PROGRESS_LOG_INTERVAL_MS) return
      lastLogAt = now
      const label = PROGRESS_PHASE_LABELS[phase] ?? phase
      this.log(total > 0 ? `${label} ${loaded}/${total}` : `${label} ${loaded}`)
    }
  }

  /** 读取 remote.origin.url 并按镜像配置解析出本次操作实际抓取的 URL */
  private async resolveFetchUrl(dir: string): Promise<string> {
    const remoteUrl = await isoGetConfig({ fs: nodeFs, dir, path: 'remote.origin.url' })
    if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) {
      throw new Error('仓库未配置 origin 远程地址')
    }
    return applyStMirrorPrefix(remoteUrl, this.getMirror())
  }

  async cloneRelease(url: string, dir: string): Promise<RepoOpResult> {
    // 目标目录已非空（非 .git-only 残留）→ 直接失败，避免半克隆互相覆盖
    if (existsSync(dir)) {
      try {
        const entries = nodeFs.readdirSync(dir)
        const shaped = entries.length === 0 || (entries.length === 1 && entries[0] === '.git')
        if (!shaped) {
          return { ok: false, message: `目标目录已存在且非空: ${dir}`, exitCode: 1 }
        }
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        logError(`[isoGit] 克隆前清理残留目录失败: ${errMsg(err)}`)
        return { ok: false, message: `清理残留目录失败: ${errMsg(err)}`, exitCode: 1 }
      }
    }
    const effectiveUrl = applyStMirrorPrefix(url, this.getMirror())
    this.log(`正在从 ${url} 安装SillyTavern（进程内 Git）...`)
    try {
      await isoClone({
        fs: nodeFs,
        http: this.http,
        dir,
        url: effectiveUrl,
        ref: 'release',
        onProgress: this.progressLogger(),
      })
      // remote 存镜像前缀会影响外部工具与 ST 自身读到的地址——统一回写官方 URL
      // （实际抓取 URL 每次操作时经 resolveFetchUrl 现算，D6 内存前缀语义）；
      // 仓库本地固化 core.autocrlf=false：iso 写出/比较的是 LF 原生字节，与真 git
      // （受全局 autocrlf=true 影响会做 CRLF 换算）对同一工作区的判定保持一致，
      // 消除外部 git 视角的 CRLF 伪修改（冒烟实测）
      await isoSetConfig({ fs: nodeFs, dir, path: 'remote.origin.url', value: url })
      await isoSetConfig({ fs: nodeFs, dir, path: 'core.autocrlf', value: false })
      return { ok: true, message: 'SillyTavern安装完成', exitCode: 0 }
    } catch (err) {
      const message = errMsg(err)
      logError(`[isoGit] clone 失败: ${message}`)
      // isomorphic-git clone 失败时已自清 .git（#1283）；兜底清残留空目录
      try {
        if (existsSync(dir)) {
          const entries = nodeFs.readdirSync(dir)
          if (entries.length === 0 || (entries.length === 1 && entries[0] === '.git')) {
            rmSync(dir, { recursive: true, force: true })
          }
        }
      } catch (cleanupErr) {
        logError(`[isoGit] 克隆失败后清理残留失败: ${errMsg(cleanupErr)}`)
      }
      return { ok: false, message: `安装失败: ${message}`, exitCode: 1 }
    }
  }

  async fetchOrigin(dir: string): Promise<RepoOpResult> {
    try {
      const url = await this.resolveFetchUrl(dir)
      await isoFetch({
        fs: nodeFs,
        http: this.http,
        dir,
        remote: 'origin',
        url,
        tags: true, // 对齐 git fetch --all 的 tag 透传（版本页数据源）
        onProgress: this.progressLogger(),
      })
      return { ok: true, message: 'Git更新成功', exitCode: 0 }
    } catch (err) {
      const message = errMsg(err)
      logError(`[isoGit] fetch 失败: ${message}`)
      this.log(`Git抓取失败: ${message}`)
      return { ok: false, message, exitCode: 1 }
    }
  }

  /**
   * 工作区脏文件快照 → <dir>/../backup/<name>-<时间戳>/（保留相对路径）。
   * 快照失败视为不可安全重置——返回 false 中止强制路径（宁可不更新也不丢用户数据）。
   */
  private async backupDirtyWorkdir(dir: string): Promise<{ ok: boolean; porcelain: string }> {    try {
      const porcelain = await this.statusPorcelain(dir)
      const dirty = porcelain
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.slice(3))
      if (dirty.length === 0) return { ok: true, porcelain }
      const backupRoot = join(dirname(dir), 'backup', `${basename(dir)}-${backupTimestamp()}`)
      let copied = 0
      for (const relPath of dirty) {
        const source = join(dir, relPath)
        if (!existsSync(source)) continue // 删除类改动无文件可拷
        const target = join(backupRoot, relPath)
        mkdirSync(dirname(target), { recursive: true })
        cpSync(source, target, { force: true })
        copied += 1
      }
      this.log(`已快照 ${copied} 个本地更改文件到 ${backupRoot}`)
      return { ok: true, porcelain }
    } catch (err) {
      logError(`[isoGit] 工作区快照失败: ${errMsg(err)}`)
      this.log(`警告: 本地更改快照失败，已中止强制重置（不丢失更改）: ${errMsg(err)}`)
      return { ok: false, porcelain: '' }
    }
  }

  /**
   * 强制改写前删除「被跟踪的脏文件」（porcelain 非 ?? 行）：文件缺失后
   * checkout 必然重写目标版本——比 stat 顶除更强，亚秒窗口内也确定性生效
   * （调用前必须已快照/白名单放行，删除即"丢弃本地版"的 force 语义本体）。
   * 未跟踪（??）文件不删：对齐 git reset --hard 不动未跟踪文件的行为。
   */
  private deleteTrackedDirtyFiles(dir: string, porcelain: string): void {
    for (const line of porcelain.split('\n')) {
      if (!line.trim() || line.startsWith('?? ')) continue
      try {
        rmSync(join(dir, line.slice(3)), { force: true })
      } catch (err) {
        logError(`[isoGit] 强制改写前删除脏文件失败（checkout 兜底）: ${errMsg(err)}`)
      }
    }
  }

  async pullFastForward(dir: string): Promise<RepoOpResult> {
    let fetchUrl: string
    try {
      fetchUrl = await this.resolveFetchUrl(dir)
    } catch (err) {
      return { ok: false, message: errMsg(err), exitCode: 1 }
    }
    // 前置防御快照：fastForward 的内部 checkout 在脏工作区上可能直接覆盖
    // （iso 无 autostash 语义；spawn 路径的 pull --rebase --autostash 会暂存）。
    // 脏文件先快照留底，无论后续走快进还是强制对齐，用户数据不丢。
    const preBackup = await this.backupDirtyWorkdir(dir)
    if (!preBackup.ok) {
      return { ok: false, message: '本地更改快照失败，已中止更新', exitCode: 1 }
    }
    try {
      // fastForward 内部含 fetch + merge(fastForwardOnly)，即 git pull --ff-only 语义
      await isoFastForward({
        fs: nodeFs,
        http: this.http,
        dir,
        ref: 'release',
        remote: 'origin',
        url: fetchUrl,
        onProgress: this.progressLogger(),
      })
      return { ok: true, message: 'Git更新成功', exitCode: 0 }
    } catch (err) {
      if (isNetworkError(err)) {
        const message = errMsg(err)
        logError(`[isoGit] pull 网络失败: ${message}`)
        return { ok: false, message, exitCode: 1 }
      }
      // 非快进 / 工作区冲突 → 已快照 → reset --hard origin/release
      // （设计 §8.2 防御语义；fastForward 内部 fetch 已更新 refs/remotes/origin/*）
      this.log(`Git更新非快进或存在冲突，强制对齐 origin/release...`)
      try {
        const target = await isoResolveRef({ fs: nodeFs, dir, ref: 'refs/remotes/origin/release' })
        // 快照完成 → 删除被跟踪的脏文件（未跟踪不动，对齐 reset --hard 语义），
        // 确保 force 改写不因 stat 误判跳过（亚秒窗口内确定性生效）
        this.deleteTrackedDirtyFiles(dir, preBackup.porcelain)
        // reset --hard origin/release：分支指针对齐 + checkout force 重写索引与工作区；
        // checkout(ref: 'release') 会将 HEAD 重挂为 refs/heads/release（覆盖 detached HEAD）
        await isoWriteRef({ fs: nodeFs, dir, ref: 'refs/heads/release', value: target, force: true })
        await isoCheckout({ fs: nodeFs, dir, ref: 'release', force: true })
        this.log('已快照本地更改并强制对齐 origin/release')
        return { ok: true, message: '已快照本地更改并强制对齐 origin/release', exitCode: 0 }
      } catch (resetErr) {
        const message = errMsg(resetErr)
        logError(`[isoGit] 强制对齐失败: ${message}`)
        return { ok: false, message: `Git更新失败且强制对齐失败: ${message}`, exitCode: 1 }
      }
    }
  }

  async checkoutTag(tag: string, dir: string): Promise<RepoOpResult> {
    // 防 tag 名注入（对齐 git.ts TAG_NAME_RE 白名单）
    if (!TAG_NAME_RE.test(tag)) {
      return { ok: false, message: `无效的 tag 名称格式: ${tag}`, exitCode: 1 }
    }
    try {
      // 脏检查：白名单 package-lock.json（对齐 checkGitStatus）+ bun.lock 兜底
      // （.git/info/exclude 已消解的 bun.lock 通常不进 porcelain，双保险）
      const porcelain = await this.statusPorcelain(dir)
      const lines = porcelain.split('\n').filter((line) => line.trim().length > 0)
      const dirty = lines.filter(
        (line) => !line.includes('package-lock.json') && !line.includes('bun.lock'),
      )
      if (dirty.length > 0) {
        return { ok: false, message: `检测到${dirty.length}个文件有未提交的更改`, exitCode: 1 }
      }
      // 白名单内被跟踪的改动 → 删除后由 checkout 重写为 tag 版本
      // （= git checkout -- package-lock.json 的自动恢复语义；删除式改写
      //   不受 compareStats 亚秒 stat 误判影响，确定性生效）
      const whitelisted = lines.filter(
        (line) => line.includes('package-lock.json') || line.includes('bun.lock'),
      )
      this.deleteTrackedDirtyFiles(dir, whitelisted.join('\n'))
      // checkout(force) = git checkout <tag> + reset --hard 的合并语义：
      // HEAD 挂到 tag commit（detached，对齐 git 行为）并重写索引与工作区
      await isoCheckout({ fs: nodeFs, dir, ref: tag, force: true })
      this.log(`成功切换到 tag ${tag}`)
      return { ok: true, message: `成功切换到 tag ${tag}`, exitCode: 0 }
    } catch (err) {
      if ((err as { code?: unknown } | null | undefined)?.code === 'NotFoundError') {
        return {
          ok: false,
          message: `切换失败: Tag ${tag} 不存在。\n请先使用更新功能获取最新版本。`,
          exitCode: 1,
        }
      }
      const message = errMsg(err)
      logError(`[isoGit] checkoutTag 失败: ${message}`)
      return { ok: false, message: `切换失败: ${message}`, exitCode: 1 }
    }
  }

  /**
   * statusMatrix 合成 porcelain 形态。忽略文件（.gitignore 与 .git/info/exclude，
   * 含 bun.lock 消解，F4）天然不进结果；未跟踪目录会被逐文件展开（真 git 折叠为
   * `dir/`）——对白名单消费者（includes 判定）语义等价。
   *
   * DEVIATION（上游缺口修补，iso 1.42.2 实测）：compareStats 以秒级 mtime/ctime +
   * size 判定「文件未变」，同秒内同尺寸改写已跟踪文件时会复用暂存 oid —— 且该
   * 误判不随时间自愈（stat 值不再变化），真 git 按 racy-git.txt 对此类条目强制
   * 重哈希。修补：先用 listFiles 枚举跟踪文件，把 mtime 顶到未来 +5s（utimes 顺
   * 带更新 ctime）迫使矩阵按真实内容重哈希——未来时间与索引里的历史 stat 必差
   * ≥1 秒，同秒窗口内也确定性生效。副作用：跟踪文件 mtime 被刷新为未来值（5 秒
   * 后自然回归"过去"，无功能影响）。输出分区对齐 git：跟踪区（路径序）在前、
   * 未跟踪（??）在后。
   */
  async statusPorcelain(dir: string): Promise<string> {
    try {
      const tracked = await isoListFiles({ fs: nodeFs, dir })
      // mtime 顶到未来 +5s：compareStats 任一字段不等即判「文件已变」并重哈希；
      // 未来时间与索引里的历史 mtime 必差 ≥1 秒，绕开秒级取整——即使索引写入
      // 与本次检查同秒也确定性生效（真时间顶到 now 会撞同秒窗口）
      const future = new Date(Date.now() + 5000)
      for (const relPath of tracked) {
        try {
          nodeFs.utimesSync(join(dir, relPath), future, future)
        } catch {
          // 文件已删除/被占用：交给矩阵按缺失/现状处理
        }
      }
    } catch (err) {
      // 非仓库或读树失败：直接走矩阵（矩阵自身的错误语义对外保留）
      logError(`[isoGit] porcelain 前置 stat 顶除失败（继续矩阵路径）: ${errMsg(err)}`)
    }
    // refresh:false——矩阵全程只读索引：顶除产生的伪 stat 绝不回写索引，
    // 否则 refresh 会把未来 mtime 持久化，下一次顶除撞同秒再次误判（实测）
    const matrix = await isoStatusMatrix({ fs: nodeFs, dir, refresh: false })
    return synthesizePorcelain(matrix).join('\n')
  }

  async listTags(dir: string): Promise<string[]> {
    try {
      return await isoListTags({ fs: nodeFs, dir })
    } catch (err) {
      logError(`[isoGit] listTags 失败: ${errMsg(err)}`)
      return []
    }
  }

  async currentCommit(dir: string): Promise<string | null> {
    try {
      return await isoResolveRef({ fs: nodeFs, dir, ref: 'HEAD' })
    } catch (err) {
      logError(`[isoGit] currentCommit 失败: ${errMsg(err)}`)
      return null
    }
  }

  /** origin/release 远端跟踪 commit（checkForStUpdate 的 embedded 差异判定数据源） */
  async originReleaseCommit(dir: string): Promise<string | null> {
    try {
      return await isoResolveRef({ fs: nodeFs, dir, ref: 'refs/remotes/origin/release' })
    } catch (err) {
      logError(`[isoGit] originReleaseCommit 失败: ${errMsg(err)}`)
      return null
    }
  }

  async setRemote(url: string, dir: string): Promise<RepoOpResult> {
    try {
      await isoSetConfig({ fs: nodeFs, dir, path: 'remote.origin.url', value: url })
      return { ok: true, message: `已将远程地址设置为 ${url}`, exitCode: 0 }
    } catch (err) {
      const message = errMsg(err)
      logError(`[isoGit] setRemote 失败: ${message}`)
      return { ok: false, message, exitCode: 1 }
    }
  }

  /**
   * 扩展安装浅克隆变体（设计 §8.3）：depth 1 + singleBranch，URL 为最终值
   * （扩展侧 applyGithubMirror 已应用前缀）。失败时由调用方按扩展语义清理目录。
   */
  async cloneDepth(url: string, dir: string, depth = 1): Promise<RepoOpResult> {
    if (existsSync(dir)) {
      return { ok: false, message: `目标目录已存在: ${dir}`, exitCode: 1 }
    }
    try {
      await isoClone({
        fs: nodeFs,
        http: this.http,
        dir,
        url,
        depth,
        singleBranch: true,
        onProgress: this.progressLogger(),
      })
      // 同 cloneRelease：仓库本地 core.autocrlf=false，外部真 git 视角零 CRLF 歧义
      await isoSetConfig({ fs: nodeFs, dir, path: 'core.autocrlf', value: false })
      return { ok: true, message: '克隆完成', exitCode: 0 }
    } catch (err) {
      const message = errMsg(err)
      logError(`[isoGit] cloneDepth 失败: ${message}`)
      // isomorphic-git 失败已自清 .git；兜底清残留目录（扩展安装要求目录不存在）
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch (cleanupErr) {
        logError(`[isoGit] 浅克隆失败后清理残留失败: ${errMsg(cleanupErr)}`)
      }
      return { ok: false, message, exitCode: 1 }
    }
  }
}

/** IsoGitOps 工厂（与 createSpawnGitOps 命名对称；stLifecycle 路由默认实现） */
export function createIsoGitOps(options: IsoGitOpsOptions = {}): IsoGitOps {
  return new IsoGitOps(options)
}

// ---------------------------------------------------------------------------
// 版本页数据源（embedded）：getStTags / 当前版本芯片 的进程内等价实现
// （设计 §8.2 listTags "版本页数据源" 的消费侧落地：versionState/stState 在
//   embedded 下改调本组函数；过滤/排序语义与 git.ts getStTags 共用助手，防漂移）
// ---------------------------------------------------------------------------

/** tag ref → commit oid（轻量 tag 直指 commit；附注 tag 经 readObject/readTag 剥壳） */
async function resolveTagCommitOid(dir: string, tagName: string): Promise<string | null> {
  try {
    const refOid = await isoResolveRef({ fs: nodeFs, dir, ref: `refs/tags/${tagName}` })
    const { type } = await isoReadObject({ fs: nodeFs, dir, oid: refOid })
    if (type === 'tag') {
      // 附注 tag：ref 指向 tag 对象，剥壳取其目标 commit
      const tag = await isoReadTag({ fs: nodeFs, dir, oid: refOid })
      return tag.tag.object
    }
    return refOid
  } catch (err) {
    logError(`[isoGit] 解析 tag ${tagName} 的 commit 失败: ${errMsg(err)}`)
    return null
  }
}

/** Unix 秒 + 时区偏移分 → git `--format=%aI` 形态（作者日期严格 ISO 8601 带偏移）。
 *  注意 isomorphic-git 的 timezoneOffset 沿用 JS Date.getTimezoneOffset 反号约定
 *  （UTC+8 → -480）：本地墙钟 = timestamp - offset，展示符号 = offset 反号。
 *  零偏移是特例：git 打 `Z` 后缀（`+0000` 作者时间 → "2026-01-02T03:04:05Z"，
 *  实测与 `%ai` 的 "+0000" 形态不同），非零才落 ±HH:MM——UTC 机器上两侧必须逐字节
 *  相等（CI 即 UTC，本地 +08:00 走不到这条分支，见 isoGit.test 的零偏移用例） */
function authorDateIso(timestamp: number, timezoneOffsetMinutes: number): string {
  const shifted = new Date((timestamp - timezoneOffsetMinutes * 60) * 1000)
  const base = shifted.toISOString().replace(/\.\d{3}Z$/, '')
  if (timezoneOffsetMinutes === 0) return `${base}Z`
  const sign = timezoneOffsetMinutes < 0 ? '+' : '-'
  const abs = Math.abs(timezoneOffsetMinutes)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${base}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * getStTags 的 embedded 等价实现（版本页版本列表数据源）：
 * listTags → 语义化版本过滤（≥1.13.0，与 git.ts 共用助手）→ 逐 tag 解析
 * commit 与作者日期 ISO（对齐 `git show <tag> --format=%H|%aI -s`）。
 * 纯本地读，不打网络。
 */
export async function getStTagsEmbedded(stDir?: string): Promise<TagsResult> {
  const dir = stDir ?? join(process.cwd(), 'SillyTavern')
  if (!existsSync(dir)) {
    return { ok: false, data: null, message: 'SillyTavern目录不存在' }
  }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, data: null, message: 'SillyTavern目录不是Git仓库' }
  }
  try {
    const allTags = await isoListTags({ fs: nodeFs, dir })
    const versions: Record<string, { commit: string; date: string; tag_name: string }> = {}
    for (const tag of allTags) {
      const versionStr = normalizeVersion(tag)
      if (!VERSION_TAG_RE.test(versionStr) || !versionGte1130(versionStr)) continue
      const commitOid = await resolveTagCommitOid(dir, tag)
      if (commitOid === null) continue
      const { commit } = await isoReadCommit({ fs: nodeFs, dir, oid: commitOid })
      versions[versionStr] = {
        commit: commitOid,
        date: authorDateIso(commit.author.timestamp, commit.author.timezoneOffset),
        tag_name: tag,
      }
    }
    const latest = Object.keys(versions).sort((a, b) => compareVersions(b, a))[0] ?? ''
    return {
      ok: true,
      data: { versions, latest },
      message: `成功获取 ${Object.keys(versions).length} 个版本`,
    }
  } catch (err) {
    const message = `获取tag列表时出错: ${errMsg(err)}`
    logError(`[isoGit] ${message}`)
    return { ok: false, data: null, message }
  }
}

/**
 * stState.refreshVersion 的 embedded 等价实现（当前版本芯片）：
 * `git describe --tags --abbrev=0` + `git rev-parse HEAD` 的进程内等价——
 * HEAD 精确命中 tag 直接用；否则沿 HEAD 祖先回溯取最近 tag（describe 语义）。
 * 失败/无 tag → version null（对齐 spawn 侧 describe 失败置 null 的行为）。
 */
export async function currentVersionEmbedded(
  stDir?: string,
): Promise<{ version: string | null; commit: string | null }> {
  const dir = stDir ?? join(process.cwd(), 'SillyTavern')
  try {
    const head = await isoResolveRef({ fs: nodeFs, dir, ref: 'HEAD' })
    const allTags = await isoListTags({ fs: nodeFs, dir })
    // commit → tag（后写覆盖：同 commit 多 tag 时取其一，仅影响展示用哪个名字）
    const tagByCommit = new Map<string, string>()
    for (const tag of allTags) {
      const commitOid = await resolveTagCommitOid(dir, tag)
      if (commitOid !== null) tagByCommit.set(commitOid, tag)
    }
    let version = tagByCommit.get(head) ?? null
    if (version === null && tagByCommit.size > 0) {
      const ancestry = await isoLog({ fs: nodeFs, dir, ref: 'HEAD' })
      for (const entry of ancestry) {
        const hit = tagByCommit.get(entry.oid)
        if (hit !== undefined) {
          version = hit
          break
        }
      }
    }
    return { version, commit: head }
  } catch (err) {
    logError(`[isoGit] 读取当前版本失败: ${errMsg(err)}`)
    return { version: null, commit: null }
  }
}
