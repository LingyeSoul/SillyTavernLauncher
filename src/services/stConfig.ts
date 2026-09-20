/**
 * ← src/features/st/config.py（stcfg，ruamel.yaml → eemeli/yaml）
 *
 * - eemeli/yaml Document AST round-trip：保留注释、键序与未知字段。
 * - 托管键：listen/port/requestProxy{enabled,url}/hostWhitelist{enabled,scan,hosts}/
 *   whitelistMode/enableForwardedWhitelist/whitelist[]/unifiedWhitelist/
 *   privateAddressWhitelist{enabled,allowUnresolvedHosts,log{...},allowedRanges[]}。
 * - whitelist.txt 一次性迁移（_whitelist_migrated 标记）。
 * - 智能子网白名单、unified 模式双向同步。
 *
 * DEVIATION: save 由直接覆盖改为原子写（.tmp + rename，硬性纪律）。
 * DEVIATION: Python 对 requestProxy 等节为标量时会让保存抛错并整体失败；
 * TS 侧统一 heal 为 {} 后继续保存（不丢用户其余配置）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Document, isMap, parseDocument } from 'yaml'
import { atomicWriteFileSync, ensureDirSync } from './atomicFs'
import { errMsg, logError } from './errorLog'
import { getLocalIp as defaultGetLocalIp } from './network'
import type { StConfigShape } from './types'

export const DEFAULT_PRIVATE_ADDRESS_RANGES: readonly string[] = ['127.0.0.0/8', '::1/128']

/** ensurePrivateFilterForListen 的结果：ok=本就安全 / healed=已自愈落盘 / save-failed=需要自愈但写入失败 */
export type PrivateFilterHealResult = 'ok' | 'healed' | 'save-failed'

export interface StConfigOptions {
  /** SillyTavern 目录（默认 <cwd>/SillyTavern） */
  baseDir?: string
  /** 本地 IP 获取函数（默认 network 服务，测试注入） */
  getLocalIp?: () => Promise<string | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boolAt(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = record[key]
  return typeof v === 'boolean' ? v : fallback
}

function numberAt(record: Record<string, unknown>, key: string, fallback: number): number {
  const v = record[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function stringAt(record: Record<string, unknown>, key: string, fallback: string): string {
  const v = record[key]
  return typeof v === 'string' ? v : fallback
}

function stringArrayAt(record: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const v = record[key]
  if (Array.isArray(v) && v.every((item) => typeof item === 'string')) {
    return [...v]
  }
  return [...fallback]
}

export class StConfig {
  readonly configPath: string
  readonly whitelistTxtPath: string

  listen = false
  port = 8000
  proxyEnabled = false
  proxyUrl = ''
  hostWhitelistEnabled = false
  hostWhitelistScan = true
  hostWhitelistHosts: string[] = ['localhost', '127.0.0.1', '[::1]']
  whitelistMode = true
  enableForwardedWhitelist = true
  whitelistIps: string[] = ['::1', '127.0.0.1']
  unifiedWhitelist = false
  privateAddressWhitelistEnabled = false
  privateAddressAllowUnresolvedHosts = false
  privateAddressLogBlocked = true
  privateAddressLogAllowed = false
  privateAddressAllowedRanges: string[] = [...DEFAULT_PRIVATE_ADDRESS_RANGES]

  private doc: Document
  private readonly getLocalIpFn: () => Promise<string | null>

  constructor(options: StConfigOptions = {}) {
    const baseDir = options.baseDir ?? join(process.cwd(), 'SillyTavern')
    this.configPath = join(baseDir, 'config.yaml')
    this.whitelistTxtPath = join(baseDir, 'whitelist.txt')
    this.getLocalIpFn = options.getLocalIp ?? defaultGetLocalIp
    this.doc = new Document({})
    this.load()
  }

  /** ← load_config */
  load(): void {
    try {
      let text = ''
      if (existsSync(this.configPath)) {
        text = readFileSync(this.configPath, 'utf8')
      }
      const doc = text.trim() ? parseDocument(text) : new Document({})
      if (doc.errors.length > 0) {
        throw new Error(doc.errors[0]?.message ?? 'YAML 解析失败')
      }
      this.doc = doc

      // 从 AST 读出 JS 视图（注释等仍保留在 doc 上，save 时写回）
      const root = isRecord(this.doc.toJS()) ? (this.doc.toJS() as Record<string, unknown>) : {}
      this.listen = boolAt(root, 'listen', false)
      this.port = numberAt(root, 'port', 8000)
      const proxy = isRecord(root.requestProxy) ? root.requestProxy : {}
      this.proxyEnabled = boolAt(proxy, 'enabled', false)
      this.proxyUrl = stringAt(proxy, 'url', '')
      const hostWhitelist = isRecord(root.hostWhitelist) ? root.hostWhitelist : {}
      this.hostWhitelistEnabled = boolAt(hostWhitelist, 'enabled', false)
      this.hostWhitelistScan = boolAt(hostWhitelist, 'scan', true)
      this.hostWhitelistHosts = stringArrayAt(hostWhitelist, 'hosts', [
        'localhost',
        '127.0.0.1',
        '[::1]',
      ])
      this.whitelistMode = boolAt(root, 'whitelistMode', true)
      this.enableForwardedWhitelist = boolAt(root, 'enableForwardedWhitelist', true)
      this.whitelistIps = stringArrayAt(root, 'whitelist', ['::1', '127.0.0.1'])
      this.unifiedWhitelist = boolAt(root, 'unifiedWhitelist', false)

      const privateWhitelist = isRecord(root.privateAddressWhitelist)
        ? root.privateAddressWhitelist
        : {}
      const privateLog = isRecord(privateWhitelist.log) ? privateWhitelist.log : {}
      this.privateAddressWhitelistEnabled = boolAt(privateWhitelist, 'enabled', false)
      this.privateAddressAllowUnresolvedHosts = boolAt(
        privateWhitelist,
        'allowUnresolvedHosts',
        false,
      )
      this.privateAddressLogBlocked = boolAt(privateLog, 'blockedRequests', true)
      this.privateAddressLogAllowed = boolAt(privateLog, 'allowedRequests', false)
      const ranges = privateWhitelist.allowedRanges
      this.privateAddressAllowedRanges =
        Array.isArray(ranges) && ranges.every((r) => typeof r === 'string')
          ? [...ranges]
          : [...DEFAULT_PRIVATE_ADDRESS_RANGES]

      this.migrateWhitelistFromTxt()
    } catch (err) {
      logError(`配置加载错误: ${errMsg(err)}`)
      this.doc = new Document({ listen: this.listen, port: this.port })
    }
  }

  /** ← save_config：全部托管键写回 AST（保留注释/未知字段），原子落盘；返回是否成功 */
  save(): boolean {
    try {
      ensureDirSync(dirname(this.configPath))
      const doc = this.doc

      doc.set('listen', this.listen)
      doc.set('port', this.port)

      // setIn 会为缺失路径创建中间集合；已存在但非 map 的节点需整体替换为 map
      const ensureSection = (path: string[]): void => {
        if (!isMap(doc.getIn(path))) {
          doc.setIn(path, doc.createNode({}))
        }
      }
      ensureSection(['requestProxy'])
      doc.setIn(['requestProxy', 'enabled'], this.proxyEnabled)
      doc.setIn(['requestProxy', 'url'], this.proxyUrl)

      ensureSection(['hostWhitelist'])
      doc.setIn(['hostWhitelist', 'enabled'], this.hostWhitelistEnabled)
      doc.setIn(['hostWhitelist', 'scan'], this.hostWhitelistScan)
      doc.setIn(['hostWhitelist', 'hosts'], this.hostWhitelistHosts)

      doc.set('whitelistMode', this.whitelistMode)
      doc.set('enableForwardedWhitelist', this.enableForwardedWhitelist)
      doc.set('whitelist', this.whitelistIps)
      doc.set('unifiedWhitelist', this.unifiedWhitelist)

      ensureSection(['privateAddressWhitelist'])
      ensureSection(['privateAddressWhitelist', 'log'])
      doc.setIn(['privateAddressWhitelist', 'enabled'], this.privateAddressWhitelistEnabled)
      doc.setIn(
        ['privateAddressWhitelist', 'allowUnresolvedHosts'],
        this.privateAddressAllowUnresolvedHosts,
      )
      doc.setIn(
        ['privateAddressWhitelist', 'log', 'blockedRequests'],
        this.privateAddressLogBlocked,
      )
      doc.setIn(
        ['privateAddressWhitelist', 'log', 'allowedRequests'],
        this.privateAddressLogAllowed,
      )
      doc.setIn(['privateAddressWhitelist', 'allowedRanges'], this.privateAddressAllowedRanges)

      atomicWriteFileSync(this.configPath, doc.toString())
      return true
    } catch (err) {
      // 保存失败必须可被调用方感知（原实现吞异常导致 UI 谎报"已保存"）
      logError(`配置保存失败: ${errMsg(err)}`)
      return false
    }
  }

  /** ← _get_subnet_from_ip：IPv4 → a.b.c.*，IPv6 → x:y::* */
  getSubnetFromIp(ip: string): string | null {
    try {
      if (ip.includes(':')) {
        const parts = ip.split(':')
        if (parts.length >= 2) return `${parts[0]}:${parts[1]}::*`
        return null
      }
      const parts = ip.split('.')
      if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`
      return null
    } catch {
      return null
    }
  }

  /** ← get_current_subnet */
  async getCurrentSubnet(): Promise<string | null> {
    const localIp = await this.getLocalIpFn()
    if (!localIp) {
      console.warn('无法获取本地IP，跳过当前网段检测')
      return null
    }
    const subnet = this.getSubnetFromIp(localIp)
    if (!subnet) {
      console.warn(`无法从IP ${localIp} 提取网段`)
    }
    return subnet
  }

  /** ← _migrate_whitelist_from_txt：一次性迁移后删除旧文件 */
  private migrateWhitelistFromTxt(): boolean {
    if (this.doc.get('_whitelist_migrated')) return false
    if (!existsSync(this.whitelistTxtPath)) return false

    try {
      const txtContent = readFileSync(this.whitelistTxtPath, 'utf8')
      const migratedIps: string[] = []
      for (const raw of txtContent.split('\n')) {
        const line = raw.trim()
        if (line && !migratedIps.includes(line)) migratedIps.push(line)
      }

      const currentIps = new Set(this.whitelistIps)
      const newIps = migratedIps.filter((ip) => !currentIps.has(ip))

      if (newIps.length > 0) {
        this.whitelistIps = [
          ...migratedIps,
          ...this.whitelistIps.filter((ip) => !migratedIps.includes(ip)),
        ]
      }

      // 标记迁移完成后再保存，防止重复执行
      this.doc.set('_whitelist_migrated', true)
      this.save()
      try {
        rmSync(this.whitelistTxtPath)
      } catch (err) {
        console.warn(`删除 whitelist.txt 失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      return true
    } catch (err) {
      logError(`迁移 whitelist.txt 失败: ${errMsg(err)}`)
      return false
    }
  }

  /** ← _check_and_update_whitelist_subnet：当前网段变化时重建白名单 */
  async checkAndUpdateWhitelistSubnet(): Promise<boolean> {
    const localIp = await this.getLocalIpFn()
    if (!localIp) {
      console.warn('无法获取本地IP，跳过白名单网段检查')
      return false
    }

    const currentSubnet = this.getSubnetFromIp(localIp)
    if (!currentSubnet) {
      console.warn(`无法从IP ${localIp} 提取网段`)
      return false
    }

    const isIpv6 = localIp.includes(':')
    let broaderSubnet: string | null = null
    if (!isIpv6) {
      const ipParts = localIp.split('.')
      if (ipParts.length >= 2) {
        broaderSubnet = `${ipParts[0]}.${ipParts[1]}.*.*`
      } else {
        console.warn(`IP 格式异常，无法提取前两段: ${localIp}`)
      }
    }

    const subnetExists = this.whitelistIps.some(
      (ip) => ip === currentSubnet || (broaderSubnet !== null && ip === broaderSubnet),
    )
    if (subnetExists) return false

    const newWhitelist: string[] = []
    for (const ip of this.whitelistIps) {
      if (ip === '127.0.0.1' || ip === '::1') {
        newWhitelist.push(ip)
      } else if (!ip.includes('*') && (ip.includes('.') || ip.includes(':'))) {
        newWhitelist.push(ip)
      } else if (ip.includes('*')) {
        if (isIpv6) {
          const ipPrefix = ip.includes(':') ? ip.split(':')[0] : ''
          const localPrefix = localIp.split(':')[0]
          if (ipPrefix && ipPrefix !== localPrefix) newWhitelist.push(ip)
        } else {
          const ipPartsLocal = localIp.split('.')
          if (ipPartsLocal.length === 0) continue
          const ipPrefix = ip.includes('.') ? ip.split('.')[0] : ''
          if (ipPrefix && /^\d+$/.test(ipPrefix) && ipPrefix !== ipPartsLocal[0]) {
            newWhitelist.push(ip)
          }
        }
      }
    }

    if (!newWhitelist.includes(currentSubnet)) newWhitelist.unshift(currentSubnet)
    if (!newWhitelist.includes('127.0.0.1')) newWhitelist.push('127.0.0.1')
    if (!newWhitelist.includes('::1')) newWhitelist.push('::1')

    this.whitelistIps = newWhitelist
    this.save()
    return true
  }

  /** 确保回环放行段在列（开启私网过滤的最小权限默认；缺失则补，不重复）；返回是否有补缺 */
  ensureLoopbackRanges(): boolean {
    let changed = false
    for (const addressRange of DEFAULT_PRIVATE_ADDRESS_RANGES) {
      if (!this.privateAddressAllowedRanges.includes(addressRange)) {
        this.privateAddressAllowedRanges.push(addressRange)
        changed = true
      }
    }
    return changed
  }

  /** ← create_whitelist：开启局域网监听时的最小权限白名单 */
  async createWhitelist(): Promise<boolean> {
    try {
      const localIp = await this.getLocalIpFn()
      let changed = false

      if (!this.privateAddressWhitelistEnabled) {
        this.privateAddressWhitelistEnabled = true
        changed = true
      }

      if (localIp) {
        const subnet = this.getSubnetFromIp(localIp)
        if (subnet) {
          if (!this.whitelistIps.includes(subnet)) {
            this.whitelistIps.unshift(subnet)
            changed = true
          }
        } else {
          console.warn(`无法提取网段 (本地IP: ${localIp})`)
        }
      } else {
        console.warn('无法获取本地IP，白名单未更新')
      }

      for (const address of ['127.0.0.1', '::1']) {
        if (!this.whitelistIps.includes(address)) {
          this.whitelistIps.push(address)
          changed = true
        }
      }
      if (this.ensureLoopbackRanges()) changed = true

      if (changed) this.save()
      return true
    } catch (err) {
      logError(`白名单更新失败: ${errMsg(err)}`)
      return false
    }
  }

  /** ← 启动自愈（适配 ST 新增 private request filter 特性）：
   *  listen 已开启但私网请求过滤未开启（存量配置 / 手改 config.yaml）时自动补开，
   *  消除 "listen is enabled but private request filter is disabled" 的 SSRF 启动警告。
   *  放行段沿用 create_whitelist 的最小权限语义（仅回环，不自动加当前网段）；
   *  需要放行局域网后端时由用户在设置页"编辑放行网段"自行添加。 */
  async ensurePrivateFilterForListen(): Promise<PrivateFilterHealResult> {
    if (!this.listen || this.privateAddressWhitelistEnabled) return 'ok'
    this.privateAddressWhitelistEnabled = true
    this.ensureLoopbackRanges()
    return this.save() ? 'healed' : 'save-failed'
  }

  /** ← sync_whitelists：unified 模式下 IP/Host 白名单双向同步 */
  syncWhitelists(source: 'ip' | 'host' = 'ip'): void {
    if (source === 'ip') {
      const newHosts: string[] = []
      if (this.hostWhitelistHosts.includes('localhost')) {
        newHosts.push('localhost')
      }
      for (const ip of this.whitelistIps) {
        if (ip.includes(':') && !ip.startsWith('[')) {
          newHosts.push(`[${ip}]`)
        } else {
          newHosts.push(ip)
        }
      }
      this.hostWhitelistHosts = newHosts
    } else {
      const newIps: string[] = []
      for (const host of this.hostWhitelistHosts) {
        if (host === 'localhost') continue
        if (host.startsWith('[') && host.endsWith(']')) {
          const inner = host.slice(1, -1)
          if (isValidIpOrPattern(inner)) newIps.push(inner)
        } else if (isValidIpOrPattern(host)) {
          newIps.push(host)
        }
      }
      this.whitelistIps = newIps
    }
    this.save()
  }

  /** 当前托管字段的纯数据视图 */
  toSnapshot(): StConfigShape {
    return {
      listen: this.listen,
      port: this.port,
      requestProxy: { enabled: this.proxyEnabled, url: this.proxyUrl },
      hostWhitelist: {
        enabled: this.hostWhitelistEnabled,
        scan: this.hostWhitelistScan,
        hosts: [...this.hostWhitelistHosts],
      },
      whitelistMode: this.whitelistMode,
      enableForwardedWhitelist: this.enableForwardedWhitelist,
      whitelist: [...this.whitelistIps],
      unifiedWhitelist: this.unifiedWhitelist,
      privateAddressWhitelist: {
        enabled: this.privateAddressWhitelistEnabled,
        allowUnresolvedHosts: this.privateAddressAllowUnresolvedHosts,
        log: {
          blockedRequests: this.privateAddressLogBlocked,
          allowedRequests: this.privateAddressLogAllowed,
        },
        allowedRanges: [...this.privateAddressAllowedRanges],
      },
    }
  }
}

/** ← sync_whitelists 内嵌的 is_valid_ip_or_pattern（正则逐条对应） */
export function isValidIpOrPattern(entry: string): boolean {
  if (!entry) return false
  if (entry === 'localhost') return false
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}(\.\*)?$/
  const ipv6Pattern = /^[0-9a-fA-F:]+::?[0-9a-fA-F:]*$|^\[[0-9a-fA-F:]+\]$|^[0-9a-fA-F:]+::\*$/
  const ipv4Cidr = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/
  const ipv6Cidr = /^[0-9a-fA-F:]+\/\d{1,3}$/
  const wildcard = /^(\d{1,3}\.){0,3}\*$|^(\d{1,3}\.){0,2}\*\.\*$/
  return (
    ipv4Pattern.test(entry) ||
    ipv6Pattern.test(entry) ||
    ipv4Cidr.test(entry) ||
    ipv6Cidr.test(entry) ||
    wildcard.test(entry)
  )
}

let stConfigInstance: StConfig | null = null

/** 模块级单例：进程内共享一份 config.yaml 视图（stores/settings 委托至此，服务层不反向依赖 stores） */
export function getStConfig(): StConfig {
  if (!stConfigInstance) stConfigInstance = new StConfig()
  return stConfigInstance
}
