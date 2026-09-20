/**
 * 主题色（accent）契约测试：
 * - 默认回归：ember 预设覆写后与基础 dark/light token 逐值相等（存量用户零视觉变化）
 * - 脏值兜底：resolveThemeAccent 对未知/缺省/类型错一律回退 ember
 * - 结构完整：每套预设双模式四字段齐备且格式合法
 * - WCAG 对比度契约：onPrimary ↔ ember ≥ 4.5:1（所有预设 × 双模式，按钮文字可读性底线）
 * - 派生一致：glow/selection 的 rgb 三元组必须与 ember 同色相（派生色不得脱钩主色）
 */
import { describe, expect, it } from 'vitest'
import {
  applyThemeAccent, dark, light, resolveThemeAccent, THEME_ACCENTS,
  type AccentSet, type ThemeAccentId,
} from '../theme'

const PRESET_IDS = Object.keys(THEME_ACCENTS) as ThemeAccentId[]

describe('applyThemeAccent 默认回归', () => {
  it('ember 预设覆写 dark 基础集应逐值相等（存量视觉零变化）', () => {
    expect(applyThemeAccent(dark, THEME_ACCENTS.ember.dark)).toEqual(dark)
  })

  it('ember 预设覆写 light 基础集应逐值相等', () => {
    expect(applyThemeAccent(light, THEME_ACCENTS.ember.light)).toEqual(light)
  })

  it('非 ember 预设只覆写 ember/onPrimary/glow/selection，其余 token 原样保留', () => {
    const merged = applyThemeAccent(dark, THEME_ACCENTS.teal.dark)
    expect(merged.ember).toBe(THEME_ACCENTS.teal.dark.ember)
    expect(merged.onPrimary).toBe(THEME_ACCENTS.teal.dark.onPrimary)
    expect(merged.glow.ember).toBe(THEME_ACCENTS.teal.dark.glow)
    expect(merged.selection.ember).toBe(THEME_ACCENTS.teal.dark.selection)
    expect(merged.bg).toEqual(dark.bg)
    expect(merged.text).toEqual(dark.text)
    expect(merged.status).toEqual(dark.status)
  })
})

describe('resolveThemeAccent 脏值兜底', () => {
  it.each(PRESET_IDS)('合法 id %s 原样通过', (id) => {
    expect(resolveThemeAccent(id)).toBe(id)
  })

  it.each([
    ['未知字符串', 'rose'],
    ['空串', ''],
    ['undefined', undefined],
    ['null', null],
    ['数字', 42],
    ['对象', { id: 'teal' }],
  ])('脏值（%s）回退 ember', (_name, value) => {
    expect(resolveThemeAccent(value)).toBe('ember')
  })
})

describe('THEME_ACCENTS 结构契约', () => {
  const HEX_RE = /^#[0-9A-Fa-f]{6}$/
  const RGB_ALPHA_RE = /^rgb\(\d+ \d+ \d+ \/ \d+%\)$/

  it.each(PRESET_IDS)('预设 %s 双模式四字段齐备且格式合法', (id) => {
    const preset = THEME_ACCENTS[id]
    expect(typeof preset.label).toBe('string')
    expect(preset.label.length).toBeGreaterThan(0)
    for (const mode of ['dark', 'light'] as const) {
      const s: AccentSet = preset[mode]
      expect(s.ember).toMatch(HEX_RE)
      expect(s.onPrimary).toMatch(HEX_RE)
      expect(s.glow).toMatch(RGB_ALPHA_RE)
      expect(s.selection).toMatch(RGB_ALPHA_RE)
    }
  })
})

// —— WCAG 相对亮度 / 对比度（测试内实现，不引外部依赖）——

function hexToLinearChannels(hex: string): [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return [lin(r), lin(g), lin(b)]
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinearChannels(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

describe('WCAG 对比度契约（onPrimary ↔ ember ≥ 4.5:1）', () => {
  it.each(PRESET_IDS)('预设 %s 双模式均达标', (id) => {
    for (const mode of ['dark', 'light'] as const) {
      const s = THEME_ACCENTS[id][mode]
      const ratio = contrastRatio(s.ember, s.onPrimary)
      expect(ratio, `${id}/${mode} 对比度 ${ratio.toFixed(2)}:1 低于 4.5`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('派生色一致性（glow/selection 不得脱钩主色）', () => {
  /** '#EBA375' → 'rgb(235 163 117' 前缀 */
  function hexToRgbPrefix(hex: string): string {
    const [r, g, b] = hexToLinearChannels(hex)
    // 反推 sRGB 8bit（线性→sRGB 逆变换）
    const to8 = (c: number) => {
      const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
      return Math.round(s * 255)
    }
    return `rgb(${to8(r)} ${to8(g)} ${to8(b)}`
  }

  it.each(PRESET_IDS)('预设 %s 的 glow/selection 与 ember 同色相', (id) => {
    for (const mode of ['dark', 'light'] as const) {
      const s = THEME_ACCENTS[id][mode]
      // glow 用本模式 ember 色相；selection 双模式统一 dark 侧色相
      expect(s.glow.startsWith(hexToRgbPrefix(s.ember)), `${id}/${mode} glow 色相脱钩`).toBe(true)
      expect(
        s.selection.startsWith(hexToRgbPrefix(THEME_ACCENTS[id].dark.ember)),
        `${id}/${mode} selection 色相脱钩`,
      ).toBe(true)
    }
  })
})
