/**
 * 静默启动（config.autostart_hidden，2026-09-22）：
 * - shouldHideAtStartup 判定矩阵：三键齐（autostart + autostart_hidden + tray）
 *   且本轮无交互（非首跑、EULA 已过）才隐藏；任一前置破坏即 fail-safe 不隐藏。
 *   tray 自查是双保险：调用点（app.tsx）已要求托盘真实挂载成功才隐藏，
 *   这里再挡一道"手改 config.json 凑出静默开、托盘关"的组合。
 * - eulaDialogRequired：从 app.tsx StartupFlow 提升的共享口径（未同意/版本
 *   不匹配/缓存缺失 → 弹），静默判定与弹窗判定不得漂移。
 * - settings store：autostartHidden 快照与 config.json 落盘往返。
 * 全部经注入 configPath/临时 cwd + 假探测束，不污染仓库。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../services/configStore'
import type { SystemEnvProbes } from '../services/configStore'

/** 假探测束：探测失败 → env_mode 走 embedded 分支，不 spawn 宿主 git/node */
const FAIL_PROBES: SystemEnvProbes = {
  probeGit: () => ({ ok: false }),
  probeNode: () => ({ ok: false }),
}

const prevCwd = process.cwd()
let tempDir: string

/** 种一份"静默启动全条件满足"的 config + 协议缓存，overrides 逐案破坏一个键 */
function makeConfig(overrides: Record<string, unknown> = {}): ConfigStore {
  const base: Record<string, unknown> = {
    first_run: false,
    agreement_accepted: true,
    agreement_version: '2099-01-01',
    autostart: true,
    autostart_hidden: true,
    tray: true,
  }
  writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ ...base, ...overrides }), 'utf8')
  writeFileSync(
    join(tempDir, 'agreement_cache.json'),
    JSON.stringify({ date: '2099-01-01', content: '# 种子' }),
    'utf8',
  )
  return new ConfigStore(join(tempDir, 'config.json'), tempDir, FAIL_PROBES)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-silent-'))
  // loadAgreementCache 读 process.cwd()/agreement_cache.json → 临时 cwd（AGENTS 纪律）
  process.chdir(tempDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  vi.resetModules()
  rmSync(tempDir, { force: true, recursive: true })
})

describe('shouldHideAtStartup（静默启动判定）', () => {
  it('三键齐 + 非首跑 + EULA 已过 → 隐藏', async () => {
    const { shouldHideAtStartup } = await import('../services/silentStart')
    expect(shouldHideAtStartup(makeConfig())).toBe(true)
  })

  it('默认配置（无 config.json）→ 不隐藏（autostart 默认关）', async () => {
    const { shouldHideAtStartup } = await import('../services/silentStart')
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, FAIL_PROBES)
    expect(shouldHideAtStartup(store)).toBe(false)
  })

  it.each([
    ['autostart 关', { autostart: false }],
    ['autostart_hidden 关', { autostart_hidden: false }],
    ['tray 关（双保险：防手改 config 组合）', { tray: false }],
    ['首跑未完成（欢迎向导需要可见窗口）', { first_run: true }],
    ['EULA 未同意', { agreement_accepted: false }],
    ['EULA 版本与缓存不一致（弹窗需要可见窗口）', { agreement_version: '2000-01-01' }],
  ])('%s → 不隐藏', async (_label, overrides) => {
    const { shouldHideAtStartup } = await import('../services/silentStart')
    expect(shouldHideAtStartup(makeConfig(overrides as Record<string, unknown>))).toBe(false)
  })

  it('协议缓存缺失（按无缓存处理）→ 不隐藏', async () => {
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({
        first_run: false,
        agreement_accepted: true,
        agreement_version: '2099-01-01',
        autostart: true,
        autostart_hidden: true,
        tray: true,
      }),
      'utf8',
    )
    const { shouldHideAtStartup } = await import('../services/silentStart')
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, FAIL_PROBES)
    expect(shouldHideAtStartup(store)).toBe(false)
  })
})

describe('eulaDialogRequired（StartupFlow 与静默判定共享口径）', () => {
  it('未同意 → 弹', async () => {
    const { eulaDialogRequired } = await import('../services/agreement')
    expect(eulaDialogRequired(makeConfig({ agreement_accepted: false }))).toBe(true)
  })

  it('已同意且版本一致 → 不弹', async () => {
    const { eulaDialogRequired } = await import('../services/agreement')
    expect(eulaDialogRequired(makeConfig())).toBe(false)
  })

  it('版本不一致 / 缓存缺失 → 弹', async () => {
    const { eulaDialogRequired } = await import('../services/agreement')
    expect(eulaDialogRequired(makeConfig({ agreement_version: '2000-01-01' }))).toBe(true)
    // 缓存缺失：删掉 agreement_cache.json 后版本无处核对（按无缓存处理 → 弹）
    rmSync(join(tempDir, 'agreement_cache.json'))
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, FAIL_PROBES)
    expect(eulaDialogRequired(store)).toBe(true)
  })
})

describe('settings store：autostartHidden 快照与落盘往返', () => {
  interface SettingsModule {
    useSettings: {
      getState: () => {
        autostartHidden: boolean
        update: (patch: { autostartHidden?: boolean }) => void
        reload: () => void
      }
    }
  }

  /** fresh module：configStore 单例指向临时目录，settings store 随之重建（settings.test 同款） */
  async function freshSettings(): Promise<SettingsModule> {
    const configMod = (await import('../services/configStore')) as unknown as {
      getConfigStore: (path?: string) => ConfigStore
    }
    configMod.getConfigStore(join(tempDir, 'config.json'))
    return (await import('../stores/settings')) as unknown as SettingsModule
  }

  it('默认 false；update true → 快照与 config.json 同步，reload 后一致', async () => {
    writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ first_run: false }), 'utf8')
    const { useSettings } = await freshSettings()
    expect(useSettings.getState().autostartHidden).toBe(false)
    useSettings.getState().update({ autostartHidden: true })
    expect(useSettings.getState().autostartHidden).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(onDisk['autostart_hidden']).toBe(true)
    useSettings.getState().reload()
    expect(useSettings.getState().autostartHidden).toBe(true)
  })
})
