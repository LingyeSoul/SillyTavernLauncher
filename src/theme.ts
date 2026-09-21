/**
 * src/theme.ts — Forge tokens 的 GPUIX 形态。
 *
 * 数值即契约，来源 docs/plans/2026-09-19-gpuix-ui-design.md §2（token 映射表）。
 * 偏离声明 O1–O5 见同文档 §1.C：侧栏 168（DEVIATION: O1 原设计 192，用户要求
 * 改窄，NavItem/footer 布局预算 168 下均有富余）、无顶栏、表单 padding 20/24、
 * 微软雅黑 + Consolas、无玻璃态。
 * 偏离声明 O6（2026-09-20，同文档 §1.C）：亮色 bg.elevated 由 #FFFFFF 改为
 * #F0F3F6——原值使骨架块/进度轨道/扩展图标回退等 elevated 填充元素在白色卡片上
 * 不可辨（仅靠 1px 边级别无填充对比）；卡片本身仍为 surface 白底，分层语言
 * （B1 elevation 0 + 边框）不变，暗色侧不动。
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
  // DEVIATION: O6 — elevated 原 #FFFFFF（dt 成对表），白卡上不可辨，改 #F0F3F6
  bg: { deep: '#EDF0F2', base: '#F6F7F8', surface: '#FFFFFF',
        elevated: '#F0F3F6', hover: '#E9EDF0', overlay: '#FFFFFF' },
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
  windowW: 800, windowH: 644, sidebarW: 168,
  padFormX: 24, padFormY: 20, padTerminal: 12,
} as const

// —— 动效（§6）。不命名为 `motion`，避免与 @gpuix/react 的 motion 组件导入冲突 ——
/** = GSAP power2.out 的精确 bezier（motion ease 需要 mutable 元组类型） */
export const EASE_OUT_QUAD: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94]
export const dur = {
  enter: 0.24, logEnter: 0.2, state: 0.14, toastHandoff: 0.3,
  menu: 0.12, shakeStep: 0.1,
  breathPeriodMs: 2000, shimmerPeriodMs: 1500,
} as const
/** 列表入场 stagger（§6 M15）：仅挂载时播（motion initial 语义天然不重播）；
 *  motion 关时调用方必须把 delay 一并归零（delay 残留 = 内容延迟出现）。 */
export const stagger = { itemDelay: 0.03, maxItems: 6 } as const

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

// —— 主题色（accent）预设：只换主强调色 ember 及其派生色 ——
//
// 第一性原理：全 UI 的"主题色"消费点（按钮/激活态/glow/selection/编辑器光标）全部
// 走 t.ember 一支；amber/gold 是次级装饰色（全 UI 仅 2 处独立使用），status.* 是语义
// 色——它们不随主题色切换，保持设计契约稳定。每套 accent 提供 dark/light 双值：
// dark = 高明度低饱和色 + 深色 onPrimary；light = 低明度高饱和色 + 白 onPrimary
// （同现有 ember 双形态规律，onPrimary↔ember 对比度 ≥ 4.5:1 由 tests/theme.accent.test.ts 契约锁定）。
// 取色种子优先复用设计系统内已调校的成对色值：teal ← amber 对、gold ← gold 对、
// blue ← status.info 对；violet 为新调。selection 双模式统一用 dark 侧色相 35%
// （对齐现有 ember 的 selection 双模式同值规律）。

export type ThemeAccentId = 'ember' | 'teal' | 'gold' | 'blue' | 'violet'

/** 主题色要覆写的 token 子集（ember 主色 + onPrimary/glow/selection 派生） */
export interface AccentSet {
  ember: string
  onPrimary: string
  /** bg glow 用低透明度（dark 12% / light 10%） */
  glow: string
  /** 选区高亮（双模式统一 dark 侧色相 35%） */
  selection: string
}

export const THEME_ACCENTS: Record<ThemeAccentId, { label: string; dark: AccentSet; light: AccentSet }> = {
  ember: {
    label: '余烬',
    dark: {
      ember: '#EBA375', onPrimary: '#251C16',
      glow: 'rgb(235 163 117 / 12%)', selection: 'rgb(235 163 117 / 35%)',
    },
    light: {
      ember: '#9D4C23', onPrimary: '#FFFFFF',
      glow: 'rgb(157 76 35 / 10%)', selection: 'rgb(235 163 117 / 35%)',
    },
  },
  teal: {
    label: '青碧',
    dark: {
      ember: '#88BDB5', onPrimary: '#132320',
      glow: 'rgb(136 189 181 / 12%)', selection: 'rgb(136 189 181 / 35%)',
    },
    light: {
      ember: '#34756C', onPrimary: '#FFFFFF',
      glow: 'rgb(52 117 108 / 10%)', selection: 'rgb(136 189 181 / 35%)',
    },
  },
  gold: {
    label: '鎏金',
    dark: {
      ember: '#E3BC75', onPrimary: '#241B0C',
      glow: 'rgb(227 188 117 / 12%)', selection: 'rgb(227 188 117 / 35%)',
    },
    light: {
      ember: '#956914', onPrimary: '#FFFFFF',
      glow: 'rgb(149 105 20 / 10%)', selection: 'rgb(227 188 117 / 35%)',
    },
  },
  blue: {
    label: '沧蓝',
    dark: {
      ember: '#91B9EA', onPrimary: '#0F1B26',
      glow: 'rgb(145 185 234 / 12%)', selection: 'rgb(145 185 234 / 35%)',
    },
    light: {
      ember: '#356FA8', onPrimary: '#FFFFFF',
      glow: 'rgb(53 111 168 / 10%)', selection: 'rgb(145 185 234 / 35%)',
    },
  },
  violet: {
    label: '紫棠',
    dark: {
      ember: '#B3A2DF', onPrimary: '#17112A',
      glow: 'rgb(179 162 223 / 12%)', selection: 'rgb(179 162 223 / 35%)',
    },
    light: {
      ember: '#5F4FA8', onPrimary: '#FFFFFF',
      glow: 'rgb(95 79 168 / 10%)', selection: 'rgb(179 162 223 / 35%)',
    },
  },
}

/** config.json themeColor 脏值兜底：非法/未知值回退默认 ember（老配置无此键同样安全） */
export function resolveThemeAccent(value: unknown): ThemeAccentId {
  return typeof value === 'string' && value in THEME_ACCENTS ? (value as ThemeAccentId) : 'ember'
}

/** 把 accent 覆写到基础 token 集：ember 预设时返回值与基础集逐值相等（默认零视觉变化） */
export function applyThemeAccent(base: ThemeTokens, accent: AccentSet): ThemeTokens {
  return {
    ...base,
    ember: accent.ember,
    onPrimary: accent.onPrimary,
    glow: { ember: accent.glow },
    selection: { ember: accent.selection },
  }
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
