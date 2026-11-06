/**
 * Windows 系统代理读取/归一化/可达性探测（← stLifecycle 拆分：auto_proxy 检测面，
 * 与生命周期编排无关）
 *
 * ← urllib.getproxies_registry：ProxyEnable/ProxyServer 注册表查询 + 取值归一化。
 * 检测到候选后必须过 TCP 可达性门检（probeProxyReachable）——注册表残留的死代理
 * （代理软件退出未清理）直接烘焙进 config.yaml 会让 ST 全部出站请求 ECONNREFUSED
 * （2026-09-29 新用户 127.0.0.1:10808 实锤）。
 *
 * 探测走 node:net 直连（非子进程，不经 runtime）；注册表查询经 runtime 的
 * spawnSyncCmd（windowsHide/参数数组语义只在 runtime 实现）。
 */
import net from 'node:net'
import { IS_WINDOWS, spawnSyncCmd } from './runtime'

/** reg query 同步查询形状（测试注入用）；exitCode 对齐 SyncSpawnResult 的可空性 */
export interface RegistryQueryResult {
  exitCode: number | null
  stdout: string
}

const INTERNET_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/**
 * ← urllib.getproxies_registry：读 Windows 系统代理（HKCU Internet Settings）。
 * ProxyEnable=0x1 时取 ProxyServer；仅匹配 ASCII 值名（ProxyEnable/ProxyServer/
 * REG_DWORD/REG_SZ），不受 reg 标头中文编码差异影响。查询失败按无代理处理。
 */
export function readWindowsRegistryProxy(
  query: (args: string[]) => RegistryQueryResult = (args: string[]) => spawnSyncCmd(args),
): string {
  if (!IS_WINDOWS) return ''
  const enabled = query(['reg', 'query', INTERNET_SETTINGS_KEY, '/v', 'ProxyEnable'])
  if (enabled.exitCode !== 0 || !/\bProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled.stdout)) {
    return ''
  }
  const server = query(['reg', 'query', INTERNET_SETTINGS_KEY, '/v', 'ProxyServer'])
  if (server.exitCode !== 0) return ''
  const value = server.stdout.match(/\bProxyServer\s+REG_SZ\s+(\S*)/i)?.[1] ?? ''
  return normalizeProxyServer(value)
}

/**
 * ProxyServer 值 → 代理 URL（← getproxies_registry 的取值归一化）。
 * 'proto=host:port;...' 分协议串取 https 段（次选 http），裸 'host:port'
 * 全协议适用；结果缺 '://' 时补 http:// 前缀（对齐 CPython 行为）。
 */
export function normalizeProxyServer(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  let candidate = raw
  if (raw.includes('=')) {
    const entries = raw
      .split(';')
      .map((part) => part.trim().match(/^([A-Za-z]+)=(.+)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
    const picked =
      entries.find((match) => match[1]?.toLowerCase() === 'https') ??
      entries.find((match) => match[1]?.toLowerCase() === 'http')
    if (!picked) return ''
    candidate = picked[2] ?? ''
  }
  if (!candidate.includes('://')) candidate = `http://${candidate}`
  return candidate
}

/** 代理 URL 缺显式端口时的协议默认端口（socks 系列统一 1080，对齐惯例） */
const PROXY_DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'socks:': 1080,
  'socks4:': 1080,
  'socks5:': 1080,
}

export interface ProxyEndpoint {
  host: string
  port: number
}

/**
 * 代理 URL → {host, port}；协议无默认端口且未写端口 / 主机名缺失 / 端口越界 → null。
 * 解析失败即视为不可探测（调用方按不可达处理）。
 */
export function extractProxyEndpoint(url: string): ProxyEndpoint | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  const host = parsed.hostname
  if (!host) return null
  const port = parsed.port !== '' ? Number(parsed.port) : PROXY_DEFAULT_PORTS[parsed.protocol]
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

/** 代理可达性探测超时（毫秒）：本机代理拒绝连接是即时的，超时只兜防火墙丢包场景 */
export const PROXY_PROBE_TIMEOUT_MS = 1000

/**
 * 代理可达性探测（TCP 层）：只验证 host:port 有进程在听，不校验代理协议——
 * ST 经代理出站的失败模式（ECONNREFUSED）正是端口无监听。ping 不可替代：
 * 127.0.0.1 ping 恒通但端口可以没人听。node:net 直连（非子进程，不经 runtime）。
 */
export function probeProxyReachable(
  url: string,
  timeoutMs: number = PROXY_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const endpoint = extractProxyEndpoint(url)
  if (!endpoint) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port })
    const settle = (ok: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}
