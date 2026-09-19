/**
 * ← src/utils/logger.py（AppLogger）的 ERROR 文件通道等价物。
 *
 * - console 输出原样透传（现有终端输出与 e2e 断言不感知本模块）。
 * - 首次 ERROR 时懒创建 logs/Error_YYYYMMdd_HHmmss.txt（← _ensure_file_handler，
 *   无错误不产生空文件），此后只追加 ERROR 级别行，行格式对齐 Python
 *   '[%(asctime)s] [ERROR] SillyTavernLauncher - %(message)s'。
 * - 文件通道失败一次即永久降级 console-only（← _file_handler_failed），
 *   日志模块自身绝不向调用方抛错。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let logDir = join(process.cwd(), 'logs')
let logFilePath: string | null = null
let fileChannelFailed = false

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** ← Formatter(datefmt='%Y-%m-%d %H:%M:%S') */
function formatTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  )
}

/** 文件名时间戳（← Error_%Y%m%d_%H%M%S.txt） */
function formatStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  )
}

function formatArg(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** ERROR 及以上级别专用：console 原样输出 + 追加 logs/Error_*.txt（懒创建） */
export function logError(...args: unknown[]): void {
  console.error(...args)
  if (fileChannelFailed) return
  try {
    if (logFilePath === null) {
      mkdirSync(logDir, { recursive: true })
      logFilePath = join(logDir, `Error_${formatStamp(new Date())}.txt`)
    }
    const message = args.map(formatArg).join(' ')
    appendFileSync(logFilePath, `[${formatTimestamp(new Date())}] [ERROR] SillyTavernLauncher - ${message}\n`, 'utf8')
  } catch {
    // ← _file_handler_failed：创建/追加失败只降级，绝不影响业务路径
    fileChannelFailed = true
  }
}

/** 仅供测试重定向日志目录使用 */
export function __setErrorLogDirForTests(dir: string): void {
  logDir = dir
  logFilePath = null
  fileChannelFailed = false
}
