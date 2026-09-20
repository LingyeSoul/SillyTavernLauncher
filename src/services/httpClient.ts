/**
 * HTTPS 抓取的 TLS 容错层（对齐浏览器/系统证书库的信任链）。
 *
 * 背景（RCA 实测，2026-09）：Watt Toolkit（Steam++，"S302" hosts 劫持 + 本地
 * 反代）、企业网关、部分安全软件会把自签 CA 装进 Windows 系统证书库后对
 * HTTPS 流量换发证书。浏览器 / curl（Schannel）认这些 CA，但 Bun / Node 的
 * fetch 用自带 Mozilla CA 捆绑包，遇到劫持直接抛
 * "unable to verify the first certificate" —— 启动器更新检查在此类环境全部失败。
 *
 * 策略：fetch 抛"证书校验类"错误时，导出 Windows 系统证书库
 * （LocalMachine\Root + CurrentUser\Root，按指纹去重）为 PEM，经 Bun fetch
 * 的 tls.ca 选项注入重试一次。非 Windows、或导出失败时放弃回退，抛
 * TlsInterceptError 交由调用方给出针对性提示（如建议切换 GitHub 镜像）。
 *
 * 可注入性：fetchImpl / caProvider 均可注入（vitest/Node 下不触 PowerShell），
 * 与 UpdaterOptions.fetchImpl 的注入惯例一致。
 */
import { errMsg, logError } from './errorLog'
import { IS_WINDOWS, spawnAsync } from './runtime'

/** Bun fetch 的扩展 init：tls.ca 注入附加 CA（Node/undici 忽略该属性，无害） */
export type FetchInitX = RequestInit & { tls?: { ca?: string } }

/** fetch 实现签名（兼容现有 FetchLike；init 放宽为 FetchInitX） */
export type FetchLikeX = (url: string, init?: FetchInitX) => Promise<Response>

/** 系统证书库 PEM 导出器 */
export type CaProvider = () => Promise<string | null>

/**
 * TLS 被拦截（证书校验失败且系统 CA 回退也未能完成）时抛出，
 * 调用方据此给出"切换镜像/关闭加速"等针对性提示。
 */
export class TlsInterceptError extends Error {
  constructor(detail: string) {
    super(`网络证书校验失败（疑似被加速工具/网关拦截）: ${detail}`)
    this.name = 'TlsInterceptError'
  }
}

/** Node/Bun/OpenSSL 证书信任链失败错误码（不含过期/域名不匹配等真证书问题） */
const TLS_TRUST_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** 兜底消息匹配（Bun 只给 message 不一定给 code；Node 错误在 cause 里） */
const TLS_TRUST_MESSAGE_RE =
  /unable to verify the first certificate|self[- ]signed certificate|unable to get local issuer certificate|certificate verify failed/i

/** 判断错误是否为证书信任链失败（→ 值得用系统证书库重试） */
export function isTlsVerifyError(err: unknown): boolean {
  const candidates: unknown[] = [err]
  const cause = (err as { cause?: unknown } | null | undefined)?.cause
  if (cause !== undefined && cause !== null) candidates.push(cause)
  for (const candidate of candidates) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code
    if (typeof code === 'string' && TLS_TRUST_ERROR_CODES.has(code)) return true
    const message = candidate instanceof Error ? candidate.message : undefined
    if (message !== undefined && TLS_TRUST_MESSAGE_RE.test(message)) return true
  }
  return false
}

/** 导出 Windows Root 证书库为 PEM 的 PowerShell 脚本（单 argv 元素，绝不经 shell） */
const EXPORT_CA_PS =
  "$ErrorActionPreference = 'Stop'; " +
  "$seen = New-Object 'System.Collections.Generic.HashSet[string]'; " +
  "$blocks = New-Object System.Collections.Generic.List[string]; " +
  "foreach ($s in @('Cert:\\LocalMachine\\Root', 'Cert:\\CurrentUser\\Root')) { " +
  "if (-not (Test-Path $s)) { continue }; " +
  "foreach ($c in (Get-ChildItem $s)) { " +
  "if ($seen.Add($c.Thumbprint)) { " +
  "$b64 = [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks'); " +
  "[void]$blocks.Add(\"-----BEGIN CERTIFICATE-----`r`n$b64`r`n-----END CERTIFICATE-----`r`n\") } } }; " +
  '[Console]::Write([string]::Join(\'\', $blocks))'

/** PowerShell 导出超时：慢机器上也不该卡死更新检查 */
const CA_EXPORT_TIMEOUT_MS = 15_000

/** 进程内缓存（成功与失败都记忆：失败重试只会反复烧 1s+ 的 PowerShell） */
let cachedCaPromise: Promise<string | null> | null = null

async function exportWindowsCaOnce(): Promise<string | null> {
  const proc = spawnAsync({
    cmd: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', EXPORT_CA_PS],
    windowsHide: true,
  })
  const timer = setTimeout(() => proc.kill(), CA_EXPORT_TIMEOUT_MS)
  try {
    const [exitCode, stdout] = await Promise.all([proc.exited, streamText(proc.stdout)])
    if (exitCode === 0 && stdout.includes('BEGIN CERTIFICATE')) return stdout
    logError(`[http] Windows 证书库导出异常 exit=${String(exitCode)}`)
    return null
  } catch (err) {
    logError(`[http] Windows 证书库导出失败: ${errMsg(err)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text()
  } catch {
    return ''
  }
}

/** 导出 Windows 系统 Root 证书库为 PEM（进程内记忆化；非 Windows 恒 null） */
export function getWindowsCaPem(): Promise<string | null> {
  if (!IS_WINDOWS) return Promise.resolve(null)
  if (cachedCaPromise === null) {
    cachedCaPromise = exportWindowsCaOnce()
  }
  return cachedCaPromise
}

/** 测试用：清除证书库导出的进程内缓存 */
export function resetWindowsCaCacheForTest(): void {
  cachedCaPromise = null
}

export interface FetchTlsFallbackOptions {
  fetchImpl?: FetchLikeX
  /** 系统证书库 PEM 提供者（默认 Windows PowerShell 导出；测试注入） */
  caProvider?: CaProvider
}

/**
 * 带系统证书库回退的 fetch：首次失败且为证书信任链错误时，
 * 注入系统 CA 重试一次；回退也失败（或拿不到 CA）则抛 TlsInterceptError。
 * 非 TLS 错误原样上抛。
 */
export async function fetchWithTlsFallback(
  url: string,
  init: FetchInitX,
  options: FetchTlsFallbackOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLikeX)
  const caProvider = options.caProvider ?? getWindowsCaPem

  let firstError: unknown
  try {
    return await fetchImpl(url, init)
  } catch (err) {
    if (!isTlsVerifyError(err)) throw err
    firstError = err
  }

  console.warn(`[http] 证书校验失败，尝试用 Windows 系统证书库重试: ${url}`)
  let ca: string | null = null
  try {
    ca = await caProvider()
  } catch (err) {
    logError(`[http] 系统证书库导出异常: ${errMsg(err)}`)
  }
  if (ca === null || ca.length === 0) {
    throw new TlsInterceptError(errMsg(firstError))
  }
  try {
    return await fetchImpl(url, { ...init, tls: { ca } })
  } catch (err) {
    throw new TlsInterceptError(errMsg(err))
  }
}
