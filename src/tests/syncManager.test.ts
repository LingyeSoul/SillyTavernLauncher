/**
 * ← manager.py 语义等价测试：sync.* 配置持久化、服务器启动/停止编排、
 * LAN 发现（并发池 + 限流）、数据目录统计、syncFromServer 守卫。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../services/configStore'
import { DataSyncManager, runWithConcurrency } from '../services/sync/manager'

let root: string
let dataDir: string
let configPath: string
let configStore: ConfigStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stlsyncmgr'))
  dataDir = join(root, 'data')
  configPath = join(root, 'config.json')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), '{"v":1}', 'utf8')
  mkdirSync(join(dataDir, 'chats'), { recursive: true })
  writeFileSync(join(dataDir, 'chats', 'room.json'), '{"m":[]}', 'utf8')
  configStore = new ConfigStore(configPath, root)
  configStore.set('use_sys_env', true) // 避免探测 env 目录
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

function makeManager(overrides: Partial<ConstructorParameters<typeof DataSyncManager>[0]> = {}): DataSyncManager {
  return new DataSyncManager({
    dataDir,
    configStore,
    getLocalIp: async () => '192.168.1.50',
    log: () => undefined,
    fetchImpl: (async () => {
      throw new Error('network disabled')
    }) as unknown as typeof fetch,
    ...overrides,
  })
}

describe('配置加载与持久化（← _load_config / _save_config）', () => {
  it('默认值：port 9999、host 为 default_config 内置值（1:1：Python default_config 的 sync.host 同样优先于 LAN IP 回退）、token 生成', async () => {
    const manager = makeManager()
    await manager.initialize()
    expect(manager.serverEnabled).toBe(false)
    expect(manager.serverPort).toBe(9999)
    expect(manager.serverHost).toBe('192.168.96.111')
    expect(manager.authToken.length).toBeGreaterThanOrEqual(32)
  })

  it('从 config 读取已有配置（含持久化 token）', async () => {
    configStore.set('sync.enabled', true)
    configStore.set('sync.port', 7777)
    configStore.set('sync.host', '192.168.1.99')
    configStore.set('sync.token', 'saved-token')
    const manager = makeManager()
    await manager.initialize()
    expect(manager.serverEnabled).toBe(true)
    expect(manager.serverPort).toBe(7777)
    expect(manager.serverHost).toBe('192.168.1.99')
    expect(manager.authToken).toBe('saved-token')
  })

  it('无 configStore 时使用局域网 IP 而非 0.0.0.0', async () => {
    const manager = new DataSyncManager({
      dataDir,
      configStore: null,
      getLocalIp: async () => '10.0.0.5',
      log: () => undefined,
    })
    await manager.initialize()
    expect(manager.serverHost).toBe('10.0.0.5')
  })
})

describe('服务器编排（← start_sync_server / stop_sync_server）', () => {
  it('启动：running/enabled 置位、配置落盘、getServerUrl 携带 token fragment', async () => {
    const manager = makeManager()
    await manager.initialize()
    expect(await manager.startSyncServer({ port: 0, host: '127.0.0.1' })).toBe(true)
    expect(manager.isServerRunning).toBe(true)
    expect(manager.serverEnabled).toBe(true)
    expect(manager.syncStatus).toBe('server')

    const saved = JSON.parse(readFileSync(configPath, 'utf8')) as {
      sync: { enabled: boolean; port: number; host: string; token: string }
    }
    expect(saved.sync.enabled).toBe(true)
    expect(saved.sync.host).toBe('127.0.0.1')
    expect(saved.sync.token).toBe(manager.authToken)

    const url = await manager.getServerUrl()
    expect(url).toContain('#token=')
    expect(url).not.toContain('?token=')
    // token 不出现在 URL query 部分
    expect(url.split('#')[0]).not.toContain(manager.authToken)

    await manager.stopSyncServer()
    expect(manager.isServerRunning).toBe(false)
    expect(manager.serverEnabled).toBe(false)
    const savedAfter = JSON.parse(readFileSync(configPath, 'utf8')) as {
      sync: { enabled: boolean }
    }
    expect(savedAfter.sync.enabled).toBe(false)
  })

  it('数据目录不存在时启动失败', async () => {
    const logs: string[] = []
    const failing = new DataSyncManager({
      dataDir: join(root, 'missing'),
      configStore,
      getLocalIp: async () => '192.168.1.50',
      log: (message) => logs.push(message),
    })
    await failing.initialize()
    expect(await failing.startSyncServer()).toBe(false)
    // Python 同款语义：目录缺失分支只 return False，不改 sync_status
    expect(failing.syncStatus).toBe('idle')
    expect(logs.some((message) => message.includes('数据目录不存在'))).toBe(true)
  })

  it('服务器运行时拒绝客户端同步（← sync_from_server 守卫）', async () => {
    const manager = makeManager()
    await manager.initialize()
    await manager.startSyncServer({ port: 0, host: '127.0.0.1' })
    expect(await manager.syncFromServer('http://127.0.0.1:1#token=x')).toBe(false)
    await manager.stopSyncServer()
  })
})

describe('LAN 发现（← detect_network_servers，并发池版）', () => {
  it('192.168 网段扫描 1..254（跳过自身），发现健康节点', async () => {
    const calls: string[] = []
    const manager = makeManager({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        if (url === 'http://192.168.1.77:9999/health') {
          return new Response(
            JSON.stringify({ status: 'healthy', timestamp: 't', auth_required: true }),
            { status: 200 },
          )
        }
        return new Response('no', { status: 502 })
      }) as typeof fetch,
    })
    await manager.initialize()
    const servers = await manager.detectNetworkServers()
    expect(servers.length).toBe(1)
    expect(servers[0]?.serverUrl).toBe('http://192.168.1.77:9999')
    expect(servers[0]?.info.auth_required).toBe(true)
    // 253 次（254 减去自身 .50）
    expect(calls.length).toBe(253)
    expect(calls).not.toContain('http://192.168.1.50:9999/health')
  })

  it('10.x 网段仅扫描 1..99；非私网前缀返回空', async () => {
    const calls: string[] = []
    const manager = makeManager({
      getLocalIp: async () => '10.1.2.3',
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return new Response('no', { status: 500 })
      }) as typeof fetch,
    })
    await manager.initialize()
    expect(await manager.detectNetworkServers()).toEqual([])
    expect(calls.length).toBe(98) // 1..99 减去自身 .3

    const other = makeManager({ getLocalIp: async () => '172.16.0.1' })
    await other.initialize()
    expect(await other.detectNetworkServers()).toEqual([])
  })

  it('无法获取本机 IP 时返回空', async () => {
    const manager = makeManager({ getLocalIp: async () => null })
    await manager.initialize()
    expect(await manager.detectNetworkServers()).toEqual([])
  })
})

describe('数据目录统计（← get_data_info / get_sync_info）', () => {
  it('统计大小与文件数', () => {
    const manager = makeManager()
    const info = manager.getDataInfo()
    expect(info.exists).toBe(true)
    expect(info.file_count).toBe(2)
    expect(info.size).toBe(
      '{"v":1}'.length + '{"m":[]}'.length,
    )
    expect(info.size_formatted).toMatch(/^15\.0B$/)
  })

  it('getSyncInfo 汇总状态', async () => {
    const manager = makeManager()
    await manager.initialize()
    const info = await manager.getSyncInfo()
    expect(info.status).toBe('idle')
    expect(info.is_server_running).toBe(false)
    expect(info.server_port).toBe(9999)
    expect(info.local_ip).toBe('192.168.1.50')
    expect(info.data_info.file_count).toBe(2)
  })
})

describe('并发池（runWithConcurrency）', () => {
  it('结果有序、并发不超限', async () => {
    let active = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_, i) => i)
    const results = await runWithConcurrency(items, 5, async (item) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return item * 2
    })
    expect(results).toEqual(items.map((i) => i * 2))
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
  })

  it('空输入', async () => {
    expect(await runWithConcurrency([], 5, async (x) => x)).toEqual([])
  })
})
