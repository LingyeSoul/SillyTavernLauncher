/**
 * 主题上下文（设计 §7 深/浅双主题 + §6.B reduced-motion 门控）。
 *
 * - useTheme() 返回 UITheme（tokens + 常量合并），组件一律经此取值，禁止内联色值。
 * - useMotion() 返回 { enabled }：全应用 motion 门控（C5：CSS/JS 两侧概念在 GPUIX 合一）。
 * - ThemeProvider 下发共享 shimmer 相位时钟（§5.9：骨架共享一个时钟实例，杜绝多 interval）。
 * - 主题持久化到 config.json 的 theme 字段（'dark'/'light'，现有 schema 兼容）。
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { getConfigStore } from '../services/configStore'
import { errMsg, logError } from '../services/errorLog'
import {
  applyThemeAccent, createUITheme, dark, light, resolveThemeAccent,
  THEME_ACCENTS, type ThemeAccentId, type UITheme,
} from '../theme'

// 原生组件主题工厂从根 theme.ts 透传（input/textarea/markdown 共用）
export { editorTheme } from '../theme'

export type ThemeMode = 'dark' | 'light'

interface ThemeContextValue {
  t: UITheme
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  /** 主题色预设 id（themeColor，'ember' 默认；UI 见设置→启动器→外观） */
  accent: ThemeAccentId
  setAccent: (accent: ThemeAccentId) => void
  /** reduced-motion 应用内开关（§6.B；PoC-4 的 reg query 探测未实现，列遗留 TODO） */
  motionEnabled: boolean
  setMotionEnabled: (enabled: boolean) => void
  /** 共享骨架扫光相位（0–3 数值相位，全周期 1.5s；motion 关闭时恒 0）。
   *  数值宽骨架块据其平移渐变亮带（扫光）；弹性宽块退化为 opacity 呼吸亮/暗。 */
  shimmerPhase: number
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const config = getConfigStore()
  const [mode, setModeState] = useState<ThemeMode>(
    config.get<string>('theme', 'dark') === 'light' ? 'light' : 'dark',
  )
  // 主题色预设：脏值/缺省一律 resolve 回 ember（theme.ts 兜底）
  const [accent, setAccentState] = useState<ThemeAccentId>(
    resolveThemeAccent(config.get('themeColor', 'ember')),
  )
  // 默认开启动效；持久化键 motionEnabled（config schema 自由扩展键）
  const [motionEnabled, setMotionEnabledState] = useState<boolean>(
    config.get<boolean>('motionEnabled', true),
  )
  const [shimmerPhase, setShimmerPhase] = useState(0)

  // 共享 shimmer 时钟：1.5s 全周期（§5.9），0–3 四相位每 375ms 步进一次；
  // motion 关闭时归 0（静态骨架）
  useEffect(() => {
    if (!motionEnabled) {
      setShimmerPhase(0)
      return
    }
    const id = setInterval(() => setShimmerPhase((p) => (p + 1) % 4), 375)
    return () => clearInterval(id)
  }, [motionEnabled])

  const value = useMemo<ThemeContextValue>(() => {
    const base = mode === 'light' ? light : dark
    const t = createUITheme(applyThemeAccent(base, THEME_ACCENTS[accent][mode]))
    return {
      t,
      mode,
      setMode: (m) => {
        setModeState(m)
        try {
          config.set('theme', m)
          config.save()
        } catch (err) {
          logError(`[theme] 保存主题设置失败: ${errMsg(err)}`)
        }
      },
      accent,
      setAccent: (a) => {
        setAccentState(a)
        try {
          config.set('themeColor', a)
          config.save()
        } catch (err) {
          logError(`[theme] 保存主题色设置失败: ${errMsg(err)}`)
        }
      },
      motionEnabled,
      setMotionEnabled: (enabled) => {
        setMotionEnabledState(enabled)
        try {
          config.set('motionEnabled', enabled)
          config.save()
        } catch (err) {
          logError(`[theme] 保存动效设置失败: ${errMsg(err)}`)
        }
      },
      shimmerPhase,
    }
  }, [config, mode, accent, motionEnabled, shimmerPhase])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): UITheme {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx.t
}

export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useThemeContext 必须在 ThemeProvider 内使用')
  return ctx
}

/** motion 统一门控：disabled 时调用方应传 initial={false} 且 duration 0（§6.B 全局门控） */
export function useMotion(): { enabled: boolean } {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useMotion 必须在 ThemeProvider 内使用')
  return { enabled: ctx.motionEnabled }
}

/**
 * 呼吸微光相位（§5.7）：JS 相位翻转，每半周期一次 setState，Rust 插值。
 * 全应用唯一无限动画实例 = 侧栏 ST 状态点；motion 关闭时返回恒定相位（降级为静态点）。
 */
export function useBreath(periodMs: number, enabled: boolean): boolean {
  const [phase, setPhase] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setPhase(false)
      return
    }
    const id = setInterval(() => setPhase((p) => !p), periodMs / 2)
    return () => clearInterval(id)
  }, [periodMs, enabled])
  return phase
}
