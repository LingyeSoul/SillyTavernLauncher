/**
 * 终端字体设置（stores/settings + config.json terminal.*）：
 * - 默认值：字号 12、字体族 ''（跟随主题默认）
 * - update 往返：快照更新 + config.json 落盘 + reload 一致
 * - 脏数据兜底：手改 config 的 NaN/越界/类型错回退 12（防 minHeight NaN）
 * - validateTerminalFontFamily：空白/超长拒绝，trim 归一，CJK 名合法
 * - terminalRowHeight：行高契约（字号×1.5 四舍五入），LogRow 与估算高度共用
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigStore } from '../services/configStore'

interface SettingsModule {
  useSettings: {
    getState: () => {
      terminalFontSize: number
      terminalFontFamily: string
      update: (patch: { terminalFontSize?: number; terminalFontFamily?: string }) => void
      reload: () => void
    }
  }
  sanitizeTerminalFontSize: (value: unknown) => number
  terminalRowHeight: (fontSize: number) => number
  validateTerminalFontFamily: (name: string) => { ok: boolean; value?: string; message?: string }
}

/** fresh module：configStore 单例指向临时目录，settings store 随之重建 */
async function freshSettings(tempDir: string): Promise<SettingsModule & { config: ConfigStore }> {
  vi.resetModules()
  const configMod = await import('../services/configStore')
  const config = configMod.getConfigStore(join(tempDir, 'config.json')) as ConfigStore
  const settings = (await import('../stores/settings')) as unknown as SettingsModule
  return { ...settings, config }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-termfont-'))
})

afterEach(() => {
  vi.resetModules()
  rmSync(tempDir, { force: true, recursive: true })
})

describe('终端字体设置默认值', () => {
  it('未配置时字号 12、字体族空串（跟随主题默认）', async () => {
    const { useSettings } = await freshSettings(tempDir)
    expect(useSettings.getState().terminalFontSize).toBe(12)
    expect(useSettings.getState().terminalFontFamily).toBe('')
  })
})

describe('update 往返持久化', () => {
  it('字号+字体族 update → 快照与 config.json 同步落盘，reload 后一致', async () => {
    const { useSettings, config } = await freshSettings(tempDir)
    useSettings.getState().update({ terminalFontSize: 16, terminalFontFamily: 'Cascadia Mono' })

    expect(useSettings.getState().terminalFontSize).toBe(16)
    expect(useSettings.getState().terminalFontFamily).toBe('Cascadia Mono')
    expect(config.get<number>('terminal.font_size', 12)).toBe(16)
    expect(config.get<string>('terminal.font_family', '')).toBe('Cascadia Mono')

    // 落盘内容真实可见（save 已写回 JSON 文件）
    const onDisk = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf8')) as {
      terminal?: { font_size?: number; font_family?: string }
    }
    expect(onDisk.terminal?.font_size).toBe(16)
    expect(onDisk.terminal?.font_family).toBe('Cascadia Mono')

    useSettings.getState().reload()
    expect(useSettings.getState().terminalFontSize).toBe(16)
    expect(useSettings.getState().terminalFontFamily).toBe('Cascadia Mono')
  })

  it('字体族可清回空串（恢复跟随主题默认）', async () => {
    const { useSettings, config } = await freshSettings(tempDir)
    useSettings.getState().update({ terminalFontFamily: 'Sarasa Mono SC' })
    useSettings.getState().update({ terminalFontFamily: '' })
    expect(config.get<string>('terminal.font_family', 'sentinel')).toBe('')
    expect(useSettings.getState().terminalFontFamily).toBe('')
  })
})

describe('脏数据兜底（手改 config.json）', () => {
  it.each([
    ['NaN 字符串', '"abc"'],
    ['超出上限', '72'],
    ['低于下限', '2'],
    ['null', 'null'],
  ])('%s 回退默认 12', async (_label, raw) => {
    writeFileSync(join(tempDir, 'config.json'), `{"terminal": {"font_size": ${raw}}}`)
    const { useSettings } = await freshSettings(tempDir)
    expect(useSettings.getState().terminalFontSize).toBe(12)
  })

  it('合法范围内的手改值（如 15）原样保留', async () => {
    writeFileSync(join(tempDir, 'config.json'), '{"terminal": {"font_size": 15}}')
    const { useSettings } = await freshSettings(tempDir)
    expect(useSettings.getState().terminalFontSize).toBe(15)
  })
})

describe('terminalRowHeight', () => {
  it('行高 = 字号 × 1.5 四舍五入（12→18 契约锚点；.5 向上取整）', async () => {
    const { terminalRowHeight } = await freshSettings(tempDir)
    expect(terminalRowHeight(12)).toBe(18)
    expect(terminalRowHeight(10)).toBe(15)
    expect(terminalRowHeight(11)).toBe(17)
    expect(terminalRowHeight(13)).toBe(20)
  })
})

describe('validateTerminalFontFamily', () => {
  it('空白输入拒绝', async () => {
    const { validateTerminalFontFamily } = await freshSettings(tempDir)
    expect(validateTerminalFontFamily('')).toEqual({ ok: false, message: '字体名称不能为空' })
    expect(validateTerminalFontFamily('   ')).toEqual({ ok: false, message: '字体名称不能为空' })
  })

  it('超长拒绝（>64 字符）', async () => {
    const { validateTerminalFontFamily } = await freshSettings(tempDir)
    const result = validateTerminalFontFamily('x'.repeat(65))
    expect(result.ok).toBe(false)
  })

  it('首尾空白归一；含空格/中日文的名字合法', async () => {
    const { validateTerminalFontFamily } = await freshSettings(tempDir)
    expect(validateTerminalFontFamily('  JetBrains Mono  ')).toEqual({ ok: true, value: 'JetBrains Mono' })
    expect(validateTerminalFontFamily('更纱黑体 SC')).toEqual({ ok: true, value: '更纱黑体 SC' })
  })
})
