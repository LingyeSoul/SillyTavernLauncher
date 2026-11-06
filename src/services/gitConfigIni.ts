/**
 * gitconfig INI 编解码（← stLifecycle 拆分：gitconfig INI 编解码，与生命周期编排无关）
 *
 * ← configparser + optionxform=str + 手写回写：
 * - 键名大小写保留（不经 optionxform 小写化）；值写回时 '%' 转义为 '%%'；
 * - 多编码容错读取：utf-8 → gbk → latin1 三段 fallback（← Python 三段 fallback）。
 *
 * 纯函数面：只按入参字符串/路径工作，不持有状态、不触碰编排流程。
 */
import { readFileSync } from 'node:fs'

export interface IniSection {
  name: string
  entries: Array<{ key: string; value: string }>
}

/** 多编码容错读取：utf-8 → gbk → latin1（← Python 三段 fallback） */
export function readGitConfigText(path: string): string {
  const buffer = readFileSync(path)
  for (const encoding of ['utf-8', 'gbk', 'latin1']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer)
    } catch {
      // 尝试下一编码
    }
  }
  return buffer.toString('latin1')
}

export function parseGitConfigIni(text: string): IniSection[] {
  const sections: IniSection[] = []
  let current: IniSection | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sectionMatch = /^\[(.+)\]$/.exec(line)
    if (sectionMatch) {
      current = { name: sectionMatch[1] ?? '', entries: [] }
      sections.push(current)
      continue
    }
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    const value = line.slice(eqIndex + 1).trim()
    if (!current) {
      // ← configparser MissingSectionHeaderError
      throw new Error('更新Git配置失败: Missing section header')
    }
    // 键名大小写保留（optionxform=str）
    current.entries.push({ key, value })
  }
  return sections
}

export function serializeGitConfigIni(sections: IniSection[]): string {
  const parts: string[] = []
  for (const section of sections) {
    parts.push(`[${section.name}]\n`)
    for (const { key, value } of section.entries) {
      // 转义可能引起问题的字符（← value.replace("%", "%%")）
      parts.push(`${key} = ${value.replace(/%/g, '%%')}\n`)
    }
    parts.push('\n')
  }
  return parts.join('')
}

export function iniHasOption(section: IniSection, key: string): boolean {
  return section.entries.some((entry) => entry.key === key)
}

export function iniGetOption(section: IniSection, key: string): string | undefined {
  return section.entries.find((entry) => entry.key === key)?.value
}

export function iniSetOption(section: IniSection, key: string, value: string): void {
  const existing = section.entries.find((entry) => entry.key === key)
  if (existing) existing.value = value
  else section.entries.push({ key, value })
}
