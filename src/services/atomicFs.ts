/**
 * 原子文件写入工具：所有落盘一律 .tmp + rename（硬性纪律）。
 * node:fs 的 renameSync 在 Windows 上走 MoveFileExW(REPLACE_EXISTING)，
 * 与 Python os.replace 语义一致。
 *
 * Windows 上目标文件被杀软扫描/编辑器短暂占用时，rename 会瞬时抛
 * EPERM/EACCES/EBUSY/ENOTEMPTY；这类错误通常几十毫秒后消失，故做短退避重试
 * （最多 3 次）。重试仍失败时清理 .tmp 并抛原始错误，调用方仍能拿到可诊断的 code。
 */
import { mkdirSync, renameSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** rename 的瞬时占用错误码（Windows 文件占用/目录非空边界） */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/** 强制落盘尝试次数（含首次） */
const RENAME_MAX_ATTEMPTS = 3

/** 同步 sleep 缓冲：Atomics.wait 不引第三方依赖，且不必把同步写入 API 改成异步 */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms)
}

function isTransientRenameError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as NodeJS.ErrnoException).code
  return code !== undefined && TRANSIENT_RENAME_CODES.has(code)
}

/** rename + 瞬时占用短退避重试；最终失败抛最后一次原始错误 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      if (!isTransientRenameError(err) || attempt === RENAME_MAX_ATTEMPTS - 1) throw err
      // 30ms / 60ms 退避：覆盖杀软扫描与编辑器保存窗口，又不让 UI 长时间卡顿
      sleepSync(30 * (attempt + 1))
    }
  }
}

export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameWithRetry(tmpPath, filePath)
  } catch (err) {
    // 写入/重命名最终失败：残留 .tmp 会挡住后续写入与排查，必须清理；
    // 清理失败不得掩盖原始错误（含 code）供调用方诊断
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // 保留原始错误
    }
    throw err
  }
}

export function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function isDirSync(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Python os.path.realpath 语义：存在则解析符号链接，不存在则词法解析。
 * node:fs.realpathSync 对不存在路径抛 ENOENT，故失败时回退 path.resolve
 *（安全语义不受影响：词法解析同样消除 .. 与 .）。
 */
export function realpathBestEffort(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export { dirname }
