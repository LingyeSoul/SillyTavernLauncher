/**
 * ← src/core/network.py（NetworkManager）
 *
 * DEVIATION: 原实现通过 ipconfig.exe + GBK 解码解析适配器信息，
 * 现改为 os.networkInterfaces()（迁移设计计划 §3 顺带改进项，消除编码隐患）。
 * 适配器分类关键词、优先级数值、IP 段优先级、UDP 8.8.8.8 回退、300s 缓存
 * 语义全部保留。接口从同步改为 async（UDP 回退天然异步）。
 */
import * as dgram from 'node:dgram'
import * as os from 'node:os'

export type AdapterType = 'physical' | 'vm' | 'vpn' | 'other'

/** ← _is_valid_ip：格式校验 + 排除回环/链路本地（独立函数便于复用） */
export function isValidIpString(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false
    const num = Number(part)
    if (num < 0 || num > 255) return false
  }
  if (ip.startsWith('127.') || ip.startsWith('169.254.')) return false
  return true
}

export interface AdapterInfo {
  ip: string
  name: string
  type: AdapterType
  priority: number
}

export type LogCallback = (message: string, level: 'info' | 'success' | 'warning' | 'error') => void
export type InterfacesProvider = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
export type UdpFallback = () => Promise<string | null>

export interface NetworkManagerOptions {
  /** IP 缓存时长（秒），默认 300 */
  cacheDuration?: number
  getInterfaces?: InterfacesProvider
  udpFallback?: UdpFallback
  log?: LogCallback
  now?: () => number
}

// 关键词列表与 network.py 逐一对应
const VM_KEYWORDS = [
  'vmware', 'virtualbox', 'virtual', 'vbox', 'vethernet',
  'hyper-v', 'docker', 'wsl', 'vnc',
]
const VPN_KEYWORDS = [
  'vpn', 'tap', 'tun', 'ppp', 'pptp', 'l2tp', 'cisco',
  'fortinet', 'openvpn', 'wireguard', 'nordvpn', 'expressvpn',
]
const PHYSICAL_KEYWORDS = [
  'ethernet', 'realtek', 'intel', 'broadcom', 'nvidia',
  'wi-fi', 'wireless', '802.11', 'wlan', 'wifi', 'qualcomm',
  'atheros', 'killer', 'controller',
]

export class NetworkManager {
  private cachedLocalIp: string | null = null
  private lastIpCheckTime = 0
  private readonly cacheDurationMs: number
  private readonly getInterfaces: InterfacesProvider
  private readonly udpFallback: UdpFallback
  private readonly log: LogCallback
  private readonly now: () => number

  constructor(options: NetworkManagerOptions = {}) {
    this.cacheDurationMs = (options.cacheDuration ?? 300) * 1000
    this.getInterfaces = options.getInterfaces ?? (() => os.networkInterfaces())
    this.udpFallback = options.udpFallback ?? defaultUdpFallback
    this.log = options.log ?? ((message) => console.log(message))
    this.now = options.now ?? (() => Date.now())
  }

  /** ← get_local_ip：带缓存，优先物理网卡 */
  async getLocalIp(): Promise<string | null> {
    const currentTime = this.now()

    if (this.cachedLocalIp && currentTime - this.lastIpCheckTime < this.cacheDurationMs) {
      return this.cachedLocalIp
    }
    const adapters = this.collectAdapterIps(this.getInterfaces())
    if (adapters.length > 0) {
      // 按适配器类型优先级 + IP 段优先级取最优
      adapters.sort(
        (a, b) => a.priority - b.priority || this.getIpPriority(a.ip) - this.getIpPriority(b.ip),
      )
      const best = adapters[0]
      if (best) {
        this.cachedLocalIp = best.ip
        this.lastIpCheckTime = currentTime
        if (best.type === 'physical') {
          this.log(`通过网卡信息获取物理网卡IP: ${best.ip} (${best.name})`, 'success')
        } else if (best.type === 'vm') {
          this.log(`警告：仅检测到虚拟网卡IP: ${best.ip} (${best.name})`, 'warning')
        } else {
          this.log(`通过网卡信息获取IP: ${best.ip} (${best.name})`, 'info')
        }
        return best.ip
      }
    }

    // ← _fallback_get_local_ip
    const fallbackIp = await this.udpFallback()
    if (fallbackIp) {
      this.cachedLocalIp = fallbackIp
      this.lastIpCheckTime = currentTime
    }
    return fallbackIp
  }

  /**
   * 清除 IP 缓存（网络环境变化后需重取真实 IP，
   * 如同步服务绑定前发现配置 IP 已不在本机网卡上时的回退解析）。
   */
  invalidateCache(): void {
    this.cachedLocalIp = null
    this.lastIpCheckTime = 0
  }

  /** ← _parse_adapter_ips 的 os.networkInterfaces 版本 */
  private collectAdapterIps(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): AdapterInfo[] {
    const adapters: AdapterInfo[] = []
    for (const [name, infos] of Object.entries(interfaces)) {
      if (!infos) continue
      const { type, priority } = this.classifyAdapter(name)
      for (const info of infos) {
        // Node ≥18 的 family 为字符串 'IPv4'/'IPv6'
        if (info.family !== 'IPv4') continue
        if (info.internal) continue
        if (!this.isValidIp(info.address)) continue
        adapters.push({ ip: info.address, name, type, priority })
      }
    }
    return adapters
  }

  /** ← _classify_adapter：vm(30) < vpn(20) < other(25) < physical(10)，数值越小越优先 */
  classifyAdapter(adapterName: string): { type: AdapterType; priority: number } {
    const nameLower = adapterName.toLowerCase()
    for (const keyword of VM_KEYWORDS) {
      if (nameLower.includes(keyword)) return { type: 'vm', priority: 30 }
    }
    for (const keyword of VPN_KEYWORDS) {
      if (nameLower.includes(keyword)) return { type: 'vpn', priority: 20 }
    }
    for (const keyword of PHYSICAL_KEYWORDS) {
      if (nameLower.includes(keyword)) return { type: 'physical', priority: 10 }
    }
    return { type: 'other', priority: 25 }
  }

  /** ← _is_valid_ip：格式校验 + 排除回环/链路本地 */
  isValidIp(ip: string): boolean {
    return isValidIpString(ip)
  }

  /** ← _is_valid_lan_ip：私有地址段（10/8、172.16-31、192.168/16） */
  isValidLanIp(ip: string): boolean {
    if (!this.isValidIp(ip)) return false
    const parts = ip.split('.')
    const first = Number(parts[0])
    const second = Number(parts[1])
    if (first === 10) return true
    if (first === 172 && second >= 16 && second <= 31) return true
    if (first === 192 && second === 168) return true
    return false
  }

  /** ← _get_ip_priority：192.168(1) > 10(2) > 172.16-31(3) > 其他有效(4) */
  getIpPriority(ip: string): number {
    const parts = ip.split('.')
    if (parts.length !== 4) return 999
    const first = Number(parts[0])
    const second = Number(parts[1])
    if (first === 192 && second === 168) return 1
    if (first === 10) return 2
    if (first === 172 && second >= 16 && second <= 31) return 3
    if (this.isValidIp(ip)) return 4
    return 999
  }
}

/** ← _fallback_get_local_ip：UDP connect 8.8.8.8:80 读取本地地址，3s 超时 */
export function defaultUdpFallback(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const socket = dgram.createSocket('udp4')
    const finish = (ip: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // 已关闭
      }
      resolve(ip)
    }
    const timer = setTimeout(() => finish(null), 3000)
    socket.on('error', () => finish(null))
    socket.connect(80, '8.8.8.8', () => {
      // bun-types 的 dgram Socket 未声明 localAddress，运行时存在
      const addr = (socket as unknown as { localAddress?: string }).localAddress
      finish(addr && isValidIpString(addr) ? addr : null)
    })
  })
}

let globalManager: NetworkManager | null = null

/** ← get_network_manager */
export function getNetworkManager(): NetworkManager {
  if (!globalManager) {
    globalManager = new NetworkManager()
  }
  return globalManager
}

/** ← get_local_ip 便捷函数 */
export function getLocalIp(): Promise<string | null> {
  return getNetworkManager().getLocalIp()
}

/**
 * 判断 IP 是否挂在本机某块网卡上（含回环；按字面量比对，IPv4/IPv6 皆可）。
 * 同步服务绑定前的拦截线：config 里的 host 是网络状态快照而非用户偏好，
 * 网段漂移后 listen 该 IP 会 EADDRNOTAVAIL——而 Bun 会把所有 listen 失败
 * 掩蔽成误导性的 "Failed to start server. Is port XXXX in use?"，
 * 必须在 listen 之前自行校验才能给出真实诊断。
 */
export function isLocalAddress(
  ip: string,
  getInterfaces: InterfacesProvider = () => os.networkInterfaces(),
): boolean {
  for (const infos of Object.values(getInterfaces())) {
    if (!infos) continue
    for (const info of infos) {
      if (info.address === ip) return true
    }
  }
  return false
}
