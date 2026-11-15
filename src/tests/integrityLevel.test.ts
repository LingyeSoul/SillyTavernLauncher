/**
 * Windows 完整性级别探测的纯逻辑（2026-11 用户报障）：
 * - TokenIntegrityLevel 的 SID 最后子权威（RID）→ 级别映射
 * - Low/Untrusted 指引：首屏只给“换存放目录”步骤（小白用户，不暴露 icacls）；
 *   技术详情覆盖数据根、exe 目录（继承 Medium 防复发）与 exe 本身，同目录去重
 */
import { describe, expect, it } from 'vitest'
import {
  formatLowIntegrityRemediation,
  integrityLevelFromRid,
} from '../services/integrityLevel'

describe('integrityLevelFromRid', () => {
  it('映射 well-known 完整性 RID', () => {
    expect(integrityLevelFromRid(0x0000)).toBe('untrusted')
    expect(integrityLevelFromRid(0x1000)).toBe('low')
    expect(integrityLevelFromRid(0x2000)).toBe('medium')
    expect(integrityLevelFromRid(0x3000)).toBe('high')
    expect(integrityLevelFromRid(0x4000)).toBe('system')
    expect(integrityLevelFromRid(0x5000)).toBe('protected')
  })

  it('未知 RID 不猜测', () => {
    expect(integrityLevelFromRid(0x1234)).toBe('unknown')
  })
})

describe('formatLowIntegrityRemediation', () => {
  it('同目录：技术命令去重；首屏只给换目录步骤，不暴露 icacls', () => {
    const notice = formatLowIntegrityRemediation(
      'low',
      'E:\\STL',
      'E:\\STL\\SillyTavernLauncher.exe',
    )
    const lines = notice.technicalDetail.split('\n')
    expect(lines.filter((line) => line === 'icacls "E:\\STL" /setintegritylevel "(OI)(CI)Medium"')).toHaveLength(1)
    expect(lines).toContain(
      'icacls "E:\\STL\\SillyTavernLauncher.exe" /setintegritylevel "Medium"',
    )
    expect(notice.technicalDetail).toContain('Low（S-1-16-4096）')
    expect(notice.message).not.toContain('EPERM')
    expect(notice.detail).toContain('D:\\SillyTavernLauncher')
    expect(notice.detail).toContain('复制')
    expect(notice.detail).not.toContain('icacls')
  })

  it('数据根与 exe 目录不同：技术命令两处目录都覆盖', () => {
    const notice = formatLowIntegrityRemediation(
      'untrusted',
      'D:\\data dir',
      'C:\\Program Files\\STL\\launcher.exe',
    )
    expect(notice.technicalDetail).toContain('icacls "D:\\data dir" /setintegritylevel "(OI)(CI)Medium"')
    expect(notice.technicalDetail).toContain(
      'icacls "C:\\Program Files\\STL" /setintegritylevel "(OI)(CI)Medium"',
    )
    expect(notice.technicalDetail).toContain(
      'icacls "C:\\Program Files\\STL\\launcher.exe" /setintegritylevel "Medium"',
    )
    expect(notice.technicalDetail).toContain('Untrusted（S-1-16-0）')
    expect(notice.detail).not.toContain('icacls')
  })
})