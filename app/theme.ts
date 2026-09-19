/**
 * app/theme.ts — Forge tokens 的 GPUIX 形态。
 *
 * 数值即契约，来源 docs/plans/2026-09-19-gpuix-ui-design.md §2（token 映射表）。
 * 偏离声明 O1–O5 见同文档 §1.C：侧栏 192、无顶栏、表单 padding 20/24、
 * 微软雅黑 + Consolas、无玻璃态。
 */

export interface ThemeTokens {
  ember: string
  amber: string
  gold: string
  bg: { deep: string; base: string; surface: string; elevated: string; hover: string; overlay: string }
  text: { primary: string; secondary: string; muted: string; disabled: string }
  border: { subtle: string; default: string; strong: string }
  status: { error: string; warning: string; info: string; success: string }
  onPrimary: string
  glow: { ember: string }
  selection: { ember: string }
  scrim: string
}

export const dark: ThemeTokens = {
  ember: '#EBA375', amber: '#88BDB5', gold: '#E3BC75',
  bg: { deep: '#111315', base: '#141618', surface: '#1C1F22',
        elevated: '#272B2F', hover: '#2C3136', overlay: '#1C1F22' },
  text: { primary: '#EEF0F2', secondary: '#A8AFB6', muted: '#929AA3', disabled: '#69727B' },
  border: { subtle: '#2A2E33', default: '#383E44', strong: '#555F69' },
  status: { error: '#F18C96', warning: '#E3BC75', info: '#91B9EA', success: '#89C5A2' },
  onPrimary: '#251C16',
  glow: { ember: 'rgb(235 163 117 / 12%)' },
  selection: { ember: 'rgb(235 163 117 / 35%)' },
  scrim: 'rgb(0 0 0 / 40%)',
}

export const light: ThemeTokens = {
  ember: '#9D4C23', amber: '#34756C', gold: '#956914',
  bg: { deep: '#EDF0F2', base: '#F6F7F8', surface: '#FFFFFF',
        elevated: '#FFFFFF', hover: '#E9EDF0', overlay: '#FFFFFF' },
  text: { primary: '#242A30', secondary: '#626C76', muted: '#68737E', disabled: '#8A959F' },
  border: { subtle: '#E0E5E9', default: '#CBD3DA', strong: '#9AA6B0' },
  status: { error: '#BA3B50', warning: '#956914', info: '#356FA8', success: '#327653' },
  onPrimary: '#FFFFFF',
  glow: { ember: 'rgb(157 76 35 / 10%)' },
  selection: { ember: 'rgb(235 163 117 / 35%)' },
  scrim: 'rgb(0 0 0 / 40%)',
}

// —— 主题无关常量（theme.ts §2.B/§2.C）——

export const font = { sans: 'Microsoft YaHei', mono: 'Consolas' } as const
export const fs = { h1: 26, h2: 20, h3: 16, body: 14, field: 13, caption: 12, micro: 11 } as const
export const radius = { sm: 4, md: 6, lg: 8, nav: 5, chip: 3 } as const
export const space = { cardPad: 16, cardGap: 8, sectionGap: 16, navItemGap: 3, fieldGap: 8 } as const
export const size = { controlH: 34, navItemH: 38, fieldH: 34, emptyMark: 72 } as const
export const layout = {
  windowW: 800, windowH: 644, sidebarW: 192,
  padFormX: 24, padFormY: 20, padTerminal: 12,
} as const

// —— 动效（§6）。不命名为 `motion`，避免与 @gpuix/react 的 motion 组件导入冲突 ——
/** = GSAP power2.out 的精确 bezier（motion ease 需要 mutable 元组类型） */
export const EASE_OUT_QUAD: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94]
export const dur = {
  enter: 0.24, logEnter: 0.2, state: 0.14, toastHandoff: 0.3,
  breathPeriodMs: 2000, shimmerPeriodMs: 1500,
} as const

// —— 组件消费形态：useTheme() 返回 tokens + 常量的合并对象 ——
export type UITheme = ThemeTokens & {
  font: typeof font
  fs: typeof fs
  radius: typeof radius
  space: typeof space
  size: typeof size
}

export function createUITheme(tokens: ThemeTokens): UITheme {
  return { ...tokens, font, fs, radius, space, size }
}

// —— 原生组件主题工厂（input/textarea/markdown 共用，§7 双形态）——
export function editorTheme(t: ThemeTokens, appearance: 'dark' | 'light') {
  return {
    appearance,
    bg: t.bg.surface,
    text: t.text.primary,
    textMuted: t.text.secondary,
    accent: t.ember,
    caret: t.ember,
    border: 'transparent',
    fontSans: font.sans,
    fontMono: font.mono,
  }
}
