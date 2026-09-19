/**
 * E2E 测试基建：launch() 起真实应用进程（GPUIX_AUTOMATION=1 + GPUIX_BACKGROUND=1），
 * CWD 隔离到 mkdtemp 临时目录（config.json / agreement_cache.json / SillyTavern/
 * 全部落在临时目录，绝不污染 app/config.json 与仓库根 SillyTavern/）。
 *
 * - launch() 的 connectStdio 在子进程启动失败时永不返回（实测 Windows），
 *   故用 Promise.race 加启动超时。
 * - 子进程 pid 通过二次 initialize 握手获取（协议幂等，实测可用），
 *   用于退出检测与 cleanup 前的死亡确认（Windows 下子进程 cwd 会锁住临时目录）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from '@gpuix/react/automation'
import type { App } from '@gpuix/react/automation'

/** 本文件目录（vitest 跑在 Node 下无 import.meta.dir，用 URL 派生） */
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** app.tsx 绝对路径：bun 按文件位置解析 app/node_modules，cwd 仅影响用户数据落盘 */
export const APP_ENTRY = resolve(HERE, '../..', 'app.tsx')

/** 截图输出目录（仓库内，提交用） */
export const SHOTS_DIR = join(HERE, '__shots__')

/** 预置协议缓存（EULA 离线可显示正文；日期与 setupCompleted 种子的 agreement_version 一致） */
export const AGREEMENT_DATE = '2099-01-01'

const LAUNCH_TIMEOUT_MS = 45_000

export interface LaunchOptions {
  /**
   * true → 预置 config.json（first_run=false + agreement_accepted=true +
   * agreement_version=AGREEMENT_DATE + checkupdate=false），跳过首启弹窗直达主界面；
   * false（默认）→ 空临时目录，走完整首启（EULA → 欢迎问答）。
   */
  setupCompleted?: boolean
  /**
   * true → 在 setupCompleted 基础上保留 first_run=true：EULA 已同意不再弹，
   * 只弹欢迎问答（欢迎对话框独占可见，便于单独截图/断言）。
   */
  welcomeOnly?: boolean
  /** 追加子进程环境变量（如 EULA_COUNTDOWN_SECONDS=2 缩短倒计时） */
  env?: Record<string, string>
}

export interface E2ESession {
  /** 自动化客户端（launch() 返回的 App） */
  app: App
  /** 子进程 pid（initialize 握手返回） */
  pid: number
  /** 隔离临时目录（= 应用 process.cwd()） */
  tempDir: string
  configPath: string
  agreementCachePath: string
  stConfigPath: string
  /** 读取临时目录 config.json；不存在返回 null */
  readConfig(): Record<string, unknown> | null
  /** 读取临时目录 SillyTavern/config.yaml 文本；不存在返回 null */
  readStConfigYaml(): string | null
  /** 关闭子进程并等待退出，然后删除临时目录（带重试，Windows 句柄释放有延迟） */
  cleanup(): Promise<void>
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 进程存活探测（Windows/POSIX 通用：kill(pid,0) 存活返回 true，否则抛错） */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** setupCompleted=true 时预置的 config.json（跳过首启弹窗；关闭联网更新检查保证确定性） */
function seedConfig(): Record<string, unknown> {
  return {
    patchgit: false,
    use_sys_env: false,
    theme: 'dark',
    first_run: false,
    agreement_accepted: true,
    agreement_version: AGREEMENT_DATE,
    downloads: [],
    has_started_st: false,
    github: {
      mirror: 'github',
      mirrors: { github: 'github.com', ghproxy: 'gh-proxy.org', ghllkk: 'gh.llkk.cc' },
    },
    log: false,
    checkupdate: false,
    stcheckupdate: false,
    tray: false,
    autostart: false,
    auto_proxy: false,
    custom_args: '',
    use_optimize_args: false,
    sync: { first_shown: false, enabled: false, port: 9999, host: '192.168.96.111' },
  }
}

/**
 * 启动被测应用。断言失败/超时都会先 cleanup 再抛出（由调用方 afterEach 兜底）。
 */
export async function launchE2E(options: LaunchOptions = {}): Promise<E2ESession> {
  const tempDir = mkdtempSync(join(tmpdir(), 'stl-e2e-'))
  const configPath = join(tempDir, 'config.json')
  const agreementCachePath = join(tempDir, 'agreement_cache.json')
  const stConfigPath = join(tempDir, 'SillyTavern', 'config.yaml')

  // EULA 正文离线种子（网络可用时应用会后台刷新为真实协议，不影响流程）
  writeFileSync(
    agreementCachePath,
    JSON.stringify({
      date: AGREEMENT_DATE,
      content: '# 使用协议（E2E 离线种子）\n\nE2E 测试预置协议正文。',
    }),
  )
  if (options.setupCompleted) {
    const seed = seedConfig()
    if (options.welcomeOnly) seed.first_run = true
    writeFileSync(configPath, JSON.stringify(seed, null, 4))
  }

  const app = await Promise.race([
    launch({
      command: 'bun',
      args: [APP_ENTRY],
      cwd: tempDir,
      env: {
        GPUIX_BACKGROUND: '1',
        ...options.env,
      },
    }),
    sleep(LAUNCH_TIMEOUT_MS).then(() => {
      throw new Error(
        `launch() 握手超时（${LAUNCH_TIMEOUT_MS}ms）：子进程未在临时目录 ${tempDir} 启动`,
      )
    }),
  ])

  let pid = 0
  try {
    const init = await app.call('initialize', { protocolVersion: 1, client: 'stl-e2e' })
    pid = init.pid
  } catch (err) {
    await app.close().catch(() => undefined)
    rmSync(tempDir, { recursive: true, force: true })
    throw err
  }

  const readConfig = (): Record<string, unknown> | null => {
    if (!existsSync(configPath)) return null
    try {
      return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  const cleanup = async (): Promise<void> => {
    await app.close().catch(() => undefined)
    // 等子进程真正退出（Windows：进程持有 cwd 句柄，不退出则临时目录删不掉）
    for (let i = 0; i < 100; i++) {
      if (!pidAlive(pid)) break
      await sleep(100)
    }
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
        return
      } catch {
        await sleep(200)
      }
    }
    // 删除失败仅意味着 %TEMP% 残留一个目录，不影响测试结论；抛错反而会掩盖真正的失败原因
  }

  return {
    app,
    pid,
    tempDir,
    configPath,
    agreementCachePath,
    stConfigPath,
    readConfig,
    readStConfigYaml: () => (existsSync(stConfigPath) ? readFileSync(stConfigPath, 'utf8') : null),
    cleanup,
  }
}

/**
 * 断言截图落盘且非空（中文渲染抽检：文件尺寸是"有像素"的下限证据，
 * 视觉正确性由人工/图像模型查看 __shots__ 目录确认）。
 */
export function expectShotExists(name: string, minBytes = 10_000): void {
  const path = join(SHOTS_DIR, name)
  if (!existsSync(path)) throw new Error(`screenshot missing: ${path}`)
  const size = readFileSync(path).length
  if (size < minBytes) throw new Error(`screenshot suspiciously small (${size}B): ${path}`)
}
