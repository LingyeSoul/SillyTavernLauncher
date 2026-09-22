/**
 * ← tests/test_git_utils.py（GitCommandSecurityTests）+ config_manager 行为
 * 迁移为 vitest：单例、点号嵌套 get/set、原子写、exit 自动保存、损坏容错。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigStore, SystemEnvProbes } from '../services/configStore'

interface ConfigStoreModule {
  ConfigStore: new (configPath: string, baseDir?: string, probes?: SystemEnvProbes) => ConfigStore
  getConfigStore: (configPath?: string) => ConfigStore
  __resetConfigStoreForTests: () => void
}

/** 首启三级探测注入用假束（D5）：探测结果与宿主机是否安装 git/node 解耦 */
const OK_PROBES: SystemEnvProbes = {
  probeGit: () => ({ ok: true }),
  probeNode: () => ({ ok: true }),
}
const FAIL_PROBES: SystemEnvProbes = {
  probeGit: () => ({ ok: false }),
  probeNode: () => ({ ok: false }),
}

async function freshModule(): Promise<ConfigStoreModule> {
  vi.resetModules()
  return (await import('../services/configStore')) as unknown as ConfigStoreModule
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-config-'))
})

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true })
})

describe('ConfigStore（← config_manager.py）', () => {
  it('默认配置与 Python default_config 逐字段一致', async () => {
    const { ConfigStore } = await freshModule()
    // baseDir 指向临时目录（无 env/），首启三级探测（注入达标探测）会把 env_mode 置 system
    const store = new ConfigStore(join(tempDir, 'config.json'), tempDir, OK_PROBES)
    expect(store.get('patchgit')).toBe(false)
    expect(store.get('env_mode')).toBe('system')
    expect(store.get('theme')).toBe('dark')
    expect(store.get('first_run')).toBe(true)
    expect(store.get('agreement_accepted')).toBe(false)
    expect(store.get('agreement_version')).toBe('')
    expect(store.get('downloads')).toEqual([])
    expect(store.get('has_started_st')).toBe(false)
    // 镜像源模型（2026-09-21）：enabled + host + auto + speedtest 四段；
    // 新装默认"启用加速镜像 + 自动选优"（host 由启动期测速选定，故初始为空）
    expect(store.get('github.enabled')).toBe(true)
    expect(store.get('github.mirror')).toBe('')
    expect(store.get('github.auto')).toBe(true)
    expect(store.get('github.speedtest.results')).toEqual({})
    expect(store.get('github.speedtest.failed')).toEqual([])
    expect(store.get('github.speedtest.tested_at')).toBe('')
    // 旧镜像映射表保留可读但已 @deprecated（镜像名单收敛到 services/mirrors.ts）
    expect(store.get('github.mirrors.github')).toBe('github.com')
    expect(store.get('github.mirrors.ghproxy')).toBe('gh-proxy.org')
    expect(store.get('github.mirrors.ghllkk')).toBe('gh.llkk.cc')
    expect(store.get('log')).toBe(false)
    expect(store.get('checkupdate')).toBe(false)
    expect(store.get('stcheckupdate')).toBe(false)
    expect(store.get('sync.first_shown')).toBe(false)
    expect(store.get('sync.enabled')).toBe(false)
    expect(store.get('sync.port')).toBe(9999)
    expect(store.get('sync.host')).toBe('192.168.96.111')
    expect(store.get('custom_args')).toBe('')
    // tray 字段保留可读但已 @deprecated（D1）
    expect(store.get('tray')).toBe(false)
    // 静默启动（2026-09-22）：autostart + autostart_hidden + tray 三键组合生效
    expect(store.get('autostart')).toBe(false)
    expect(store.get('autostart_hidden')).toBe(false)
  })

  it('文件不存在时返回默认配置且不落盘（← load_config）', async () => {
    const { ConfigStore } = await freshModule()
    const store = new ConfigStore(join(tempDir, 'config.json'))
    expect(existsSync(join(tempDir, 'config.json'))).toBe(false)
    expect(store.get('first_run')).toBe(true)
  })

  it('损坏的 JSON：备份原文件后回退默认配置（防 exit 保存覆盖用户数据）', async () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, '{not valid json!!!', 'utf8')
    const { ConfigStore } = await freshModule()
    // errorLog 与 configStore 共享同一模块实例（vi.resetModules 后同批求值）
    const { __setErrorLogDirForTests } = await import('../services/errorLog')
    __setErrorLogDirForTests(join(tempDir, 'logs'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new ConfigStore(configPath)
    errSpy.mockRestore()
    expect(store.get('theme')).toBe('dark')
    // 损坏原文被备份，不会被 exit 自动保存的默认配置无痕覆盖
    const backups = readdirSync(tempDir).filter((name) => name.startsWith('config.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(tempDir, backups[0] ?? ''), 'utf8')).toBe('{not valid json!!!')
    // 错误进入 Error_*.txt 文件通道（← AppLogger ERROR 文件 handler）
    expect(
      readdirSync(join(tempDir, 'logs')).some((name) => /^Error_\d{8}_\d{6}\.txt$/.test(name)),
    ).toBe(true)
  })

  it('点号嵌套 get/set，set 创建中间对象（← get/set）', async () => {
    const { ConfigStore } = await freshModule()
    const store = new ConfigStore(join(tempDir, 'config.json'))
    store.set('github.mirror', 'gh.llkk.cc')
    expect(store.get('github.mirror')).toBe('gh.llkk.cc')
    // 深层缺失键返回默认值
    expect(store.get('a.b.c', 'fallback')).toBe('fallback')
    // set 自动创建中间层
    store.set('a.b.c', 42)
    expect(store.get('a.b.c')).toBe(42)
    // update 批量
    store.update({ 'x.y': 1, 'github.mirror': 'github.com' })
    expect(store.get('x.y')).toBe(1)
    expect(store.get('github.mirror')).toBe('github.com')
  })

  it('保存为 4 空格缩进 JSON 且不残留 .tmp（原子写）', async () => {
    const configPath = join(tempDir, 'config.json')
    const { ConfigStore } = await freshModule()
    const store = new ConfigStore(configPath)
    store.set('theme', 'light')
    store.save()
    expect(existsSync(`${configPath}.tmp`)).toBe(false)
    const raw = readFileSync(configPath, 'utf8')
    expect(raw.startsWith('{\n    "patchgit": false,')).toBe(true)
    const parsed = JSON.parse(raw) as { theme: string; github: { mirror: string } }
    expect(parsed.theme).toBe('light')
    expect(parsed.github.mirror).toBe('')
    // 重新加载读到修改后的值（← reload）
    store.set('theme', 'dark')
    store.reload()
    expect(store.get('theme')).toBe('light')
  })

  // 2026-09-21 镜像源增强：旧配置（只有 github.mirror，哨兵 'github' 表官方源）
  // → 新模型（enabled + host + auto + speedtest）的一次性迁移
  it('旧镜像配置迁移：真镜像名 → enabled=true 且保留 host（升级不丢加速）', async () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ theme: 'dark', github: { mirror: 'gh.llkk.cc', mirrors: {} } }),
      'utf8',
    )
    const { ConfigStore } = await freshModule()
    const store = new ConfigStore(configPath)
    expect(store.get('github.enabled')).toBe(true)
    expect(store.get('github.mirror')).toBe('gh.llkk.cc')
    expect(store.get('github.auto')).toBe(true)
    expect(store.get('github.speedtest.tested_at')).toBe('')
  })

  it('旧镜像配置迁移：哨兵 github → 官方源（enabled=false，host 清空）', async () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ github: { mirror: 'github' } }), 'utf8')
    const { ConfigStore } = await freshModule()
    const store = new ConfigStore(configPath)
    expect(store.get('github.enabled')).toBe(false)
    expect(store.get('github.mirror')).toBe('')
  })

  it('新模型配置不被迁移覆盖（幂等：已有 enabled 即原样保留）', async () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        github: { enabled: false, mirror: 'gh.dpik.top', auto: false, speedtest: { results: {}, failed: [], tested_at: '' } },
      }),
      'utf8',
    )
    const { ConfigStore } = await freshModule()
    const store = new ConfigStore(configPath)
    expect(store.get('github.enabled')).toBe(false)
    expect(store.get('github.mirror')).toBe('gh.dpik.top')
    expect(store.get('github.auto')).toBe(false)
  })

  it('首次运行时按 env/ 目录探测环境类型（← _check_and_set_env_type，D5 三级）', async () => {
    const { ConfigStore } = await freshModule()
    // 无 env/ 目录 + 系统 git/node 探测达标 → 系统环境
    const withoutEnv = new ConfigStore(join(tempDir, 'a', 'config.json'), tempDir, OK_PROBES)
    expect(withoutEnv.get('env_mode')).toBe('system')
    // 有 env/ 目录 → 便携环境（① 级短路，探测不再被消费）
    mkdirSync(join(tempDir, 'b', 'env'), { recursive: true })
    const withEnv = new ConfigStore(join(tempDir, 'b', 'config.json'), join(tempDir, 'b'), OK_PROBES)
    expect(withEnv.get('env_mode')).toBe('portable')
    // 全无（无 env/ 且系统 git/node 探测不达标）→ embedded
    const bare = new ConfigStore(join(tempDir, 'c', 'config.json'), tempDir, FAIL_PROBES)
    expect(bare.get('env_mode')).toBe('embedded')
  })

  it('getConfigStore 单例：首次路径生效，后续忽略（← ConfigManager 单例）', async () => {
    const { getConfigStore } = await freshModule()
    const first = getConfigStore(join(tempDir, 'one', 'config.json'))
    const second = getConfigStore(join(tempDir, 'two', 'config.json'))
    expect(second).toBe(first)
    first.set('theme', 'light')
    expect(second.get('theme')).toBe('light')
  })

  it('注册 exit 自动保存，saveOnExit 失败被吞掉（← atexit._save_on_exit）', async () => {
    const { getConfigStore } = await freshModule()
    // saveOnExit 失败现走 logError：重定向文件通道到 tempDir，防止写 src/logs/ 污染仓库
    const { __setErrorLogDirForTests } = await import('../services/errorLog')
    __setErrorLogDirForTests(join(tempDir, 'logs'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = process.listenerCount('exit')
    mkdirSync(join(tempDir, 'exit'), { recursive: true })
    const configPath = join(tempDir, 'exit', 'config.json')
    const store = getConfigStore(configPath)
    expect(process.listenerCount('exit')).toBeGreaterThan(before)
    store.set('theme', 'light')
    // 直接调用退出保存路径
    store.saveOnExit()
    expect((JSON.parse(readFileSync(configPath, 'utf8')) as { theme: string }).theme).toBe('light')
    // 目录被删后保存失败也不抛出，且错误落盘 Error_*.txt
    rmSync(join(tempDir, 'exit'), { force: true, recursive: true })
    expect(() => store.saveOnExit()).not.toThrow()
    const logFiles = readdirSync(join(tempDir, 'logs'))
    expect(logFiles).toHaveLength(1)
    expect(readFileSync(join(tempDir, 'logs', logFiles[0] ?? ''), 'utf8')).toContain('配置保存失败')
  })
})
