/**
 * ← logger.py 文件通道行为：懒创建、行格式对齐 Python、console 原样透传、
 * 同会话追加同一文件、文件通道失败一次永久降级。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return import('../services/errorLog')
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-errlog-'))
})

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('errorLog（← AppLogger ERROR 文件通道）', () => {
  it('首次 ERROR 懒创建 Error_*.txt，行格式对齐 Python Formatter', async () => {
    const { logError, __setErrorLogDirForTests } = await freshModule()
    __setErrorLogDirForTests(join(tempDir, 'logs'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(readdirSync(tempDir)).toEqual([])
    logError('启动失败', new Error('boom'))

    const files = readdirSync(join(tempDir, 'logs'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^Error_\d{8}_\d{6}\.txt$/)
    const line = readFileSync(join(tempDir, 'logs', files[0] ?? ''), 'utf8')
    // Error 参数落盘带完整堆栈（← logger.exception 语义），行为前缀匹配
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[ERROR\] SillyTavernLauncher - 启动失败 Error: boom/,
    )
    expect(line).toContain('at ')
    // console 输出原样透传（参数不变形）
    expect(errSpy).toHaveBeenCalledWith('启动失败', expect.any(Error))
  })

  it('同会话内追加同一文件，不重复创建', async () => {
    const { logError, __setErrorLogDirForTests } = await freshModule()
    __setErrorLogDirForTests(join(tempDir, 'logs'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    logError('第一次')
    logError('第二次')

    const files = readdirSync(join(tempDir, 'logs'))
    expect(files).toHaveLength(1)
    const content = readFileSync(join(tempDir, 'logs', files[0] ?? ''), 'utf8')
    expect(content).toContain('第一次')
    expect(content).toContain('第二次')
  })

  it('文件通道失败（父路径是文件）→ 降级 console-only 且不抛出', async () => {
    const { logError, __setErrorLogDirForTests } = await freshModule()
    const blocker = join(tempDir, 'blocker')
    writeFileSync(blocker, '', 'utf8')
    // blocker 是文件，其下不可能建 logs 目录 → mkdirSync 必败
    __setErrorLogDirForTests(join(blocker, 'logs'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => logError('第一次')).not.toThrow()
    expect(() => logError('第二次')).not.toThrow()
    expect(errSpy).toHaveBeenCalledTimes(2)
    expect(existsSync(join(blocker, 'logs'))).toBe(false)
  })
})
