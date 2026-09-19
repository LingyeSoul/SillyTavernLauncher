/**
 * ← src/features/sync/manager.py（DataSyncManager）
 *
 * - 服务器/客户端编排：start/stop/sync_from_server。
 * - sync.{enabled,port,host,token} 持久化到 configStore。
 * - LAN 发现：原 254 线程扇出 → 自写并发池（Promise + 限流 20，
 *   探测 http://ip:port/health）——设计计划 §3 顺带改进项。
 * - 数据目录统计（← get_data_info）。
 *
 * DEVIATION: Python _load_config 在构造函数内同步取局域网 IP；
 *   TS 的 os.networkInterfaces 版本为异步，配置加载拆为 initialize()
 *   （语义等价：使用前必须已初始化）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigStore, type ConfigStore } from '../configStore'
import { getLocalIp as defaultGetLocalIp } from '../network'
import { generateSyncToken, createSyncServer, SyncServer, type SyncLogLevel } from './server'
import { SyncClient, formatSize } from './client'

export type SyncLogFn = (message: string, level: SyncLogLevel) => void

export interface DiscoveredServer {
  serverUrl: string
  info: { status?: string; timestamp?: string; auth_required?: boolean }
}

export interface DataSyncManagerOptions {
  dataDir: string
  /** 显式传 null 关闭配置持久化；默认使用全局 configStore */
  configStore?: ConfigStore | null
  getLocalIp?: () => Promise<string | null>
  log?: SyncLogFn
  /** 发现扫描使用的 fetch（默认全局 fetch；测试注入） */
  fetchImpl?: typeof fetch
}

export type SyncStatus = 'idle' | 'syncing' | 'server' | 'error'

/** 简单并发池：最多 concurrency 个任务同时执行（← 254 线程扇出的替代） */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

export class DataSyncManager {
  readonly dataDir: string
  private readonly configStore: ConfigStore | null
  private readonly getLanIp: () => Promise<string | null>
  private readonly logFn: SyncLogFn
  private readonly fetchImpl: typeof fetch

  syncServer: SyncServer | null = null
  isServerRunning = false
  syncStatus: SyncStatus = 'idle'
  lastSyncInfo: Record<string, unknown> = {}
  /** 当前同步任务的取消控制器（存 manager 而非视图，视图卸载后仍可取消） */
  private activeSyncAbort: AbortController | null = null

  serverEnabled = false
  serverPort = 9999
  serverHost = '192.168.1.100'
  authToken = ''

  constructor(options: DataSyncManagerOptions) {
    this.dataDir = options.dataDir
    this.configStore =
      options.configStore === undefined ? getConfigStore() : options.configStore
    this.getLanIp = options.getLocalIp ?? defaultGetLocalIp
    this.logFn = options.log ?? ((message) => console.log(message))
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** ← _load_config（异步：需取局域网 IP 作默认 host） */
  async initialize(): Promise<boolean> {
    const defaultLanIp = (await this.getLanIp()) ?? '192.168.1.100'
    if (this.configStore) {
      this.serverEnabled = this.configStore.get<boolean>('sync.enabled', false)
      this.serverPort = this.configStore.get<number>('sync.port', 9999)
      this.serverHost = this.configStore.get<string>('sync.host', defaultLanIp)
      this.authToken = this.configStore.get<string>('sync.token', '') || generateSyncToken()
    } else {
      this.serverEnabled = false
      this.serverPort = 9999
      // 在没有配置管理器时，也使用局域网IP而不是0.0.0.0
      this.serverHost = defaultLanIp
      this.authToken = generateSyncToken()
    }
    return true
  }

  /** ← _log */
  log(message: string, level: SyncLogLevel = 'info'): void {
    this.logFn(message, level)
  }

  /** ← _save_config */
  private saveConfig(): void {
    if (this.configStore) {
      this.configStore.set('sync.enabled', this.serverEnabled)
      this.configStore.set('sync.port', this.serverPort)
      this.configStore.set('sync.host', this.serverHost)
      this.configStore.set('sync.token', this.authToken)
      this.configStore.save()
    }
  }

  /** ← get_server_url：token 放 fragment（不随请求发送） */
  async getServerUrl(): Promise<string> {
    if (this.serverEnabled) {
      const localIp = (await this.getLanIp()) ?? 'localhost'
      return `http://${localIp}:${this.serverPort}#token=${this.authToken}`
    }
    return ''
  }

  /**
   * ← detect_network_servers：并发限流 20 扫描网段。
   * 192.168.x → 1..254（跳过自身）；10.x → 1..99。
   */
  async detectNetworkServers(
    options: { timeoutSec?: number; port?: number; concurrency?: number } = {},
  ): Promise<DiscoveredServer[]> {
    const timeoutSec = options.timeoutSec ?? 5
    const concurrency = options.concurrency ?? 20
    this.log('正在扫描局域网中的 SillyTavern 同步服务器...', 'info')

    try {
      const localIp = await this.getLanIp()
      if (!localIp) {
        this.log('无法获取本机IP地址', 'error')
        return []
      }

      // Extract network segment
      const ipParts = localIp.split('.')
      const networkBase = ipParts.slice(0, 3).join('.')
      const scanPort = options.port ?? this.serverPort

      this.log(`本地IP地址: ${localIp}`, 'info')
      this.log(`扫描网络段: ${networkBase}.0/24`, 'info')
      this.log(`扫描端口: ${scanPort}`, 'info')

      // Scan common IP ranges based on local IP
      let hostCount = 0
      if (localIp.startsWith('192.168')) {
        hostCount = 255 // last octet 1..254
      } else if (localIp.startsWith('10.')) {
        hostCount = 100 // limited scan for 10.x.x.x
      } else {
        this.log('未发现 SillyTavern 同步服务器', 'warning')
        return []
      }
      const ips: string[] = []
      for (let i = 1; i < hostCount; i++) {
        const ip = `${networkBase}.${i}`
        if (ip !== localIp) ips.push(ip) // Skip self
      }

      const checkIp = async (ip: string): Promise<DiscoveredServer | null> => {
        const url = `http://${ip}:${scanPort}/health`
        try {
          const response = await this.fetchImpl(url, {
            signal: AbortSignal.timeout(timeoutSec * 1000),
          })
          if (response.status === 200) {
            const data = (await response.json()) as DiscoveredServer['info']
            return { serverUrl: `http://${ip}:${scanPort}`, info: data }
          }
          return null
        } catch {
          return null
        }
      }

      const results = await runWithConcurrency(ips, concurrency, checkIp)
      const servers = results.filter((r): r is DiscoveredServer => r !== null)

      if (servers.length > 0) {
        this.log(`发现 ${servers.length} 个 SillyTavern 同步服务器:`, 'success')
        for (let i = 0; i < servers.length; i++) {
          const { serverUrl, info } = servers[i] as DiscoveredServer
          const timestamp = info?.timestamp ?? 'N/A'
          const authStatus = info?.auth_required ? '需要访问令牌' : '无认证'
          this.log(`  ${i + 1}. ${serverUrl} - ${authStatus} - 时间: ${timestamp}`, 'info')
        }
      } else {
        this.log('未发现 SillyTavern 同步服务器', 'warning')
        this.log('请确保:', 'warning')
        this.log('  1. 目标设备已启动 SillyTavern 同步服务', 'warning')
        this.log('  2. 设备在同一局域网内', 'warning')
        this.log('  3. 防火墙允许端口访问', 'warning')
      }

      return servers
    } catch (err) {
      this.log(`网络扫描失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
      return []
    }
  }

  /** ← start_sync_server */
  async startSyncServer(options: { port?: number; host?: string } = {}): Promise<boolean> {
    if (this.isServerRunning) {
      this.log('数据同步服务已在运行', 'warning')
      return true
    }

    if (!existsSync(this.dataDir)) {
      this.log(`错误: 数据目录不存在: ${this.dataDir}`, 'error')
      return false
    }

    try {
      this.serverPort = options.port ?? this.serverPort
      this.serverHost = options.host ?? this.serverHost

      // Initialize sync server（host 显式传入，只绑该网卡）
      this.syncServer = await createSyncServer({
        dataPath: this.dataDir,
        port: this.serverPort,
        host: this.serverHost,
        authToken: this.authToken,
        log: (message, level) => this.log(message, level),
      })
      await this.syncServer.start()

      this.isServerRunning = true
      this.serverEnabled = true
      this.syncStatus = 'server'

      // Save configuration
      this.saveConfig()

      this.log('数据同步服务已启动!', 'success')
      this.log(`服务器地址: ${await this.getServerUrl()}`, 'info')
      this.log(`本地地址: http://localhost:${this.serverPort}`, 'info')
      this.log(`数据路径: ${this.dataDir}`, 'info')

      return true
    } catch (err) {
      this.log(`启动同步服务器失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
      this.syncStatus = 'error'
      return false
    }
  }

  /** ← stop_sync_server */
  async stopSyncServer(): Promise<boolean> {
    if (!this.isServerRunning) {
      this.log('数据同步服务未运行', 'info')
      return true
    }

    try {
      this.isServerRunning = false
      this.serverEnabled = false
      this.syncStatus = 'idle'

      if (this.syncServer) {
        await this.syncServer.stop()
      }
      this.syncServer = null

      this.log('数据同步服务已停止', 'info')

      // Save configuration
      this.saveConfig()

      return true
    } catch (err) {
      this.log(`停止同步服务器失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
      return false
    }
  }

  /** 取消进行中的同步任务；无活动任务返回 false（Bug#2：句柄存 manager） */
  cancelActiveSync(): boolean {
    if (!this.activeSyncAbort) return false
    this.activeSyncAbort.abort()
    this.activeSyncAbort = null
    return true
  }

  /** ← sync_from_server */
  async syncFromServer(
    serverUrl: string,
    options: { method?: 'auto' | 'zip' | 'incremental'; backup?: boolean; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const method = options.method ?? 'auto'
    const backup = options.backup ?? true

    if (this.isServerRunning) {
      console.error('[sync-manager] 错误: 服务器正在运行时无法同步数据')
      return false
    }
    // 重入守卫：同步进行中禁止并发双写（视图卸载重建后尤其容易触发）
    if (this.syncStatus === 'syncing') {
      this.log('已有同步任务进行中，请先等待完成或取消', 'warning')
      return false
    }

    // 取消句柄存 manager；外部传入的 signal 桥接到内部控制器
    const internalAbort = new AbortController()
    this.activeSyncAbort = internalAbort
    if (options.signal) {
      if (options.signal.aborted) internalAbort.abort()
      else options.signal.addEventListener('abort', () => internalAbort.abort(), { once: true })
    }
    const signal = internalAbort.signal

    try {
      this.syncStatus = 'syncing'

      // Initialize sync client
      const client = new SyncClient(serverUrl, this.dataDir, {
        log: (message) => this.log(message, 'info'),
      })

      // Check server health
      if (!(await client.checkServerHealth(signal))) {
        this.log('无法连接到服务器或服务器不健康', 'error')
        this.syncStatus = 'error'
        return false
      }

      // Get server info
      const serverInfo = await client.getServerInfo(signal)
      if (serverInfo) {
        const info = serverInfo.server_info ?? { file_count: 0, total_size: 0 }
        this.log('服务器信息:', 'info')
        this.log(`  文件数量: ${info.file_count ?? 0}`, 'info')
        this.log(`  总大小: ${formatSize(info.total_size ?? 0)}`, 'info')

        // Store sync info
        this.lastSyncInfo = {
          server_url: serverUrl,
          method,
          timestamp: new Date().toISOString(),
          server_info: info,
          success: false,
        }
      }

      this.log(`开始从服务器同步: ${serverUrl}`, 'info')
      this.log(`同步方法: ${method}`, 'info')
      this.log(`备份现有数据: ${backup ? '是' : '否'}`, 'info')

      const success = await client.sync({
        preferZip: method === 'auto' || method === 'zip',
        backup,
        signal,
      })

      this.lastSyncInfo = { ...this.lastSyncInfo, success }

      if (success) {
        this.log('数据同步完成!', 'success')
        this.syncStatus = 'idle'
        return true
      }
      this.log('数据同步失败!', 'error')
      this.syncStatus = 'error'
      return false
    } catch (err) {
      this.log(`数据同步过程中发生错误: ${err instanceof Error ? err.message : String(err)}`, 'error')
      this.syncStatus = 'error'
      return false
    } finally {
      this.activeSyncAbort = null
    }
  }

  /** ← get_data_info */
  getDataInfo(): {
    data_dir: string
    exists: boolean
    size: number
    size_formatted: string
    file_count: number
  } {
    const info = {
      data_dir: this.dataDir,
      exists: existsSync(this.dataDir),
      size: 0,
      size_formatted: '0B',
      file_count: 0,
    }

    if (info.exists && this.isDirectory(this.dataDir)) {
      let totalSize = 0
      let fileCount = 0
      const stack: string[] = [this.dataDir]
      while (stack.length > 0) {
        const dir = stack.pop() as string
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }
        for (const entry of entries) {
          const filePath = join(dir, entry)
          try {
            const stat = statSync(filePath)
            if (stat.isDirectory()) {
              stack.push(filePath)
            } else {
              totalSize += stat.size
              fileCount += 1
            }
          } catch {
            continue
          }
        }
      }
      info.size = totalSize
      info.size_formatted = formatSize(totalSize)
      info.file_count = fileCount
    }

    return info
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  /** ← get_sync_info */
  async getSyncInfo(): Promise<{
    status: SyncStatus
    is_server_running: boolean
    server_enabled: boolean
    server_host: string
    server_port: number
    server_url: string
    local_ip: string | null
    last_sync: Record<string, unknown>
    data_info: ReturnType<DataSyncManager['getDataInfo']>
  }> {
    return {
      status: this.syncStatus,
      is_server_running: this.isServerRunning,
      server_enabled: this.serverEnabled,
      server_host: this.serverHost,
      server_port: this.serverPort,
      server_url: await this.getServerUrl(),
      local_ip: await this.getLanIp(),
      last_sync: this.lastSyncInfo,
      data_info: this.getDataInfo(),
    }
  }
}
