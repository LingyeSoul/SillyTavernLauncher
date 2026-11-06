/**
 * ← stLifecycle.test.ts 拆分：gitconfig INI 解析/序列化/多编码读取的独立用例。
 * 用例内容原样搬移，断言与期望值未改。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseGitConfigIni,
  readGitConfigText,
  serializeGitConfigIni,
} from '../services/gitConfigIni'

// 临时目录承载文件读写用例（与 stLifecycle.test.ts 同款隔离，绝不污染仓库）
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stlgini'))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('gitconfig INI 解析（← configparser optionxform=str）', () => {
  it('解析 → 序列化 round-trip（键名大小写保留、% 转义）', () => {
    const text =
      '[url "https://m/https://github.com/"]\ninsteadOf = https://github.com/\n\n[core]\nautocrlf = false\n'
    const sections = parseGitConfigIni(text)
    expect(sections.length).toBe(2)
    expect(sections[0]?.name).toBe('url "https://m/https://github.com/"')
    expect(sections[0]?.entries[0]?.key).toBe('insteadOf') // 大小写保留
    // Python 写出器在每个节后都补空行（含最后一个节），1:1
    expect(serializeGitConfigIni(sections)).toBe(
      '[url "https://m/https://github.com/"]\ninsteadOf = https://github.com/\n\n[core]\nautocrlf = false\n\n',
    )

    expect(serializeGitConfigIni([{ name: 'a', entries: [{ key: 'k', value: '50%' }] }])).toBe(
      '[a]\nk = 50%%\n\n',
    )
  })

  it('注释行忽略；孤立的键抛错（← MissingSectionHeaderError）', () => {
    expect(parseGitConfigIni('; comment\n[core]\n; x\nk = v\n').length).toBe(1)
    expect(() => parseGitConfigIni('orphan = value\n')).toThrow('Missing section header')
  })

  it('readGitConfigText：utf-8 优先、非法 utf-8 回退不抛错', () => {
    const utf8Path = join(root, 'gc-utf8')
    writeFileSync(utf8Path, '[core]\nautocrlf = false\n', 'utf8')
    expect(readGitConfigText(utf8Path)).toContain('[core]')

    const binaryPath = join(root, 'gc-bin')
    writeFileSync(binaryPath, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]))
    expect(typeof readGitConfigText(binaryPath)).toBe('string')
  })
})
