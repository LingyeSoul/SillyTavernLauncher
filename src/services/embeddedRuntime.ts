/**
 * embedded 模式运行时派生服务（设计计划 §3/§6/§9，Embedded-All Phase 2）。
 *
 * 职责（D2 三件套中的"ST 运行"部分）：
 * - defaultEmbeddedExecPath()：embedded 可执行文件默认来源（process.execPath——
 *   打包产物为单文件 exe，dev 下为 bun.exe，两者皆可承载 embedded 启动）；
 * - ensureStEmbeddedRuntime()：ST 启动前校验（execPath 存在性）+ CA 缓存懒加载；
 * - ensureCaCache()：Windows 系统 CA PEM 原子落盘 <root>/cache/win-ca.pem
 *   （§9 ST 子进程网络自愈：NODE_EXTRA_CA_CERTS 在 Bun 下生效，F7 实测 200）；
 * - buildProcessEnvEmbedded()：embedded 子进程环境（BUN_BE_BUN + 按需 CA 注入）；
 * - ensureBunLockExcluded()：Phase 3 依赖安装的 bun.lock 消解（§7/D6，
 *   幂等写入 <stDir>/.git/info/exclude，消除 porcelain 脏检查误报，F4）。
 *
 * 纪律：execPath / baseDir / caProvider 全部可注入——vitest 跑在 Node 下，
 * process.execPath 是 node.exe，测试不依赖真值（AGENTS 测试防污染纪律）。
 * 失败路径全部 logError 收口，绝不静默吞噬、绝不向调用方抛出（CA 属增强项，
 * 正常网络无需注入，失败不阻断启动；bun.lock 消解失败同样不阻断安装）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync, dirname, ensureDirSync } from './atomicFs'
import { getWindowsCaPem } from './httpClient'
import { buildProcessEnv } from './processManager'
import { isFile } from './runtime'
import { errMsg, logError } from './errorLog'
import type { BoolMessage } from './types'

/** Windows 系统 CA PEM 提供者（默认 PowerShell 导出；测试注入） */
export type CaPemProvider = () => Promise<string | null>

/**
 * embedded 可执行文件默认来源：process.execPath。
 * onefile 语义下恒指向自身 exe；dev 模式为 bun.exe（同样成立，dev 也能测 embedded）。
 */
export function defaultEmbeddedExecPath(): string {
  return process.execPath
}

/** §9 CA 缓存文件路径（<root>/cache/win-ca.pem） */
export function embeddedCaPemPath(baseDir?: string): string {
  return join(baseDir ?? process.cwd(), 'cache', 'win-ca.pem')
}

export interface EmbeddedRuntimeOptions {
  /** embedded 可执行文件路径（默认 process.execPath；测试注入假路径） */
  execPath?: string
  /** CA 缓存基准目录（默认 process.cwd()；测试注入临时目录） */
  baseDir?: string
  /** CA PEM 提供者（默认 getWindowsCaPem；测试注入隔离 PowerShell） */
  caProvider?: CaPemProvider
}

/** CA 缓存是否已成功落盘（进程内记忆化：成功后不再重复导出/写盘） */
let caCacheEnsured = false

/** 仅供测试重置 CA 缓存记忆化标志 */
export function resetEmbeddedCaCacheForTest(): void {
  caCacheEnsured = false
}

/**
 * §9 ST 子进程网络自愈：导出 Windows 系统 Root 证书库为 PEM 并原子写入
 * <root>/cache/win-ca.pem——ST 的 node:https/fetch 经 NODE_EXTRA_CA_CERTS
 * 信任系统 CA，劫持网络（Watt Toolkit/网关自签 CA）下 TLS 可过（F7 实测）。
 *
 * 语义：
 * - 成功写盘后进程内记忆化，后续调用零开销直通；
 * - 获取失败（provider 返回 null，含非 Windows 恒 null）或抛异常、写盘失败
 *   → 仅 logError 跳过返回 false，不阻断调用方（正常网络无需 CA）。
 * @returns 缓存是否已就绪（false = 本次跳过，非致命）
 */
export async function ensureCaCache(
  options: { baseDir?: string; caProvider?: CaPemProvider } = {},
): Promise<boolean> {
  if (caCacheEnsured) return true
  const provider = options.caProvider ?? getWindowsCaPem
  let pem: string | null = null
  try {
    pem = await provider()
  } catch (err) {
    // provider 抛异常：内部多半已记日志，此处收口保证不向调用方抛出
    logError(`[embeddedRuntime] Windows 证书库导出异常: ${errMsg(err)}`)
    return false
  }
  if (pem === null || pem.length === 0) {
    // 非 Windows 平台 / 导出失败（httpClient 内部已 logError）：无需 CA，静默跳过
    return false
  }
  try {
    const target = embeddedCaPemPath(options.baseDir)
    ensureDirSync(dirname(target))
    atomicWriteFileSync(target, pem)
    caCacheEnsured = true
    return true
  } catch (err) {
    logError(`[embeddedRuntime] CA 缓存写入失败（不阻断启动）: ${errMsg(err)}`)
    return false
  }
}

/**
 * §6 embedded 启动前校验：
 * 1. execPath 存在性（且为文件）——不存在返回失败 Result（调用方走现有错误反馈路径）；
 * 2. CA 缓存懒加载（§9）——失败不阻断，仅落错误日志。
 */
export async function ensureStEmbeddedRuntime(
  options: EmbeddedRuntimeOptions = {},
): Promise<BoolMessage> {
  const execPath = options.execPath ?? defaultEmbeddedExecPath()
  if (!isFile(execPath)) {
    const message = `启动器内置运行时可执行文件不存在: ${execPath}`
    logError(`[embeddedRuntime] ${message}`)
    return { ok: false, message }
  }
  await ensureCaCache({ baseDir: options.baseDir, caProvider: options.caProvider })
  return { ok: true, message: '内置运行时就绪' }
}

/**
 * §6 embedded 子进程环境：继承 buildProcessEnv 全部语义
 * （NODE_ENV=production / FORCE_COLOR / PYTHONUNBUFFERED 与 PATH 拼接规则），
 * 在其上追加：
 * - BUN_BE_BUN=1（F1：使编译 exe 退化为完整 bun CLI；对真 bun.exe / node.exe 宿主无副作用）；
 * - NODE_EXTRA_CA_CERTS=<root>/cache/win-ca.pem（F7：缓存文件存在才注入；
 *   不存在时保留宿主环境既有值，不自作主张清除）。
 *
 * 注意：embedded 语义下不做 PATH 前置——executeCommand 调用点传空数组（[]）；
 * 参数保留是为了与 buildProcessEnv 的签名语义对齐（prependDirs 默认空）。
 */
export function buildProcessEnvEmbedded(
  prependDirs: string[] = [],
  options: { baseDir?: string } = {},
): Record<string, string> {
  const env = buildProcessEnv(prependDirs)
  env.BUN_BE_BUN = '1'
  const caPem = embeddedCaPemPath(options.baseDir)
  if (isFile(caPem)) {
    env.NODE_EXTRA_CA_CERTS = caPem
  }
  return env
}

/** D6 排除规则行：与 bun install 生成的锁文件名逐字一致 */
const BUN_LOCK_EXCLUDE_LINE = 'bun.lock'

/**
 * Phase 3（设计计划 §7/D6）：bun.lock 消解——幂等追加 `bun.lock` 一行到
 * <stDir>/.git/info/exclude。
 *
 * 背景（F4 实测）：bun install 生成 bun.lock 且不改 package-lock.json；
 * checkGitStatus 的 porcelain 白名单仅认 package-lock.json，未跟踪的 bun.lock
 * 会把工作区判脏、阻断版本切换。写入 .git/info/exclude（仓库本地、不入版本库）
 * 后 porcelain 立即恢复干净。
 *
 * 语义：
 * - .git/info 目录或 exclude 文件不存在则逐级创建（排除文件只影响本仓库）；
 * - 已有独立的 bun.lock 行则跳过写入（幂等，避免每次安装追加一行）；
 * - 任何失败仅 logError 返回 false，不向调用方抛出——最坏后果是版本切换时
 *   提示工作区不干净，重跑安装即自愈（设计计划 §7 明示不阻断）。
 *
 * @returns true = 排除已生效（本次写入或此前已有）；false = 写入失败
 */
export async function ensureBunLockExcluded(stDir: string): Promise<boolean> {
  const excludePath = join(stDir, '.git', 'info', 'exclude')
  try {
    let existing = ''
    try {
      existing = readFileSync(excludePath, 'utf8')
    } catch {
      // exclude 文件不存在（首次 embedded 安装）→ 走下方创建路径
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === BUN_LOCK_EXCLUDE_LINE)) {
      return true
    }
    // 追加：已有内容不以换行结尾时先补换行，保持行语义完整
    const content =
      existing.length === 0
        ? `${BUN_LOCK_EXCLUDE_LINE}\n`
        : `${existing.endsWith('\n') ? existing : `${existing}\n`}${BUN_LOCK_EXCLUDE_LINE}\n`
    ensureDirSync(dirname(excludePath))
    atomicWriteFileSync(excludePath, content)
    return true
  } catch (err) {
    logError(`[embeddedRuntime] bun.lock 排除写入失败（不阻断，重跑安装可自愈）: ${errMsg(err)}`)
    return false
  }
}
