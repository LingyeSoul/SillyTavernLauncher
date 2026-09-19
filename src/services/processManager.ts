/**
 * ← src/core/terminal.py 的进程管理部分（execute_process_async 的 spawn 逻辑、
 * 流读取、两阶段停止、同步硬杀）。日志 UI / 批处理 / 150 行上限等 Flet 补丁
 * 全部不迁移（设计计划 D3：完整缓冲由 stores 层负责）。
 *
 * 语义保持（设计计划 §7）：
 * - windowsHide: true（对应 CREATE_NO_WINDOW）。
 * - env 构造：NODE_ENV=production + PATH 前置便携 env + FORCE_COLOR=1。
 * - .cmd/.bat 走 shell（cmd /d /s /c + Windows 引号规则）。
 * - 行流读取：ReadableStream + 手动 \n 分割，UTF-8 解码 errors=replace 等价，
 *   >64KB 长行保留首块、丢弃溢出部分（对应 _safe_readline）。
 * - 两阶段停止：TERM 等 2s → KILL 等 1s；Windows 上 TERM 无效，
 *   直接 taskkill /pid <pid> /T /F 杀整棵进程树。
 * - 退出时同步硬杀（process.on('exit')）。
 */
import { basename, delimiter } from 'node:path'
import { resolveExecutableExtension } from './env'
import { isFile, IS_WINDOWS, spawnAsync, spawnSyncCmd } from './runtime'
import type { LogLine, ProcessInfo, Subprocess } from './types'

/** ← asyncio StreamReader 默认 64KB 行缓冲上限 */
export const MAX_LINE_BYTES = 64 * 1024
export const TERM_GRACE_MS = 2000
export const KILL_GRACE_MS = 1000

// ---------------------------------------------------------------------------
// 活动进程注册表（← active_processes + _active_processes_lock；JS 单线程免锁）
// ---------------------------------------------------------------------------

const activeProcesses = new Map<number, ProcessInfo>()

export function registerProcess(proc: Subprocess, command: string, kind?: string): ProcessInfo {
  const info: ProcessInfo = {
    pid: proc.pid,
    command,
    createdAt: Date.now(),
    proc,
    whenSettled: Promise.resolve(),
    kind,
  }
  activeProcesses.set(proc.pid, info)
  return info
}

/** ← remove_process */
export function removeProcess(pid: number): boolean {
  return activeProcesses.delete(pid)
}

export function getActiveProcesses(): ProcessInfo[] {
  return [...activeProcesses.values()]
}

export function getActiveProcessesCount(): number {
  return activeProcesses.size
}

/** 是否存在指定语义分类的活动进程（'st-server' = SillyTavern 服务本体） */
export function hasActiveProcess(kind: string): boolean {
  for (const info of activeProcesses.values()) {
    if (info.kind === kind) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 命令解析（← shlex.split(posix=False) + subprocess.list2cmdline）
// ---------------------------------------------------------------------------

/**
 * shlex.split(command, posix=False) 等价：空白分隔，引号分组且引号保留在 token 内。
 * 未闭合引号抛错（对应 shlex 的 ValueError "No closing quotation"）。
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let hasToken = false
  let quote: '"' | "'" | null = null
  for (const ch of command) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      hasToken = true
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
    } else {
      current += ch
      hasToken = true
    }
  }
  if (quote !== null) {
    throw new Error('No closing quotation')
  }
  if (hasToken) tokens.push(current)
  return tokens
}

/** 剥掉成对包裹的同种引号（← executable.strip('"').strip("'") 及批处理参数归一） */
export function stripSurroundingQuotes(arg: string): string {
  if (
    arg.length >= 2 &&
    (arg[0] === '"' || arg[0] === "'") &&
    arg[0] === arg[arg.length - 1]
  ) {
    return arg.slice(1, -1)
  }
  return arg
}

/** subprocess.list2cmdline 的单参数 Windows 引号规则（MSVCRT） */
export function windowsQuoteArg(arg: string): string {
  const result: string[] = []
  const backslashes: string[] = []
  const needQuote = arg === '' || /[\t "]/.test(arg)
  if (needQuote) result.push('"')
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes.push(ch)
    } else if (ch === '"') {
      result.push('\\'.repeat(backslashes.length * 2))
      backslashes.length = 0
      result.push('\\"')
    } else {
      if (backslashes.length > 0) {
        result.push(...backslashes)
        backslashes.length = 0
      }
      result.push(ch)
    }
  }
  // 尾部反斜杠在闭引号前翻倍；保持 bs_buf 不清空以复现 CPython 行为
  if (backslashes.length > 0) result.push(...backslashes)
  if (needQuote) {
    result.push('\\'.repeat(backslashes.length))
    result.push('"')
  }
  return result.join('')
}

// ---------------------------------------------------------------------------
// 行流读取（← _safe_readline + _read_stream_output）
// ---------------------------------------------------------------------------

const NEWLINE_BYTE = 0x0a

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * 逐行消费进程输出流：
 * - 手动 \n 分割缓冲；
 * - TextDecoder 非致命解码（无效序列替换为 U+FFFD，等价 Python errors='replace'）；
 * - 行尾 \r/\n 剥离（等价 rstrip('\r\n')）；
 * - 空行跳过（Python 只输出非空行）；
 * - 超 64KB 的长行保留首个 64KB 块、丢弃溢出部分。
 */
export async function readStreamLines(
  stream: ReadableStream<Uint8Array> | null | undefined,
  streamTag: 'stdout' | 'stderr',
  onLine: (line: LogLine) => void,
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  // DEVIATION: Python 对无效 UTF-8 逐字节替换；TextDecoder 按最大无效子串替换，
  // 极少数序列的替换字符数量可能不同，替换语义一致。
  const decoder = new TextDecoder('utf-8')
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let discarding = false

  const emitLine = (bytes: Uint8Array): void => {
    const text = decoder.decode(bytes).replace(/[\r\n]+$/, '')
    if (text) onLine({ stream: streamTag, text })
  }

  const drainCompleteLines = (): void => {
    for (;;) {
      const newlineIndex = buffer.indexOf(NEWLINE_BYTE)
      if (newlineIndex === -1) break
      let lineBytes = buffer.subarray(0, newlineIndex)
      buffer = buffer.subarray(newlineIndex + 1)
      if (discarding) {
        // 超长行的溢出尾部：丢弃（对应 _safe_readline 的 is_discarding 分支）
        discarding = false
        continue
      }
      // 单块内的完整超长行同样截断为首 64KB
      if (lineBytes.length > MAX_LINE_BYTES) {
        lineBytes = lineBytes.subarray(0, MAX_LINE_BYTES)
      }
      emitLine(lineBytes)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      buffer = buffer.length === 0 ? value : concatBytes(buffer, value)
      drainCompleteLines()
      if (buffer.length > MAX_LINE_BYTES) {
        if (!discarding) {
          // 首个溢出块需要保存
          emitLine(buffer.subarray(0, MAX_LINE_BYTES))
          discarding = true
        }
        buffer = new Uint8Array(0)
      }
    }
    // EOF 后残留的未换行结尾
    if (!discarding && buffer.length > 0) {
      emitLine(buffer)
    }
  } catch (err) {
    console.error(
      `[processManager] 读取 ${streamTag.toUpperCase()} 流失败: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 流已关闭
    }
  }
}

// ---------------------------------------------------------------------------
// 进程执行（← execute_process_async）
// ---------------------------------------------------------------------------

export interface ExecuteProcessOptions {
  /** 完整命令字符串（与 Python 一致，内部经 tokenizeCommand 解析） */
  command: string
  cwd: string
  env?: Record<string, string | undefined>
  onLine?: (line: LogLine) => void
  /** 生命周期消息（命令回显、终止进度等；对应 Python 的 add_log 调用点） */
  onEvent?: (message: string) => void
  /** 进程语义分类（'st-server'）；UI running 派生只认该分类 */
  kind?: string
}

/**
 * 异步执行进程并注册到活动进程表。
 * @returns 进程信息；创建失败返回 null（错误经 onEvent 报告）。
 */
export async function executeProcessAsync(
  options: ExecuteProcessOptions,
): Promise<ProcessInfo | null> {
  const { command, cwd, env } = options
  const onLine = options.onLine ?? (() => undefined)
  const onEvent = options.onEvent ?? (() => undefined)
  let proc: Subprocess | null = null

  try {
    onEvent(`${cwd} $ ${command}`)

    const tokens = tokenizeCommand(command)
    if (tokens.length === 0) {
      throw new Error('命令解析为空')
    }
    let executable = stripSurroundingQuotes(tokens[0] ?? '')
    const cmdArgs = tokens.slice(1)

    // Windows 的 Node 包同时包含无扩展名 POSIX 脚本和 .cmd 启动器，
    // 无扩展名时优先探测 Win32 可执行伴生文件（.exe/.cmd/.bat/.ps1）。
    if (IS_WINDOWS && !basename(executable).includes('.')) {
      executable = resolveExecutableExtension(executable)
    }

    if (!isFile(executable)) {
      throw new Error(`找不到可执行文件: ${executable}`)
    }

    // 批处理文件走 shell 方式
    const isBatch = IS_WINDOWS && /\.(cmd|bat)$/i.test(executable)
    if (isBatch) {
      const normalizedArgs = cmdArgs.map(stripSurroundingQuotes)
      const shellCommand = [executable, ...normalizedArgs].map(windowsQuoteArg).join(' ')
      // 与 Python subprocess(shell=True) 完全一致的命令行形态：
      // {ComSpec} /c "{shellCommand}"（verbatim 避免引号被再次转义）
      const comspec = process.env.ComSpec ?? 'cmd.exe'
      proc = spawnAsync({ cmd: [comspec, '/c', `"${shellCommand}"`], cwd, env, verbatim: true })
    } else {
      try {
        proc = spawnAsync({ cmd: [executable, ...cmdArgs], cwd, env })
      } catch (spawnErr) {
        // 回退到 shell 方式（原始命令字符串）
        onEvent(`直接执行失败，使用 shell 方式: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`)
        const comspec = process.env.ComSpec ?? 'cmd.exe'
        proc = spawnAsync({ cmd: [comspec, '/c', `"${command}"`], cwd, env, verbatim: true })
      }
    }

    const info = registerProcess(proc, command, options.kind)
    const stdoutDone = readStreamLines(proc.stdout, 'stdout', onLine)
    const stderrDone = readStreamLines(proc.stderr, 'stderr', onLine)
    info.whenSettled = Promise.all([
      proc.exited.catch(() => undefined),
      stdoutDone,
      stderrDone,
    ]).then(() => {
      removeProcess(info.pid)
    })
    return info
  } catch (err) {
    onEvent(`创建进程失败: ${err instanceof Error ? err.message : String(err)}`)
    // 清理失败的进程
    if (proc) {
      try {
        proc.kill()
      } catch {
        // 忽略
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// 停止进程（← _stop_processes_impl_async / stop_processes_sync）
// ---------------------------------------------------------------------------

/** 等待进程退出，超时返回 false；spawn 失败的 rejection 视为已退出 */
async function waitForExit(proc: Subprocess, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      proc.exited.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    return proc.exitCode !== null
  } catch {
    return true
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 停止所有进程（两阶段终止）。
 * Windows：TERM 无效，直接 taskkill /pid <pid> /T /F 杀整棵进程树后等待。
 * POSIX：SIGTERM 等 2s → SIGKILL 等 1s。
 */
export async function stopAllProcesses(
  onEvent: (message: string) => void = () => undefined,
): Promise<boolean> {
  if (activeProcesses.size === 0) return false
  const processesToStop = [...activeProcesses.values()]
  activeProcesses.clear()

  onEvent(`正在终止 ${processesToStop.length} 个进程...`)

  for (const info of processesToStop) {
    try {
      onEvent(`终止进程 PID=${info.pid}: ${info.command.slice(0, 50)}`)

      if (info.proc.exitCode !== null) {
        onEvent(`  进程 PID=${info.pid} 已停止`)
        continue
      }

      if (IS_WINDOWS) {
        const result = spawnSyncCmd(['taskkill', '/pid', String(info.pid), '/T', '/F'])
        if (result.exitCode !== 0 && result.stderr.trim()) {
          onEvent(`  taskkill 失败: ${result.stderr.trim()}`)
        }
        await waitForExit(info.proc, KILL_GRACE_MS)
      } else {
        // 阶段 1: 优雅终止（SIGTERM），最多等 2s
        try {
          info.proc.kill()
        } catch {
          // 忽略
        }
        if (!(await waitForExit(info.proc, TERM_GRACE_MS))) {
          // 阶段 2: 强制终止（SIGKILL），最多等 1s
          onEvent(`  进程 PID=${info.pid} 优雅退出失败，强制终止...`)
          try {
            info.proc.kill('SIGKILL')
          } catch {
            // 忽略
          }
          await waitForExit(info.proc, KILL_GRACE_MS)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.trim()) {
        onEvent(`终止进程 ${info.pid} 时出错: ${message}`)
      }
    }
  }

  onEvent('✓ 所有进程已终止')
  return true
}

/** 同步硬杀（程序退出时使用；无任何等待） */
export function stopAllProcessesSync(): boolean {
  if (activeProcesses.size === 0) return false
  const processesToStop = [...activeProcesses.values()]
  activeProcesses.clear()
  for (const info of processesToStop) {
    try {
      if (IS_WINDOWS) {
        spawnSyncCmd(['taskkill', '/pid', String(info.pid), '/T', '/F'])
      } else {
        try {
          info.proc.kill('SIGKILL')
        } catch {
          // 忽略
        }
      }
    } catch {
      // 忽略（对应 Python 吞掉退出期异常）
    }
  }
  return true
}

// ← UiEvent 退出路径的兜底：进程退出时同步硬杀活动子进程
process.on('exit', () => {
  stopAllProcessesSync()
})

// ---------------------------------------------------------------------------
// 环境构造（← event.py execute_command 的 env 组装）
// ---------------------------------------------------------------------------

/**
 * 构造子进程环境：NODE_ENV=production + PATH 前置便携 env 目录 + FORCE_COLOR=1。
 * DEVIATION: Python 将路径反斜杠替换为正斜杠后用 ';' 连接；此处用原生分隔符 +
 * path.delimiter，两者在 Windows PATH 解析下等价。
 */
export function buildProcessEnv(prependDirs: string[] = []): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.NODE_ENV = 'production'
  if (prependDirs.length > 0) {
    const current = env.PATH ?? ''
    env.PATH = [...prependDirs, current].filter((p) => p !== '').join(delimiter)
  }
  env.FORCE_COLOR = '1'
  env.PYTHONUNBUFFERED = '1'
  return env
}

// ---------------------------------------------------------------------------
// 自定义启动参数校验（← event.py validate_custom_args，1:1 移植）
// ---------------------------------------------------------------------------

export interface ArgsValidation {
  ok: boolean
  message: string
}

const DANGEROUS_CHARS = ['|', '&', ';', '$', '`', '(', ')', '<', '>', '\n', '\r'] as const

// 对应 Python r"^[\w\-=/:\\.,@%+]+$"：Python \w 在 Unicode 模式下含中文等字母，
// JS 侧用 \p{L}\p{N}\p{M} + 下划线等价展开。
const SAFE_ARG_PART_RE = /^[\p{L}\p{N}\p{M}_\-=/:\\.,@%+]+$/u

/** 验证自定义启动参数，防止命令注入（shell 元字符白名单）。 */
export function validateCustomArgs(args: string): ArgsValidation {
  if (!args || !args.trim()) {
    return { ok: true, message: '' }
  }

  for (const char of DANGEROUS_CHARS) {
    if (args.includes(char)) {
      return { ok: false, message: `参数包含危险字符: '${char}'。请勿使用 shell 命令语法。` }
    }
  }

  const singleQuotes = (args.match(/'/g) ?? []).length
  const doubleQuotes = (args.match(/"/g) ?? []).length
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
    return { ok: false, message: '参数包含未闭合的引号' }
  }

  let parts: string[]
  try {
    parts = tokenizeCommand(args)
  } catch (err) {
    return { ok: false, message: `参数格式错误: ${err instanceof Error ? err.message : String(err)}` }
  }

  for (const part of parts) {
    if (!SAFE_ARG_PART_RE.test(part)) {
      return { ok: false, message: `参数包含非法字符: '${part}'` }
    }
  }
  return { ok: true, message: '' }
}
