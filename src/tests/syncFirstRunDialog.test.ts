/**
 * 首启同步警告门控（SyncFirstRunDialog 导出的纯函数）：
 * ← Flet _should_show_first_server_dialog / _mark_first_server_dialog_shown。
 * - 未显示过 → true；已显示过 → false；读取出错兜底 true（宁可多提醒）
 * - 勾选「不再显示」→ sync.first_shown=true 原子落盘（新实例重读验证）
 * - 持久化失败不抛（logError 吞掉，防中断启动流程）
 * 全部经注入 baseDir/临时目录构造 ConfigStore，不污染仓库。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigStore } from '../services/configStore'

interface DialogModule {
  shouldShowFirstRunDialog: (config: {
    get<T = unknown>(key: string, defaultValue?: T): T
  }) => boolean
  persistFirstRunShown: (config: {
    get<T = unknown>(key: string, defaultValue?: T): T
    set(key: string, value: unknown): void
    save(): void
  }) => void
}

/** fresh module：configStore/dialog 模块同批求值，errorLog 重定向到本文件临时目录 */
async function freshModules(): Promise<DialogModule & { ConfigStore: new (configPath: string, baseDir?: string) => ConfigStore }> {
  vi.resetModules()
  const configMod = await import('../services/configStore')
  const { __setErrorLogDirForTests } = await import('../services/errorLog')
  // 重定向必须落在同一个 fresh 实例上（dialog 内 logError 用的就是它）——
  // 不调这句时「持久化失败」用例的 logError 会按模块加载时 cwd 建 src/logs/，污染仓库
  __setErrorLogDirForTests(tempDir)
  const dialog = (await import('../ui/dialogs/SyncFirstRunDialog')) as unknown as DialogModule
  return { ...dialog, ConfigStore: configMod.ConfigStore }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-sync-first-'))
})

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true })
})

describe('首启同步警告门控（← sync_ui.py）', () => {
  it('未显示过（默认配置）→ true', async () => {
    const { ConfigStore, shouldShowFirstRunDialog } = await freshModules()
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir)
    expect(store.get<boolean>('sync.first_shown', false)).toBe(false)
    expect(shouldShowFirstRunDialog(store)).toBe(true)
  })

  it('已显示过（sync.first_shown=true）→ false', async () => {
    const { ConfigStore, shouldShowFirstRunDialog } = await freshModules()
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir)
    store.set('sync.first_shown', true)
    expect(shouldShowFirstRunDialog(store)).toBe(false)
  })

  it('读取出错兜底 → true（旧版 except: return True）', async () => {
    const { shouldShowFirstRunDialog } = await freshModules()
    const broken = {
      get: () => {
        throw new Error('boom')
      },
    }
    expect(shouldShowFirstRunDialog(broken)).toBe(true)
  })

  it('勾选「不再显示」→ sync.first_shown=true 真实落盘（新实例重读 + JSON 文本）', async () => {
    const { ConfigStore, persistFirstRunShown, shouldShowFirstRunDialog } = await freshModules()
    const configPath = join(tempDir, 'config.json')
    const store = new ConfigStore(configPath, tempDir)
    persistFirstRunShown(store)

    // 文件真实写出且值为 true
    expect(existsSync(configPath)).toBe(true)
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      sync?: { first_shown?: boolean }
    }
    expect(raw.sync?.first_shown).toBe(true)

    // 新实例（模拟下次启动）读到已显示 → 门控关闭
    const reopened = new ConfigStore(configPath, tempDir)
    expect(reopened.get<boolean>('sync.first_shown', false)).toBe(true)
    expect(shouldShowFirstRunDialog(reopened)).toBe(false)
  })

  it('持久化失败（目录被删）不抛：logError 吞掉，不中断启动流程', async () => {
    const { ConfigStore, persistFirstRunShown } = await freshModules()
    const gone = join(tempDir, 'gone')
    const store = new ConfigStore(join(gone, 'config.json'), gone)
    rmSync(gone, { force: true, recursive: true })
    expect(() => persistFirstRunShown(store)).not.toThrow()
    // 内存态已置位（下次 exit 自动保存仍会兜底写出）
    expect(store.get<boolean>('sync.first_shown', false)).toBe(true)
  })
})
