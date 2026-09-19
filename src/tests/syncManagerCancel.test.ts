/**
 * Bug#2 配套测试：syncFromServer 取消句柄存 manager（cancelActiveSync）、
 * 重入守卫（并发双写拒绝）、外部 signal 桥接。
 * 用 vi.mock 挂起 SyncClient（仅本文件生效，不影响 syncManager.test.ts 的真实链路）。
 */
import { describe, expect, it, vi } from 'vitest'
import { DataSyncManager } from '../services/sync/manager'

vi.mock('../services/sync/client', () => {
  class FakeSyncClient {
    constructor(
      public serverUrl: string,
      public dataPath: string,
      private options: { log?: (message: string) => void },
    ) {}
    async checkServerHealth(_signal?: AbortSignal): Promise<boolean> {
      return true
    }
    async getServerInfo(_signal?: AbortSignal): Promise<null> {
      return null
    }
    /** 挂起直到 signal 中止（模拟传输中的同步任务） */
    async sync(options: { signal?: AbortSignal }): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const signal = options?.signal
        if (signal?.aborted) {
          resolve(false)
          return
        }
        signal?.addEventListener('abort', () => resolve(false), { once: true })
      })
    }
  }
  return { SyncClient: FakeSyncClient, formatSize: (n: number) => `${n}B` }
})

const SERVER_URL = 'http://192.168.1.9:9999'

function makeManager(logs: string[]): DataSyncManager {
  return new DataSyncManager({
    dataDir: 'unused-by-syncFromServer',
    configStore: null,
    getLocalIp: async () => '192.168.1.50',
    log: (message, level) => logs.push(`${level}:${message}`),
  })
}

describe('syncFromServer 取消与重入守卫（Bug#2）', () => {
  it('无活动任务时 cancelActiveSync 返回 false', () => {
    expect(makeManager([]).cancelActiveSync()).toBe(false)
  })

  it('同步进行中再次发起 → 重入守卫拒绝（并发双写）', async () => {
    const logs: string[] = []
    const manager = makeManager(logs)
    const first = manager.syncFromServer(SERVER_URL)
    expect(await manager.syncFromServer(SERVER_URL)).toBe(false)
    expect(logs.some((message) => message.includes('已有同步任务进行中'))).toBe(true)
    manager.cancelActiveSync()
    expect(await first).toBe(false)
  })

  it('cancelActiveSync 中止进行中的同步（句柄存 manager，视图卸载后仍可取消）', async () => {
    const logs: string[] = []
    const manager = makeManager(logs)
    const first = manager.syncFromServer(SERVER_URL)
    expect(manager.cancelActiveSync()).toBe(true)
    expect(await first).toBe(false)
    expect(manager.syncStatus).toBe('error')
    // 任务结算后句柄已清理
    expect(manager.cancelActiveSync()).toBe(false)
  })

  it('外部 signal 中止桥接到内部任务（调用前已中止）', async () => {
    const manager = makeManager([])
    const external = new AbortController()
    external.abort()
    expect(await manager.syncFromServer(SERVER_URL, { signal: external.signal })).toBe(false)
  })

  it('外部 signal 中止桥接到内部任务（调用后中止）', async () => {
    const manager = makeManager([])
    const external = new AbortController()
    const pending = manager.syncFromServer(SERVER_URL, { signal: external.signal })
    external.abort()
    expect(await pending).toBe(false)
  })
})
