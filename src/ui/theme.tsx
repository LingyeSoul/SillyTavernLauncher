/**
 * 主题上下文（设计 §7 深/浅双主题 + §6.B reduced-motion 门控）。
 *
 * - useTheme() 返回 UITheme（tokens + 常量合并），组件一律经此取值，禁止内联色值。
 * - useMotion() 返回 { enabled }：全应用 motion 门控（C5：CSS/JS 两侧概念在 GPUIX 合一）。
 * - 共享 shimmer 相位时钟（§5.9：骨架共享一个时钟实例，杜绝多 interval）走
 *   **独立 context**（ShimmerPhaseSource / useShimmerPhase）——相位每 375ms 一跳，
 *   混在 ThemeContext 里会连带重渲染全部 useTheme 消费者（2026-09-21 卡顿修复）。
 * - 主题持久化到 config.json 的 theme 字段（'dark'/'light'，现有 schema 兼容）。
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { getConfigStore } from '../services/configStore'
import { errMsg, logError } from '../services/errorLog'
import { IS_WINDOWS, spawnAsync } from '../services/runtime'
import {
  applyThemeAccent, createUITheme, dark, light, resolveThemeAccent,
  THEME_ACCENTS, type ThemeAccentId, type UITheme,
} from '../theme'

// 原生组件主题工厂从根 theme.ts 透传（input/textarea/markdown 共用）
export { editorTheme } from '../theme'

export type ThemeMode = 'dark' | 'light'

/** 骨架扫光相位步进周期（375ms × 4 相位 = 1.5s 全周期，§5.9） */
const SHIMMER_STEP_MS = 375

// —— OS 侧动画偏好探测（§6.B 的另一半：Windows「关闭不必要动画」注册表）——
// HKCU\Control Panel\Accessibility\Animation = "0" 视为系统级关动画（Ease of Access
// 动画开关的落点）。只认解析值恰为 "0"/"0x0"；键缺失/reg 失败/非 Windows 一律放行
// （fail-open：宁可探测不生效，也绝不误伤正常用户的动画）。
type OsAnimationProbe = () => Promise<boolean>

let osAnimationProbe: OsAnimationProbe = defaultOsAnimationProbe
/** 每进程只探一次（ThemeProvider 会被多处挂载；memo 到模块级 promise） */
let osAnimationProbePromise: Promise<boolean> | null = null

async function defaultOsAnimationProbe(): Promise<boolean> {
  if (!IS_WINDOWS) return false
  // vitest worker 环境变量：unit 项目多处离屏渲染 ThemeProvider，单测不触发真实子进程
  if (process.env.VITEST) return false
  try {
    const proc = spawnAsync({
      cmd: ['reg', 'query', 'HKCU\\Control Panel\\Accessibility', '/v', 'Animation'],
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const line = stdout.split(/\r?\n/).find((l) => l.includes('Animation'))
    if (!line) return false
    const raw = line.trim().split(/\s+/).pop() ?? ''
    return raw === '0' || raw === '0x0'
  } catch (err) {
    logError(`[ThemeProvider] OS 动画偏好探测失败（fail-open 放行）: ${errMsg(err)}`)
    return false
  }
}

function probeOsAnimationDisabled(): Promise<boolean> {
  osAnimationProbePromise ??= osAnimationProbe().catch((err) => {
    logError(`[ThemeProvider] OS 动画偏好探测异常（fail-open 放行）: ${errMsg(err)}`)
    return false
  })
  return osAnimationProbePromise
}

/** 测试注入：替身探针离线驱动（镜像源测速 __setMirrorDialogProbeForTests 同款范式） */
export function __setOsAnimationProbeForTests(probe: OsAnimationProbe | null): void {
  osAnimationProbe = probe ?? defaultOsAnimationProbe
  osAnimationProbePromise = null
}

interface ThemeContextValue {
  t: UITheme
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  /** 主题色预设 id（themeColor，'ember' 默认；UI 见设置→启动器→外观） */
  accent: ThemeAccentId
  setAccent: (accent: ThemeAccentId) => void
  /** reduced-motion 应用内开关（§6.B；OS 侧注册表探测已实装，合流见 ThemeProvider） */
  motionEnabled: boolean
  /** motionEnabled 的 config 侧原值（未与 OS 门控合流）——设置页开关绑定此值：
   *  OS 关动画 + 偏好开时合流值恒 false，绑合流值会出现"点了没反应"的死开关；
   *  OS 门控生效态可由 motionConfigEnabled && !motionEnabled 推导 */
  motionConfigEnabled: boolean
  setMotionEnabled: (enabled: boolean) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * 骨架扫光相位（0–3 数值相位，全周期 1.5s；motion 关闭时恒 0）。
 *
 * 独立 context 的理由（2026-09-21 卡顿修复实测）：相位每 375ms 变一次，并入
 * ThemeContext 时每次相位步进都会换掉 context value 引用 → 全部 useTheme()/
 * useThemeContext() 消费者（AppShell + 各视图 + 对话框内每一行）跟着重渲染
 * （镜像源对话框实测每跳 782 次原生 setStyle）。拆出后只有本 context 的消费者
 * （Skeleton）重渲染，其余子树因 children 元素引用不变被 React 直接 bailout。
 */
const ShimmerPhaseContext = createContext(0)

/** 共享骨架时钟源：全应用唯一 interval（C3 单实例纪律，375ms 步进四相位） */
function ShimmerPhaseSource({
  motionEnabled,
  children,
}: {
  motionEnabled: boolean
  children: ReactNode
}) {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    if (!motionEnabled) {
      setPhase(0)
      return
    }
    const id = setInterval(() => setPhase((p) => (p + 1) % 4), SHIMMER_STEP_MS)
    return () => clearInterval(id)
  }, [motionEnabled])
  return <ShimmerPhaseContext.Provider value={phase}>{children}</ShimmerPhaseContext.Provider>
}

/** 骨架扫光相位（仅 Skeleton 使用；其余组件勿订阅——每次相位跳变都会重渲染） */
export function useShimmerPhase(): number {
  return useContext(ShimmerPhaseContext)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const config = getConfigStore()
  const [mode, setModeState] = useState<ThemeMode>(
    config.get<string>('theme', 'dark') === 'light' ? 'light' : 'dark',
  )
  // 主题色预设：脏值/缺省一律 resolve 回 ember（theme.ts 兜底）
  const [accent, setAccentState] = useState<ThemeAccentId>(
    resolveThemeAccent(config.get('themeColor', 'ember')),
  )
  // 默认开启动效；持久化键 motionEnabled（config schema 自由扩展键）。
  // effective = 应用内开关 && OS 未关闭动画（§6.B 双侧门控：两路"关闭"信号取 OR）
  const [configMotionEnabled, setConfigMotionEnabled] = useState<boolean>(
    config.get<boolean>('motionEnabled', true),
  )
  const [osAnimationDisabled, setOsAnimationDisabled] = useState(false)
  const motionEnabled = configMotionEnabled && !osAnimationDisabled

  // OS 侧探测：注册表结果异步到达（首帧先按 config 渲染），合流只置 true 单向生效
  // （应用内开关是用户显式偏好，OS 关闭不应把它翻成 false 再写回 config）；卸载守卫
  useEffect(() => {
    let cancelled = false
    void probeOsAnimationDisabled().then((disabled) => {
      if (!cancelled && disabled) setOsAnimationDisabled(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

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
      motionConfigEnabled: configMotionEnabled,
      setMotionEnabled: (enabled) => {
        setConfigMotionEnabled(enabled)
        try {
          config.set('motionEnabled', enabled)
          config.save()
        } catch (err) {
          logError(`[theme] 保存动效设置失败: ${errMsg(err)}`)
        }
      },
    }
  }, [config, mode, accent, motionEnabled, configMotionEnabled])

  return (
    <ThemeContext.Provider value={value}>
      {/* 共享 shimmer 时钟挂在主题之下、视图之上：相位步进只重渲染本 Provider 与
          Skeleton，children 元素引用不变 → React bailout，视图树零重渲染 */}
      <ShimmerPhaseSource motionEnabled={motionEnabled}>{children}</ShimmerPhaseSource>
    </ThemeContext.Provider>
  )
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

/** motion 统一门控：disabled 时调用方应传 initial={false} 且 duration 0（§6.B 全局门控）。
 *  三件套纪律：duration 归零的同时 **delay 必须一并归零**——delay 残留会让内容
 *  延迟出现，比没有动画更糟（stagger/抖动序列等带 delay 的 motion 都适用）。 */
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
