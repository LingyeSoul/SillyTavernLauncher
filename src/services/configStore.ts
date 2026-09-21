/**
 * ← src/config/config_manager.py（ConfigManager）
 *
 * - 模块级单例（JS 单线程，无需 Python 的双重检查锁）。
 * - 点号分隔嵌套键 get/set/update/reload。
 * - 原子写：.tmp + rename（Python: os.replace）。
 * - process.on('exit') 自动保存（对应 atexit.register）。
 * - config.json schema 与 Python default_config 完全一致（设计计划 D1：配置兼容）。
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomicFs'
import { probeSystemGit, probeSystemNode } from './env'
import { logError } from './errorLog'

/**
 * 运行环境模式（设计计划 D1/D5）：
 * - portable：内置懒人包环境（<root>/env 的 git/node/npm）
 * - system：系统环境（PATH 上的 Git + Node.js）
 * - embedded：启动器内置运行时（Bun + isomorphic-git，实验性）
 */
export type EnvMode = 'portable' | 'system' | 'embedded'

/** detectEnvType 第②级的系统 git/node 探测束（测试可注入假探测；默认 env.ts 真实探测） */
export interface SystemEnvProbes {
  probeGit: () => { ok: boolean }
  probeNode: () => { ok: boolean }
}

export interface LauncherConfig {
  patchgit: boolean
  /**
   * @deprecated 设计计划 D1：已被 env_mode 取代。字段仅为旧配置兼容保留
   * （构造时一次性迁移消费，随后即从写回中删除），请勿在新代码中消费它。
   */
  use_sys_env: boolean
  env_mode: EnvMode
  theme: string
  first_run: boolean
  /** 用户是否已同意使用协议 */
  agreement_accepted: boolean
  /** 协议版本 */
  agreement_version: string
  /** 用户下载行为记录 */
  downloads: unknown[]
  /** 用户是否已首次启动过 SillyTavern */
  has_started_st: boolean
  github: {
    mirror: string
    mirrors: {
      github: string
      ghproxy: string
      ghllkk: string
    }
  }
  log: boolean
  checkupdate: boolean
  stcheckupdate: boolean
  /**
   * @deprecated 设计计划 D1：托盘功能暂不迁移。字段仅为旧配置兼容保留，
   * 读取但忽略（设置界面不再展示该开关），请勿在新代码中消费它。
   */
  tray: boolean
  autostart: boolean
  auto_proxy: boolean
  custom_args: string
  use_optimize_args: boolean
  sync: {
    first_shown: boolean
    enabled: boolean
    port: number
    host: string
  }
}

/** 与 Python default_config 逐字段一致（env_mode 为 D1 新增三态键） */
const DEFAULT_CONFIG: LauncherConfig = {
  patchgit: false,
  use_sys_env: false,
  env_mode: 'portable',
  theme: 'dark',
  first_run: true,
  agreement_accepted: false,
  agreement_version: '',
  downloads: [],
  has_started_st: false,
  github: {
    mirror: 'gh-proxy.org',
    mirrors: {
      github: 'github.com',
      ghproxy: 'gh-proxy.org',
      ghllkk: 'gh.llkk.cc',
    },
  },
  log: false,
  checkupdate: false,
  stcheckupdate: false,
  tray: false,
  autostart: false,
  auto_proxy: false,
  custom_args: '',
  use_optimize_args: false,
  sync: {
    first_shown: false,
    enabled: false,
    port: 9999,
    host: '192.168.96.111',
  },
}

export class ConfigStore {
  private config: LauncherConfig
  private readonly configPath: string
  /** env 目录探测基准目录（Python 用 os.getcwd()；测试可注入） */
  private readonly baseDir: string
  /** 系统 git/node 探测束（detectEnvType 第②级；测试可注入，默认真实探测） */
  private readonly probes: SystemEnvProbes

  constructor(configPath: string, baseDir?: string, probes?: SystemEnvProbes) {
    this.configPath = configPath
    this.baseDir = baseDir ?? process.cwd()
    this.probes = probes ?? { probeGit: probeSystemGit, probeNode: probeSystemNode }
    this.config = this.loadConfig()
    this.migrateUseSysEnv()
    // 首次运行时检查环境类型（与 Python __init__ 一致）
    if (this.get<boolean>('first_run', true)) {
      this.checkAndSetEnvType()
    }
  }

  /** ← load_config：文件不存在返回默认（不落盘）；损坏时先备份再回退默认 */
  loadConfig(): LauncherConfig {
    if (!existsSync(this.configPath)) {
      return structuredClone(DEFAULT_CONFIG)
    }
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf8')) as LauncherConfig
    } catch (err) {
      // 损坏文件必须先备份：否则 exit 自动保存会把默认配置写回，
      // 用户原配置被无痕覆盖（Python 版静默返回默认，无此防护）
      logError(
        `config.json 解析失败，已备份损坏文件并回退默认配置: ${err instanceof Error ? err.message : String(err)}`,
      )
      this.backupCorruptConfig()
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  /** 损坏配置备份为 <configPath>.corrupt-<时间戳>（尽力而为，失败仅记日志） */
  private backupCorruptConfig(): void {
    try {
      const now = new Date()
      const pad = (value: number) => String(value).padStart(2, '0')
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      copyFileSync(this.configPath, `${this.configPath}.corrupt-${stamp}`)
    } catch (err) {
      logError(`备份损坏的配置文件失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** ← save_config：原子写；失败时抛出（调用方决定是否吞掉） */
  save(configData?: LauncherConfig): void {
    const data = configData ?? this.config
    try {
      atomicWriteFileSync(this.configPath, JSON.stringify(data, null, 4))
    } catch (err) {
      throw new Error(`保存配置文件失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** ← _save_on_exit：退出时保存，失败只记录不抛出 */
  saveOnExit(): void {
    try {
      this.save()
    } catch (err) {
      // 退出期错误同样落盘（logs/Error_*.txt），console.warn 会随进程死亡丢失
      logError(`配置保存失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** ← get：点号分隔嵌套键，如 "github.mirror" */
  get<T = unknown>(key: string, defaultValue?: T): T {
    let value: unknown = this.config
    for (const part of key.split('.')) {
      if (value === null || typeof value !== 'object') return defaultValue as T
      value = (value as Record<string, unknown>)[part]
    }
    return (value === undefined ? defaultValue : value) as T
  }

  /** ← set：逐层创建中间对象后赋值 */
  set(key: string, value: unknown): void {
    const parts = key.split('.')
    let cursor: Record<string, unknown> = this.config as unknown as Record<string, unknown>
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part]
      if (typeof next !== 'object' || next === null) {
        cursor[part] = {}
      }
      cursor = cursor[part] as Record<string, unknown>
    }
    cursor[parts[parts.length - 1] ?? ''] = value
  }

  /** ← update：批量更新 */
  update(updates: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(updates)) {
      this.set(key, value)
    }
  }

  /** ← reload */
  reload(): void {
    this.config = this.loadConfig()
  }

  /** ← _detect_env_type（设计计划 D5 三级化）：
   *  ① <root>/env 存在 → portable；② 系统 git+node 探测达标 → system；③ 否则 → embedded */
  private detectEnvType(): EnvMode {
    if (existsSync(join(this.baseDir, 'env'))) return 'portable'
    if (this.probes.probeGit().ok && this.probes.probeNode().ok) return 'system'
    return 'embedded'
  }

  /** ← _check_and_set_env_type：仅首启时按探测结果写 env_mode */
  private checkAndSetEnvType(): void {
    this.set('env_mode', this.detectEnvType())
  }

  /**
   * 设计计划 D1 一次性幂等迁移：use_sys_env → env_mode。
   * - 存在 use_sys_env 且不存在 env_mode：true → 'system'，其余值 → 'portable'；
   * - 已有 env_mode：不迁移（保留现值）；
   * - 两种情况下均从内存/写回中删除 use_sys_env 旧键（删键本身幂等）。
   */
  private migrateUseSysEnv(): void {
    const raw = this.config as unknown as Record<string, unknown>
    if (!('use_sys_env' in raw)) return
    if (!('env_mode' in raw)) {
      raw.env_mode = raw['use_sys_env'] === true ? 'system' : 'portable'
    }
    delete raw['use_sys_env']
  }
}

let singleton: ConfigStore | null = null

/**
 * ← 全局 config_manager 实例。首次调用创建并注册 exit 自动保存；
 * 之后忽略 configPath（与 Python 单例忽略后续参数一致）。
 */
export function getConfigStore(configPath?: string): ConfigStore {
  if (!singleton) {
    singleton = new ConfigStore(configPath ?? join(process.cwd(), 'config.json'))
    // ← atexit.register(self._save_on_exit)
    process.on('exit', () => {
      singleton?.saveOnExit()
    })
  }
  return singleton
}

/** 仅供测试重置单例使用 */
export function __resetConfigStoreForTests(): void {
  singleton = null
}
