/**
 * 启动器运行目录读写探针（2026-11 用户报障：低完整性/ACL 不足导致保存 EPERM）：
 * - 正常目录：create → read → delete 成功，不残留探针文件、不改动已有文件
 * - 目录不存在 / 路径是文件：抛原始 ENOENT/ENOTDIR（供启动门禁格式化）
 * - 失败指引：首屏给更换存放目录步骤；目录/错误码/icacls 只进技术详情
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCESS_PROBE_PREFIX,
  formatRootAccessFailure,
  probeLauncherRootAccess,
} from '../services/launcherRootAccess'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-root-access-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('probeLauncherRootAccess', () => {
  it('可写目录：探针成功且零残留', () => {
    writeFileSync(join(tempDir, 'keep.txt'), 'keep', 'utf8')
    probeLauncherRootAccess(tempDir)
    const names = readdirSync(tempDir)
    expect(names).toEqual(['keep.txt'])
    expect(names.some((name) => name.startsWith(ACCESS_PROBE_PREFIX))).toBe(false)
  })

  it('目录不存在：抛 ENOENT', () => {
    let caught: unknown = null
    try {
      probeLauncherRootAccess(join(tempDir, 'missing'))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOENT')
  })

  it('路径是文件：抛 ENOTDIR', () => {
    const file = join(tempDir, 'not-a-dir.txt')
    writeFileSync(file, 'x', 'utf8')
    let caught: unknown = null
    try {
      probeLauncherRootAccess(file)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOTDIR')
  })
})

describe('formatRootAccessFailure', () => {
  it('首屏给换目录步骤；目录/错误码/icacls 只进技术详情', () => {
    const failure = formatRootAccessFailure(
      'D:\\STL data',
      Object.assign(new Error('拒绝访问'), { code: 'EPERM' }),
    )
    expect(failure.message).toContain('D:\\STL data')
    expect(failure.message).not.toContain('EPERM')
    expect(failure.detail).toContain('1. 关闭启动器。')
    expect(failure.detail).toContain('D:\\SillyTavernLauncher')
    expect(failure.detail).not.toContain('icacls')
    expect(failure.technicalDetail).toContain('EPERM')
    expect(failure.technicalDetail).toContain('icacls "D:\\STL data" /grant "<用户名>:(OI)(CI)M"')
  })
})