/**
 * 原子文件写入工具：所有落盘一律 .tmp + rename（硬性纪律）。
 * node:fs 的 renameSync 在 Windows 上走 MoveFileExW(REPLACE_EXISTING)，
 * 与 Python os.replace 语义一致。
 */
import { mkdirSync, renameSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, filePath)
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
