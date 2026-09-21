/**
 * 环境模式三态化（Embedded-All Phase 1，设计计划 D1/D4/D5）：
 * - env_mode 默认值与 settings 读写往返（快照 + config.json 落盘 + reload 一致）
 * - use_sys_env → env_mode 一次性幂等迁移四例：
 *   true→system / false→portable / 无 use_sys_env 不动 / 已有 env_mode 不迁移且删旧键幂等
 * - detectEnvType 三级探测（D5）：env/ 存在→portable；系统 git+node 达标→system；全无→embedded
 * 全部经注入 baseDir/临时目录 + 假探测束，不依赖宿主机 git/node，不污染仓库。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigStore, SystemEnvProbes } from '../services/configStore'

type EnvModeLiteral = 'portable' | 'system' | 'embedded'

interface SettingsModule {
  useSettings: {
    getState: () => {
      envMode: EnvModeLiteral
      update: (patch: { envMode?: EnvModeLiteral }) => void
      reload: () => void
    }
  }
}

interface ConfigStoreModule {
  ConfigStore: new (configPath: string, baseDir?: string, probes?: SystemEnvProbes) => ConfigStore
}

/** fresh module：configStore 单例指向临时目录，settings store 随之重建（terminalFont 测试同款） */
async function freshModules(tempDir: string): Promise<SettingsModule & ConfigStoreModule & { config: ConfigStore }> {
  vi.resetModules()
  const configMod = (await import('../services/configStore')) as unknown as ConfigStoreModule & {
    getConfigStore: (path?: string) => ConfigStore
  }
  const config = configMod.getConfigStore(join(tempDir, 'config.json'))
  const settings = (await import('../stores/settings')) as unknown as SettingsModule
  return { ...settings, ConfigStore: configMod.ConfigStore, config }
}

/** 首启三级探测假束：探测结果与宿主机解耦 */
const OK_PROBES: SystemEnvProbes = {
  probeGit: () => ({ ok: true }),
  probeNode: () => ({ ok: true }),
}
const FAIL_PROBES: SystemEnvProbes = {
  probeGit: () => ({ ok: false }),
  probeNode: () => ({ ok: false }),
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-envmode-'))
})

afterEach(() => {
  vi.resetModules()
  rmSync(tempDir, { force: true, recursive: true })
})

/** 读临时目录 config.json 为宽松 Record（键存在性断言用） */
function readDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf8')) as Record<string, unknown>
}

describe('env_mode 默认值与 settings 读写', () => {
  it('存量 config 无该键时读取走 fallback portable（不主动写键）', async () => {
    writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ first_run: false }), 'utf8')
    const { useSettings, config } = await freshModules(tempDir)
    expect(useSettings.getState().envMode).toBe('portable')
    expect(config.get<EnvModeLiteral>('env_mode', 'portable')).toBe('portable')
    // "不动"：未发生任何写回前，盘上不新增 env_mode 键
    expect('env_mode' in readDisk()).toBe(false)
  })

  it('update envMode → 快照与 config.json 同步落盘，reload 后一致（三值往返）', async () => {
    const { useSettings, config } = await freshModules(tempDir)
    for (const mode of ['system', 'embedded', 'portable'] as const) {
      useSettings.getState().update({ envMode: mode })
      expect(useSettings.getState().envMode).toBe(mode)
      expect(config.get<EnvModeLiteral>('env_mode', 'portable')).toBe(mode)
      expect(readDisk()['env_mode']).toBe(mode)
      // 写回不残留旧键（迁移语义对新增写同样成立）
      expect('use_sys_env' in readDisk()).toBe(false)
      useSettings.getState().reload()
      expect(useSettings.getState().envMode).toBe(mode)
    }
  })
})

describe('use_sys_env → env_mode 迁移（D1 一次性幂等）', () => {
  it('use_sys_env: true → env_mode=system，旧键从写回中删除', async () => {
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ first_run: false, use_sys_env: true }),
      'utf8',
    )
    const { ConfigStore } = await freshModules(tempDir)
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir)
    expect(store.get<EnvModeLiteral>('env_mode', 'portable')).toBe('system')
    expect(store.get('use_sys_env', 'sentinel')).toBe('sentinel') // 旧键已删
    store.save()
    const disk = readDisk()
    expect(disk['env_mode']).toBe('system')
    expect('use_sys_env' in disk).toBe(false)
  })

  it('use_sys_env: false → env_mode=portable，旧键从写回中删除', async () => {
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ first_run: false, use_sys_env: false }),
      'utf8',
    )
    const { ConfigStore } = await freshModules(tempDir)
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir)
    expect(store.get<EnvModeLiteral>('env_mode', 'system')).toBe('portable')
    store.save()
    const disk = readDisk()
    expect(disk['env_mode']).toBe('portable')
    expect('use_sys_env' in disk).toBe(false)
  })

  it('无 use_sys_env：不迁移不动（已有值原样保留）', async () => {
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ first_run: false, env_mode: 'embedded' }),
      'utf8',
    )
    const { ConfigStore } = await freshModules(tempDir)
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir)
    expect(store.get<EnvModeLiteral>('env_mode', 'portable')).toBe('embedded')
    store.save()
    expect(readDisk()['env_mode']).toBe('embedded')
  })

  it('已有 env_mode：不迁移只删旧键，重复构造幂等', async () => {
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ first_run: false, use_sys_env: true, env_mode: 'portable' }),
      'utf8',
    )
    const { ConfigStore } = await freshModules(tempDir)
    const first = new ConfigStore(join(tempDir, 'config.json'), tempDir)
    // 已有 env_mode 优先：不按 use_sys_env=true 迁移成 system
    expect(first.get<EnvModeLiteral>('env_mode', 'system')).toBe('portable')
    expect(first.get('use_sys_env', 'sentinel')).toBe('sentinel')
    first.save()
    expect('use_sys_env' in readDisk()).toBe(false)

    // 幂等：迁移结果落盘后再次构造，值不变、无新增键
    const second = new ConfigStore(join(tempDir, 'config.json'), tempDir)
    expect(second.get<EnvModeLiteral>('env_mode', 'system')).toBe('portable')
    second.save()
    const disk = readDisk()
    expect(disk['env_mode']).toBe('portable')
    expect('use_sys_env' in disk).toBe(false)
  })
})

describe('detectEnvType 三级探测（D5，首启 checkAndSetEnvType）', () => {
  it('① env/ 存在 → portable（探测短路，不再消费系统探测）', async () => {
    mkdirSync(join(tempDir, 'env'), { recursive: true })
    const { ConfigStore } = await freshModules(tempDir)
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, OK_PROBES)
    expect(store.get<EnvModeLiteral>('env_mode', 'system')).toBe('portable')
  })

  it('② 无 env/ 且系统 git+node 达标 → system', async () => {
    const { ConfigStore } = await freshModules(tempDir)
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, OK_PROBES)
    expect(store.get<EnvModeLiteral>('env_mode', 'portable')).toBe('system')
  })

  it('③ 全无（无 env/ 且系统探测不达标）→ embedded', async () => {
    const { ConfigStore } = await freshModules(tempDir)
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, FAIL_PROBES)
    expect(store.get<EnvModeLiteral>('env_mode', 'portable')).toBe('embedded')
  })

  it('git 与 node 须同时达标：仅 git 达标仍 → embedded', async () => {
    const { ConfigStore } = await freshModules(tempDir)
    const mixed: SystemEnvProbes = { probeGit: () => ({ ok: true }), probeNode: () => ({ ok: false }) }
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, mixed)
    expect(store.get<EnvModeLiteral>('env_mode', 'portable')).toBe('embedded')
  })

  it('非首启（first_run=false）不探测不覆盖已有 env_mode', async () => {
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ first_run: false, env_mode: 'embedded' }),
      'utf8',
    )
    const { ConfigStore } = await freshModules(tempDir)
    // 注入达标探测也不应被消费：若误走首启探测会覆盖成 system，保持 embedded 才证明未触发
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, OK_PROBES)
    expect(store.get<EnvModeLiteral>('env_mode', 'portable')).toBe('embedded')
  })
})
