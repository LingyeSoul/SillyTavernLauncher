/**
 * GitHub 镜像源注册表与选优服务（2026-09-21 镜像增强）。
 *
 * 单一事实源（本模块之前，镜像前缀逻辑散落三处且名单各不相同：
 * updater.withMirrorPrefix 全量前缀 / extensions.applyGithubMirror 两站白名单 /
 * isoGit.applyStMirrorPrefix 两站白名单——新增镜像站要改三处，漏一处即静默不加速）：
 * - 注册表：内置镜像站名单（host 为唯一标识 + 用户实测报告的延迟参考值）；
 * - applyMirrorPrefix：唯一的 URL 前缀实现（旧值 'github'/未知值语义保留为"不加速"）；
 * - 测速：以 SillyTavern 仓库的 git 智能 HTTP 握手端点为探针目标（与真实
 *   clone/fetch 的首个请求同路径同形状），可注入 fetch 使测试零网络；
 * - 选优：自动测速选最快；git 网络出错时把当前镜像判死并切到下一个可达镜像。
 *
 * 状态落在 config.json 的 github.*（enabled/mirror/auto/speedtest）；
 * 所有网络访问经 fetchWithTlsFallback（与 httpClient 同一条 TLS 容错链：
 * Watt Toolkit 之类劫持网络下用系统证书库重试），失败一律 logError 不静默吞噬。
 */
import { connect as netConnect } from 'node:net'
import { IS_WINDOWS, spawnAsync } from './runtime'
import { getConfigStore } from './configStore'
import { errMsg, logError } from './errorLog'
import { fetchWithTlsFallback, type CaProvider, type FetchLikeX } from './httpClient'

/** 官方源哨兵：沿用旧配置语义（'github' = 不使用加速镜像） */
export const OFFICIAL_MIRROR = 'github'

export type MirrorTier = 'fast' | 'medium' | 'legacy'

export interface MirrorSource {
  /** 唯一标识（同时也是前缀主机名，如 gh.dpik.top） */
  host: string
  /** 用户实测报告延迟（ms，仅作首屏排序参考，实测结果优先） */
  reportedMs?: number
  tier: MirrorTier
}

/**
 * 内置镜像站名单（2026-09-21 用户实测报告；host 唯一，顺序即推荐顺序）。
 * fast：报告延迟 < 600ms；medium：600–1100ms；legacy：旧版内置镜像（配置兼容，
 * 报告名单未覆盖，故不给报告值——排序时落在实测有效值之后）。
 */
export const MIRROR_SOURCES: readonly MirrorSource[] = [
  { host: 'github.dpik.top', reportedMs: 497, tier: 'fast' },
  { host: 'gh.ddlc.top', reportedMs: 500, tier: 'fast' },
  { host: 'github-proxy.lixxing.top', reportedMs: 508, tier: 'fast' },
  { host: 'ghp.keleyaa.com', reportedMs: 509, tier: 'fast' },
  { host: 'xiaomo-station.top', reportedMs: 513, tier: 'fast' },
  { host: 'github.boringhex.top', reportedMs: 513, tier: 'fast' },
  { host: 'gh.1k.ink', reportedMs: 514, tier: 'fast' },
  { host: 'git.669966.xyz', reportedMs: 519, tier: 'fast' },
  { host: 'jiashu.1win.eu.org', reportedMs: 521, tier: 'fast' },
  { host: 'ghfile.geekertao.top', reportedMs: 522, tier: 'fast' },
  { host: 'gp.871201.xyz', reportedMs: 523, tier: 'fast' },
  { host: 'ghproxy.xzhouqd.com', reportedMs: 530, tier: 'fast' },
  { host: 'github.1ms.xx.kg', reportedMs: 598, tier: 'fast' },
  { host: 'gh.chalin.tk', reportedMs: 613, tier: 'medium' },
  { host: 'ggg.clwap.dpdns.org', reportedMs: 617, tier: 'medium' },
  { host: 'github.zzrbk.xyz', reportedMs: 619, tier: 'medium' },
  { host: 'gh.shiina-rimo.cafe', reportedMs: 619, tier: 'medium' },
  { host: 'ghm.078465.xyz', reportedMs: 620, tier: 'medium' },
  { host: 'github.ihnic.com', reportedMs: 620, tier: 'medium' },
  { host: 'github.880824.xyz', reportedMs: 621, tier: 'medium' },
  { host: 'gh.jasonzeng.dev', reportedMs: 622, tier: 'medium' },
  { host: 'gh.xxooo.cf', reportedMs: 623, tier: 'medium' },
  { host: 'kenyu.ggff.net', reportedMs: 623, tier: 'medium' },
  { host: 'github.crdz.eu.org', reportedMs: 624, tier: 'medium' },
  { host: 'gh.996986.xyz', reportedMs: 625, tier: 'medium' },
  { host: 'tvv.tw', reportedMs: 626, tier: 'medium' },
  { host: 'proxy.baguoyuyan.com', reportedMs: 626, tier: 'medium' },
  { host: 'gh.monlor.com', reportedMs: 628, tier: 'medium' },
  { host: 'ghproxy.imciel.com', reportedMs: 628, tier: 'medium' },
  { host: 'git.951959483.xyz', reportedMs: 629, tier: 'medium' },
  { host: 'git.820828.xyz', reportedMs: 629, tier: 'medium' },
  { host: 'ghpxy.hwinzniej.top', reportedMs: 631, tier: 'medium' },
  { host: 'ghf.无名氏.top', reportedMs: 635, tier: 'medium' },
  { host: 'hub.ddayh.com', reportedMs: 636, tier: 'medium' },
  { host: 'gh.aaa.team', reportedMs: 643, tier: 'medium' },
  { host: 'getgit.love8yun.eu.org', reportedMs: 644, tier: 'medium' },
  { host: 'github.lsdfxdk.nyc.mn', reportedMs: 644, tier: 'medium' },
  { host: 'gh.198962.xyz', reportedMs: 645, tier: 'medium' },
  { host: 'github.788787.xyz', reportedMs: 645, tier: 'medium' },
  { host: 'git.yylx.win', reportedMs: 652, tier: 'medium' },
  { host: 'fastgit.cc', reportedMs: 653, tier: 'medium' },
  { host: 'gh.chjina.com', reportedMs: 654, tier: 'medium' },
  { host: 'ghproxy.cxkpro.top', reportedMs: 658, tier: 'medium' },
  { host: 'github.ednovas.xyz', reportedMs: 912, tier: 'medium' },
  { host: 'gh-proxy.com', reportedMs: 920, tier: 'medium' },
  { host: 'gh.noki.icu', reportedMs: 1064, tier: 'medium' },
  { host: 'gh.llkk.cc', reportedMs: 1064, tier: 'medium' },
  { host: 'gh.dpik.top', reportedMs: 1065, tier: 'medium' },
  { host: 'gh.con.sh', reportedMs: 1073, tier: 'medium' },
  { host: 'gh.b52m.cn', reportedMs: 1082, tier: 'medium' },
  { host: 'github.mlmle.cn', reportedMs: 1085, tier: 'medium' },
  { host: 'gitproxy.mrhjx.cn', reportedMs: 1086, tier: 'medium' },
  { host: 'down.npee.cn', reportedMs: 1090, tier: 'medium' },
  { host: 'free.cn.eu.org', reportedMs: 1103, tier: 'medium' },
  // 旧版启动器内置镜像（老配置兼容；不在用户实测名单内，无报告值）
  { host: 'gh-proxy.org', tier: 'legacy' },
]

/** host → 注册表项（O(1) 判定） */
const MIRROR_HOST_INDEX = new Map<string, MirrorSource>(MIRROR_SOURCES.map((m) => [m.host, m]))

/** 是否为有效镜像源（注册表命中；空串与 'github' 均否） */
export function isValidMirrorHost(host: string): boolean {
  return MIRROR_HOST_INDEX.has(host)
}

/** 镜像展示名（日志/提示文案；沿用旧版措辞 "xxx镜像" / "GitHub官方源"） */
export function mirrorDisplayName(host: string): string {
  return host.length === 0 || host === OFFICIAL_MIRROR ? 'GitHub官方源' : `${host}镜像`
}

/** 前缀根 URL：`https://<host>/`（IDN 主机名由 URL/fetch 层做 punycode） */
export function mirrorPrefixUrl(host: string): string {
  return `https://${host}/`
}

/** 镜像改写适用范围：GitHub 家族域名（github.com 及其子域、*.githubusercontent.com） */
export function isGithubUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return (
    host === 'github.com' ||
    host.endsWith('.github.com') ||
    host === 'githubusercontent.com' ||
    host.endsWith('.githubusercontent.com')
  )
}

/**
 * GitHub 官方 URL → 镜像前缀 URL（全应用唯一实现）。
 * mirror 为空 / 'github' / 未在注册表内 → 原样返回（不加速；注册表门禁保证
 * 手改配置写错的主机名不会把 git 请求指到不存在的域名）；非 GitHub URL → 原样返回。
 */
export function applyMirrorPrefix(url: string, mirror: string): string {
  if (!isValidMirrorHost(mirror)) return url
  if (!isGithubUrl(url)) return url
  return `${mirrorPrefixUrl(mirror)}${url}`
}

// ---------------------------------------------------------------------------
// 状态（config.json github.*）
// ---------------------------------------------------------------------------

/** 测速结果快照（results 只含成功项；failed 为实测不可用主机，选优时跳过） */
export interface MirrorSpeedTest {
  results: Record<string, number>
  failed: string[]
  /** 最近一次测速时间（ISO）；'' = 从未测速 */
  tested_at: string
}

export interface MirrorState {
  /** 是否启用加速镜像（false = 官方源） */
  enabled: boolean
  /** 选中镜像 host；'' = 尚未选定（自动选优未完成） */
  host: string
  /** true = 自动测速选优 + 故障自动切换；用户手动选定后置 false */
  auto: boolean
  speedtest: MirrorSpeedTest
}

/** configStore 读写面（测试可注入替身，避免触碰真实 config.json） */
export interface MirrorStoreLike {
  get: <T = unknown>(key: string, defaultValue?: T) => T
  set: (key: string, value: unknown) => void
  save: () => void
}

export const EMPTY_SPEED_TEST: MirrorSpeedTest = { results: {}, failed: [], tested_at: '' }

/** 脏配置归一：results 只保留有限正数，failed 只保留字符串 */
export function normalizeSpeedTest(raw: unknown): MirrorSpeedTest {
  if (raw === null || typeof raw !== 'object') return { ...EMPTY_SPEED_TEST }
  const source = raw as { results?: unknown; failed?: unknown; tested_at?: unknown }
  const results: Record<string, number> = {}
  if (source.results !== null && typeof source.results === 'object') {
    for (const [host, value] of Object.entries(source.results as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) results[host] = value
    }
  }
  const failed = Array.isArray(source.failed)
    ? source.failed.filter((item): item is string => typeof item === 'string')
    : []
  return {
    results,
    failed,
    tested_at: typeof source.tested_at === 'string' ? source.tested_at : '',
  }
}

export function readMirrorState(store: MirrorStoreLike = getConfigStore()): MirrorState {
  return {
    enabled: store.get<boolean>('github.enabled', false),
    host: store.get<string>('github.mirror', ''),
    auto: store.get<boolean>('github.auto', true),
    speedtest: normalizeSpeedTest(store.get('github.speedtest')),
  }
}

/** 写回状态（失败只记日志；返回是否落盘成功） */
export function writeMirrorState(
  patch: Partial<MirrorState>,
  store: MirrorStoreLike = getConfigStore(),
): boolean {
  try {
    if (patch.enabled !== undefined) store.set('github.enabled', patch.enabled)
    if (patch.host !== undefined) store.set('github.mirror', patch.host)
    if (patch.auto !== undefined) store.set('github.auto', patch.auto)
    if (patch.speedtest !== undefined) store.set('github.speedtest', patch.speedtest)
    store.save()
    return true
  } catch (err) {
    logError(`[mirrors] 镜像配置保存失败: ${errMsg(err)}`)
    return false
  }
}

/**
 * 当前生效的镜像 host（全应用唯一读取口）：
 * 未启用 / 未选定 / 主机名不在注册表内 → 官方源（fail-safe，绝不把 git 请求
 * 指向未知域名）。
 */
export function activeMirrorHost(store: MirrorStoreLike = getConfigStore()): string {
  const state = readMirrorState(store)
  if (!state.enabled) return OFFICIAL_MIRROR
  if (!isValidMirrorHost(state.host)) return OFFICIAL_MIRROR
  return state.host
}

// ---------------------------------------------------------------------------
// 测速（ping 为主，真实请求仅用于故障取证）
// ---------------------------------------------------------------------------

/**
 * 探针目标：SillyTavern 仓库的 git 智能 HTTP 握手端点（`info/refs`）。
 * 与真实 clone/fetch/pull 的首个请求同路径同形状——仅用于**故障取证**
 * （failoverMirror 里对当前镜像发一次），批量测速一律走 ping（见下）。
 */
export const MIRROR_PROBE_TARGET =
  'https://github.com/SillyTavern/SillyTavern/info/refs?service=git-upload-pack'

export function mirrorProbeUrl(host: string): string {
  return `${mirrorPrefixUrl(host)}${MIRROR_PROBE_TARGET}`
}

/** 单站测速超时（用户实测延迟集中在 0.5–1.1s，3s 足够容纳慢站与一次换证书重试） */
export const MIRROR_PROBE_TIMEOUT_MS = 3000

/** 全量测速并发（55 站：并发 8 时最坏十几秒，通常数秒内出全部结果） */
export const MIRROR_TEST_CONCURRENCY = 8

/** ping 发包数（两包取最小值，兼顾抖动与耗时） */
export const MIRROR_PING_PACKETS = 2

/** ping 单包等待上限 */
export const MIRROR_PING_TIMEOUT_MS = 1000

/** 批量测速用的探针：host → 延迟 ms；不可达（超时/DNS 失败/进程失败）→ null */
export type MirrorProbe = (host: string) => Promise<number | null>

/** 真实请求探针（故障取证）配置 */
export interface MirrorProbeOptions {
  /** fetch 实现（默认平台 fetch；测试注入） */
  fetchImpl?: FetchLikeX
  /** 系统证书库 PEM 提供者（默认 httpClient.getWindowsCaPem；测试注入） */
  caProvider?: CaProvider
  timeoutMs?: number
  /** 计时器（测试注入假时钟） */
  now?: () => number
}

/** ping 探针配置 */
export interface MirrorPingOptions {
  /** 单包等待上限（默认 1000ms） */
  timeoutMs?: number
  /** 发包数（默认 2） */
  packets?: number
  /** 计时器（测试注入假时钟） */
  now?: () => number
  /** ping 输出读取（默认 runtime.spawnAsync 起系统 ping；测试注入假输出） */
  runPing?: (host: string, packets: number, timeoutMs: number) => Promise<string>
  /** TCP 443 握手计时（默认 node:net；测试注入） */
  tcpProbe?: (host: string, timeoutMs: number) => Promise<number | null>
}

/**
 * 真实现（故障取证专用）：GitHub 家族 URL 经镜像前缀后 GET，只认 200。
 * 只在 git 网络操作已经失败后对当前镜像发一次——不用于批量测速（批量走 ping，
 * 避免为每个镜像站拉起真实代理请求浪费服务器资源）。
 */
export function createMirrorProbe(options: MirrorProbeOptions = {}): MirrorProbe {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLikeX)
  const timeoutMs = options.timeoutMs ?? MIRROR_PROBE_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  return async (host: string): Promise<number | null> => {
    if (!isValidMirrorHost(host)) return null
    const startedAt = now()
    try {
      const response = await fetchWithTlsFallback(
        mirrorProbeUrl(host),
        {
          method: 'GET',
          headers: { 'User-Agent': 'SillyTavernLauncher/1.0' },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        },
        { fetchImpl, caProvider: options.caProvider },
      )
      const elapsed = now() - startedAt
      if (response.status !== 200) return null
      // 读取并丢弃响应体：确保计时覆盖到真实数据传输（部分代理先回头后拉源站）
      try {
        await response.arrayBuffer()
      } catch {
        // 体读取失败不改变已达成的 HTTP 200 结论（延迟仍有效）
      }
      return elapsed
    } catch (err) {
      logError(`[mirrors] ${host} 真实请求取证失败: ${errMsg(err)}`)
      return null
    }
  }
}

/**
 * ping 输出 → 延迟 ms（取最小值，抗单包抖动；无匹配 = 不可达）。
 * 只匹配「数值 + ms」这一跨语言稳定的片段（zh "时间=23ms" / en "time=23ms" /
 * fr "temps=23 ms" 均命中），不依赖任何 UI 语言文案；`,` 小数分隔符归一为 `.`。
 */
export function parsePingLatency(output: string): number | null {
  const times: number[] = []
  const re = /[=<>]\s*(\d+(?:[.,]\d+)?)\s*ms/gi
  for (const match of output.matchAll(re)) {
    const value = Number((match[1] ?? '').replace(',', '.'))
    if (Number.isFinite(value)) times.push(value)
  }
  if (times.length === 0) return null
  return Math.min(...times)
}

/** 非 ASCII 主机名（IDN，如 ghf.无名氏.top）→ punycode：ping/DNS 层不接受原字面量 */
export function toAsciiHost(host: string): string {
  try {
    return new URL(`https://${host}/`).hostname
  } catch {
    return host
  }
}

/** 默认 ping 执行：系统 ping 二包（Windows -n/-w，POSIX -c/-W），超时硬杀 */
async function defaultRunPing(host: string, packets: number, timeoutMs: number): Promise<string> {
  const target = toAsciiHost(host)
  const cmd = IS_WINDOWS
    ? ['ping', '-n', String(packets), '-w', String(timeoutMs), target]
    : ['ping', '-c', String(packets), '-W', String(Math.ceil(timeoutMs / 1000)), target]
  const proc = spawnAsync({ cmd, windowsHide: true })
  // 硬超时兜底：分包等待之外再留一倍余量（进程挂死时不阻塞整轮测速）
  const budget = timeoutMs * packets + 2000
  const timer = setTimeout(() => proc.kill(), budget)
  try {
    const [, stdout] = await Promise.all([proc.exited, streamText(proc.stdout)])
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

/** 默认 TCP 443 握手计时（ICMP 被屏蔽的站用它区分「主机活着」与「真不可达」） */
function defaultTcpProbe(host: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const socket = netConnect({ host: toAsciiHost(host), port: 443 })
    const finish = (value: number | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(Date.now() - startedAt))
    socket.once('timeout', () => finish(null))
    socket.once('error', () => finish(null))
  })
}

/**
 * ping 探针（批量测速/选优的默认实现）：
 * ① ICMP（系统 ping，零服务端应用层负载，不消耗镜像站带宽）；
 * ② ICMP 无回复但 TCP 443 可握手 → 用 TCP 握手耗时（部分 CDN/防火墙屏蔽 ICMP，
 *    直接判死会把可用镜像误杀；TCP 通至少证明主机与端口活着）；
 * ③ 两者皆无 → 不可达。
 */
export function createMirrorPingProbe(options: MirrorPingOptions = {}): MirrorProbe {
  const timeoutMs = options.timeoutMs ?? MIRROR_PING_TIMEOUT_MS
  const packets = options.packets ?? MIRROR_PING_PACKETS
  const runPing = options.runPing ?? defaultRunPing
  const tcpProbe = options.tcpProbe ?? defaultTcpProbe
  return async (host: string): Promise<number | null> => {
    if (!isValidMirrorHost(host)) return null
    try {
      const output = await runPing(host, packets, timeoutMs)
      const icmp = parsePingLatency(output)
      if (icmp !== null) return Math.round(icmp)
    } catch (err) {
      // ping 不可用（无该命令/被策略拦截）→ 落到 TCP 兜底，不因环境缺 ping 判死
      logError(`[mirrors] ${host} ping 执行失败，改用 TCP 握手计时: ${errMsg(err)}`)
    }
    try {
      return await tcpProbe(host, timeoutMs + 1000)
    } catch (err) {
      logError(`[mirrors] ${host} TCP 握手计时失败: ${errMsg(err)}`)
      return null
    }
  }
}

export interface SpeedTestOptions {
  probe: MirrorProbe
  concurrency?: number
  /** 每完成一站回调一次（UI 渐进展示；results/failed 为当前累计快照） */
  onResult?: (host: string, latencyMs: number | null) => void
  now?: () => Date
}

/** 全量测速（默认 ping 探针）：并发受限，成功项进 results、失败项进 failed；不改变选中项 */
export async function speedTestMirrors(
  hosts: readonly string[],
  options: SpeedTestOptions,
): Promise<MirrorSpeedTest> {
  const concurrency = Math.max(1, options.concurrency ?? MIRROR_TEST_CONCURRENCY)
  const results: Record<string, number> = {}
  const failed: string[] = []
  const queue = hosts.filter((host) => isValidMirrorHost(host))
  let cursor = 0

  const worker = async (): Promise<void> => {
    // 显式游标取号：多 worker 共享队列（JS 单线程，取号与自增之间无 await）
    while (cursor < queue.length) {
      const host = queue[cursor]
      cursor += 1
      let latency: number | null = null
      try {
        latency = await options.probe(host)
      } catch (err) {
        logError(`[mirrors] ${host} 测速异常: ${errMsg(err)}`)
        latency = null
      }
      if (latency === null) failed.push(host)
      else results[host] = latency
      options.onResult?.(host, latency)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()))
  return {
    results,
    failed,
    tested_at: (options.now?.() ?? new Date()).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// 选优与故障切换
// ---------------------------------------------------------------------------

/** 自动选优/切换的候选批次大小（并行探测数；一批全灭才试下一批） */
export const MIRROR_CANDIDATE_BATCH = 6

/** 自动选优最多试几批（6×3=18 站；全灭则判定无可用镜像，避免无谓打满 55 站） */
export const MIRROR_AUTO_BATCH_LIMIT = 3

/** 已选定镜像的结果保鲜期：期内启动不再重测（12h） */
export const MIRROR_SELECTION_TTL_MS = 12 * 60 * 60 * 1000

/** 从测速结果挑最快（跳过 exclude；并列时按注册表次序，保证结果稳定可测） */
export function pickFastestMirror(
  results: Record<string, number>,
  exclude: Iterable<string> = [],
): { host: string; latencyMs: number } | null {
  const excluded = new Set(exclude)
  let best: { host: string; latencyMs: number } | null = null
  for (const source of MIRROR_SOURCES) {
    // 显式标注：注册表读取在 strict 下需保留 undefined 分支（缺测速结果的站不入选）
    const latencyMs: number | undefined = results[source.host]
    if (latencyMs === undefined || excluded.has(source.host)) continue
    if (best === null || latencyMs < best.latencyMs) best = { host: source.host, latencyMs }
  }
  return best
}

/** 候选镜像（注册表顺序 = fast → medium → legacy；failed 跳过） */
export function orderedCandidates(speedtest: MirrorSpeedTest): MirrorSource[] {
  const failed = new Set(speedtest.failed)
  return MIRROR_SOURCES.filter((source) => !failed.has(source.host))
}

export interface MirrorSelectionOptions {
  /** 候选/批量探针（ping：零服务端应用层负载） */
  probe: MirrorProbe
  /** 当前镜像的健康取证探针（默认同 probe；生产注入真实请求——ping 通不代表
   *  反代活着，取证必须打一次真实链路，仅单站单次，不构成批量负载） */
  verify?: MirrorProbe
  store?: MirrorStoreLike
  now?: () => Date
  /** 候选批次大小（默认 6） */
  batchSize?: number
  /** 最多试几批（默认 3） */
  batchLimit?: number
}

export interface MirrorSelectionOutcome {
  /** 本次选定/维持的镜像 host（'' = 无可用镜像，调用方保持原状） */
  host: string
  latencyMs: number | null
  /** 选中项是否与切换前不同 */
  changed: boolean
  /** 是否因无可用镜像而放弃（host 为空） */
  exhausted: boolean
  message: string
  speedtest: MirrorSpeedTest
}

/** 逐批并行探测候选，返回首个（也是最快的一批内最快）可用镜像 */
async function probeCandidates(
  candidates: readonly MirrorSource[],
  options: MirrorSelectionOptions,
  accumulate: { results: Record<string, number>; failed: string[] },
): Promise<{ host: string; latencyMs: number } | null> {
  const batchSize = Math.max(1, options.batchSize ?? MIRROR_CANDIDATE_BATCH)
  const batchLimit = Math.max(1, options.batchLimit ?? MIRROR_AUTO_BATCH_LIMIT)
  for (let batch = 0; batch < batchLimit; batch += 1) {
    const slice = candidates.slice(batch * batchSize, (batch + 1) * batchSize)
    if (slice.length === 0) break
    const probed = await Promise.all(
      slice.map(async (source) => {
        let latencyMs: number | null = null
        try {
          latencyMs = await options.probe(source.host)
        } catch (err) {
          logError(`[mirrors] ${source.host} 探测异常: ${errMsg(err)}`)
          latencyMs = null
        }
        if (latencyMs === null) accumulate.failed.push(source.host)
        else accumulate.results[source.host] = latencyMs
        return { host: source.host, latencyMs }
      }),
    )
    const fastest = pickFastestMirror(
      Object.fromEntries(
        probed
          .filter((item): item is { host: string; latencyMs: number } => item.latencyMs !== null)
          .map((item) => [item.host, item.latencyMs]),
      ),
    )
    if (fastest !== null) return fastest
  }
  return null
}

/**
 * 自动测速选优（"未手动选择时由启动器自动测速选一个"）：
 * 按注册表顺序逐批并行探测，取最快可用站写回配置。
 * 不可用时保持原状（exhausted=true），绝不把用户指到测不通的站。
 */
export async function autoSelectMirror(
  options: MirrorSelectionOptions,
): Promise<MirrorSelectionOutcome> {
  const store = options.store ?? getConfigStore()
  const state = readMirrorState(store)
  const now = options.now ?? (() => new Date())
  const accumulate = { results: { ...state.speedtest.results }, failed: [...state.speedtest.failed] }

  if (!state.enabled) {
    return {
      host: state.host,
      latencyMs: null,
      changed: false,
      exhausted: false,
      message: '当前使用官方源，无需自动选优',
      speedtest: state.speedtest,
    }
  }
  if (!state.auto) {
    return {
      host: state.host,
      latencyMs: null,
      changed: false,
      exhausted: false,
      message: '已手动指定镜像源，跳过自动选优',
      speedtest: state.speedtest,
    }
  }

  const candidates = orderedCandidates(state.speedtest)
  const fastest = await probeCandidates(candidates, options, accumulate)
  const speedtest: MirrorSpeedTest = {
    results: accumulate.results,
    failed: accumulate.failed,
    tested_at: now().toISOString(),
  }
  if (fastest === null) {
    writeMirrorState({ speedtest }, store)
    return {
      host: '',
      latencyMs: null,
      changed: false,
      exhausted: true,
      message: `自动测速未找到可用镜像（已试 ${accumulate.failed.length} 个），改用官方源`,
      speedtest,
    }
  }
  const changed = fastest.host !== state.host
  writeMirrorState({ host: fastest.host, speedtest }, store)
  return {
    host: fastest.host,
    latencyMs: fastest.latencyMs,
    changed,
    exhausted: false,
    message: `自动测速选定镜像 ${fastest.host}（${fastest.latencyMs} ms）`,
    speedtest,
  }
}

/**
 * git 网络类失败的 stderr/消息特征（有文本可判的链路用它过滤，避免把
 * "目录已存在/路径非法"之类的本地失败也送进探针流程）。
 * 覆盖 git 自身的连接类报错、isomorphic-git 的 HttpError、平台 fetch 的
 * 直连异常（ENOTFOUND/ECONNREFUSED/ETIMEDOUT 等）与证书链失败。
 */
const NETWORK_FAILURE_RE =
  /could not resolve host|failed to connect|unable to access|connection (?:timed out|refused|reset)|operation timed out|timed out|network is unreachable|no route to host|early eof|rpc failed|the remote end hung up|ssl certificate problem|certificate verify|empty server response|httperror|fetch failed|socket hang up|econnrefused|econnreset|enotfound|etimedout|eproto|einval.*tls/i

export function isNetworkFailureText(text: string): boolean {
  return NETWORK_FAILURE_RE.test(text)
}

/** 流读取（与 git.ts 同形：失败返回空串，不因流异常炸掉测速） */
async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text()
  } catch {
    return ''
  }
}

export interface MirrorFailoverOutcome {
  switched: boolean
  from: string
  to: string
  latencyMs: number | null
  message: string
  /** 是否遍历完候选仍无可用镜像（此时保持原镜像不动） */
  exhausted: boolean
}

/**
 * 镜像故障切换：当前镜像导致 git 网络错误时调用。
 * 先取证再归因（红线：未验证的归因是甩锅）——探活当前镜像，仍可达说明本次失败
 * 与镜像无关（磁盘/路径/仓库自身问题），配置一律不动；
 * 确不可达才把当前镜像记入 failed、逐批探测候选并切到最快可用站。
 * 手动模式（auto=false）不自动切换，只回报原因。
 */
export async function failoverMirror(
  reason: string,
  options: MirrorSelectionOptions,
): Promise<MirrorFailoverOutcome> {
  const store = options.store ?? getConfigStore()
  const state = readMirrorState(store)
  const now = options.now ?? (() => new Date())
  const current = activeMirrorHost(store)

  if (!state.enabled || !state.auto || !isValidMirrorHost(state.host)) {
    return {
      switched: false,
      from: current,
      to: current,
      latencyMs: null,
      exhausted: false,
      message: `手动模式：${current} 失败后不自动切换（原因：${reason}）`,
    }
  }

  // 取证：当前镜像仍可达 → 本次失败不是镜像的锅，保持用户设置不动
  // （ping 只证明主机活着，代理链路是否通必须打一次真实请求——故用 verify）
  const verifyProbe = options.verify ?? options.probe
  let currentLatency: number | null = null
  try {
    currentLatency = await verifyProbe(state.host)
  } catch (err) {
    logError(`[mirrors] ${state.host} 探活异常: ${errMsg(err)}`)
    currentLatency = null
  }
  if (currentLatency !== null) {
    return {
      switched: false,
      from: state.host,
      to: state.host,
      latencyMs: currentLatency,
      exhausted: false,
      message: `镜像 ${state.host} 探活正常（${currentLatency} ms），本次失败与镜像无关，保持当前设置（${reason}）`,
    }
  }

  const failed = [...new Set([...state.speedtest.failed, state.host])]
  const results = { ...state.speedtest.results }
  delete results[state.host]
  const accumulate = { results, failed }
  const candidates = orderedCandidates({ results, failed, tested_at: state.speedtest.tested_at })
  const fastest = await probeCandidates(candidates, options, accumulate)
  const speedtest: MirrorSpeedTest = {
    results: accumulate.results,
    failed: accumulate.failed,
    tested_at: now().toISOString(),
  }

  if (fastest === null) {
    // 全灭：清空 failed（网络整体异常时不该把镜像池锁死），保持当前选定值
    writeMirrorState(
      { speedtest: { results: accumulate.results, failed: [], tested_at: speedtest.tested_at } },
      store,
    )
    return {
      switched: false,
      from: state.host,
      to: state.host,
      latencyMs: null,
      exhausted: true,
      message: `镜像 ${state.host} 不可用且无备用镜像可达，保持原设置（原因：${reason}）`,
    }
  }

  writeMirrorState({ host: fastest.host, speedtest }, store)
  return {
    switched: true,
    from: state.host,
    to: fastest.host,
    latencyMs: fastest.latencyMs,
    exhausted: false,
    message: `镜像 ${state.host} 不可用（${reason}），已自动切换至 ${fastest.host}（${fastest.latencyMs} ms）`,
  }
}

/**
 * 启动自愈：自动模式下若尚未选定镜像、或选定结果已过期（>12h），
 * 跑一次自动选优；已有新鲜可用选定时直接沿用（启动零网络开销）。
 * 手动模式 / 官方源直接返回 null（无需动作）。
 */
export async function ensureMirrorSelection(
  options: MirrorSelectionOptions,
): Promise<MirrorSelectionOutcome | null> {
  const store = options.store ?? getConfigStore()
  const state = readMirrorState(store)
  if (!state.enabled || !state.auto) return null
  const now = options.now ?? (() => new Date())
  const fresh =
    isValidMirrorHost(state.host) &&
    state.speedtest.tested_at !== '' &&
    now().getTime() - new Date(state.speedtest.tested_at).getTime() < MIRROR_SELECTION_TTL_MS
  if (fresh) return null
  return autoSelectMirror(options)
}
