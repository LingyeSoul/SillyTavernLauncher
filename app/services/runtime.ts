/**
 * 进程运行时适配层：生产宿主为 Bun，vitest 下运行于 Node。
 *
 * - 生产（Bun）：Bun.spawn / Bun.spawnSync / Bun.which（任务要求的主路径）。
 * - 测试（Node）：node:child_process，stdout/stderr 经 Readable.toWeb()
 *   归一化为 web ReadableStream，与 Bun 行为一致。
 *
 * 所有服务统一经由本模块 spawn，保证 windowsHide、数组参数（绝不 shell 拼接）
 * 等纪律只在一处实现。
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import type { Subprocess, SyncSpawnResult } from './types'

export const IS_WINDOWS = process.platform === 'win32'

/** 当前进程是否运行在 Bun 宿主上 */
const hasBun = typeof Bun !== 'undefined'

export interface SpawnAsyncOptions {
  /** 参数数组，逐元素传递给子进程，绝不经 shell 拼接 */
  cmd: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  /** 对应 subprocess.CREATE_NO_WINDOW / Bun.spawn windowsHide */
  windowsHide?: boolean
  /**
   * Windows 上不做 argv 转义，按原样拼接命令行
   * （对应 Python shell=True 的 `cmd.exe /c "..."` 语义，仅 shell 路径使用）。
   */
  verbatim?: boolean
}

/** 异步启动子进程；可执行文件不存在时同步 throw（调用方自行回退/捕获）。 */
export function spawnAsync(options: SpawnAsyncOptions): Subprocess {
  const { cmd, cwd, env, windowsHide = true, verbatim = false } = options
  if (hasBun) {
    // 生产路径：Bun.spawn
    const proc = Bun.spawn(cmd, {
      cwd,
      env: env === undefined ? undefined : (env as Record<string, string>),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide,
      windowsVerbatimArguments: verbatim,
    })
    return {
      pid: proc.pid,
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stderr: proc.stderr as ReadableStream<Uint8Array>,
      exited: proc.exited,
      // 必须是 getter：进程退出后才被填充
      get exitCode() {
        return proc.exitCode
      },
      // bun-types 的 kill 形参为 number | Signals，signal 联合类型收窄后传递
      kill: (signal?: number | string) => proc.kill(signal as never),
    }
  }

  // 测试路径：node:child_process
  const child = nodeSpawn(cmd[0] ?? '', cmd.slice(1), {
    cwd,
    env: env === undefined ? process.env : env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide,
    windowsVerbatimArguments: verbatim,
  })
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? -1))
  })
  // 防止没有 await 者时 rejection 成为 unhandled
  exited.catch(() => undefined)
  return {
    pid: child.pid ?? -1,
    stdout: (child.stdout
      ? Readable.toWeb(child.stdout)
      : new ReadableStream<Uint8Array>()) as ReadableStream<Uint8Array>,
    stderr: (child.stderr
      ? Readable.toWeb(child.stderr)
      : new ReadableStream<Uint8Array>()) as ReadableStream<Uint8Array>,
    exited,
    // 必须是 getter：进程退出后才被填充
    get exitCode() {
      return child.exitCode
    },
    kill: (signal?: number | string) => {
      child.kill(signal as NodeJS.Signals)
    },
  }
}

/** 同步执行命令并捕获输出（对应 Python subprocess.run(capture_output=True)）。 */
export function spawnSyncCmd(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; windowsHide?: boolean } = {},
): SyncSpawnResult {
  const { cwd, env, windowsHide = true } = options
  if (hasBun) {
    const result = Bun.spawnSync(cmd, {
      cwd,
      env: env === undefined ? undefined : (env as Record<string, string>),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide,
    })
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
    }
  }
  const result = nodeSpawnSync(cmd[0] ?? '', cmd.slice(1), {
    cwd,
    env: env === undefined ? process.env : env,
    encoding: 'utf8',
    windowsHide,
  })
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export type WhichFn = (binary: string) => string | null

/** shutil.which / Bun.which 等价：PATH + Windows PATHEXT 探测。 */
export function which(binary: string): string | null {
  if (hasBun) {
    return Bun.which(binary) ?? null
  }
  return nodeWhich(binary)
}

function nodeWhich(binary: string): string | null {
  if (binary.length === 0) return null
  const extensions = IS_WINDOWS ? pathextExtensions(binary) : ['']
  const searchDirs: string[] = []
  if (isAbsolute(binary)) {
    searchDirs.push(join(binary, '..'))
  } else {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir) searchDirs.push(dir)
    }
  }
  for (const dir of searchDirs) {
    for (const ext of extensions) {
      const candidate = isAbsolute(binary)
        ? binary + ext
        : join(dir, binary + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

function pathextExtensions(binary: string): string[] {
  // 与 shutil.which 一致：命令已带 PATHEXT 扩展名时不再追加
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const exts = pathext.split(';').filter(Boolean)
  const lower = binary.toLowerCase()
  if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) return ['']
  return [...exts, '']
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
