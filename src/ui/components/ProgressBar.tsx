/**
 * ProgressBar（设计 §4.3 / M6）：高 3 派生圆角 1.5（机械推导值，非新 token）。
 * - 浅色下轨道补 1px subtle 边框保可见性（§7 派生一致性检查项；O6 后 elevated
 *   为浅灰 #F0F3F6，边框保留作边界强化）。浅色判定用 mode 而非色值比较。
 * - 2026-09-21 动效 PR1——连续化（撤销早前"motion 数字目标不收百分比字符串"的
 *   静态降级）：轨道像素宽经 renderer.getElementBounds 实测（SmartScroll 同款
 *   16ms 短轮询至多 12 次等首帧绘制，窗口尺寸变化重测），fill 改 motion.div 数值
 *   width 插值——确定模式 dur.enter + EASE_OUT_QUAD（M6），value 跳变由 motion
 *   中途起步语义自然补间；不确定模式 phase 奇偶每 600ms 翻转，0↔70% 行程
 *   easeInOut 0.6s 往返连续（M6"JS 相位循环"的连续形态，替代原 8 档阶跃）。
 *   DEVIATION: M6 不确定模式记 easeOut 0.6s，此处改 easeInOut——单条 transition
 *   双程共用，easeOut 在回零段缓收、再出发段陡起，往返衔接生硬；easeInOut 两端
 *   皆缓，循环观感连续。
 * - 保底路径（渲染处显式分流，非静默）：旧 renderer 无测量 API / 轮询超次未就绪
 *   → trackW 保持 null，fill 退回静态百分比渲染（即原降级行为，不确定模式保留
 *   8 档阶跃 interval）。motion 关闭且已测得时不跑 interval，fill 静态呈满行程宽
 *   （useBreath 同款"恒定相位静态降级"，不空条也不闪动）。
 */
import { useEffect, useRef, useState } from 'react'
import { motion, useGpuixRequired, useWindowSize } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'
import { EASE_OUT_QUAD, dur } from '../../theme'
import { useMotion, useTheme, useThemeContext } from '../theme'
import { errMsg, logError } from '../../services/errorLog'
import { mainWindowQueryState } from '../../services/windowControl'

export interface ProgressBarProps {
  /** 0-100；undefined = 不确定模式 */
  value?: number
  testId?: string
}

/** 不确定模式节拍 600ms：连续路径 = 往返半周期（与插值 duration 相等，衔接无缝）；
 *  保底路径 = 8 档阶跃的档间隔（沿用原值，两语义同值共用） */
const INDETERMINATE_STEP_MS = 600
/** 不确定模式行程系数（§6 M6：0→70%） */
const INDETERMINATE_TRAVEL = 0.7
/** 轨道宽测量时序（SmartScroll 同款）：16ms 短轮询至多 12 次等首帧绘制 */
const MEASURE_RETRY = 12
const MEASURE_INTERVAL_MS = 16
/** 窗口冻结（隐藏/最小化）期间的低频自唤醒：只做可见性门检，不发 bounds 查询 */
const FROZEN_RECHECK_MS = 1000

export function ProgressBar({ value, testId }: ProgressBarProps) {
  const t = useTheme()
  const { mode } = useThemeContext()
  const { enabled: motionEnabled } = useMotion()
  const renderer = useGpuixRequired()
  const { width: winW, height: winH } = useWindowSize()
  const trackRef = useRef<PublicInstance | null>(null)
  // 轨道像素宽：null = 未测得（首帧未绘制 / 旧 renderer / 轮询超次）→ 保底渲染
  const [trackW, setTrackW] = useState<number | null>(null)
  // JS 相位时钟：保底路径取 %8（8 档阶跃），连续路径取奇偶（600ms 翻转一次）
  const [phase, setPhase] = useState(0)

  // 轨道宽实测（照 SmartScroll 模式）：注意不可把方法捕获为局部变量调用
  // （会丢 renderer this 绑定）；旧 renderer 无 API 时不启动轮询（trackW 恒 null
  // 走保底，避免空转重试）。窗口尺寸变化 → 重测（轨道宽随布局变）。
  // 冻结态门检 + 竞态 catch 与 SmartScroll 同源（2026-09-22 close-to-tray 回归）：
  // 隐藏/最小化下 bounds 查询会同步阻塞 2s 后抛 GenericFailure。本组件无看门狗，
  // 冻结期以 1s 低频轮询自唤醒，恢复可见后完成补测（不因此走保底渲染卡死）
  useEffect(() => {
    if (typeof renderer.getElementBounds !== 'function') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    let warned = false
    const measure = (): void => {
      if (cancelled) return
      if (mainWindowQueryState() === 'frozen') {
        timer = setTimeout(measure, FROZEN_RECHECK_MS)
        return
      }
      const el = trackRef.current
      if (!el) return
      try {
        const b = renderer.getElementBounds?.(el.id) ?? null
        if (!b || !(b.width > 0)) {
          // 尚未布局出宽：短轮询等待；超次放弃（保持 null 走保底，不阻塞 UI）
          if (++tries < MEASURE_RETRY) timer = setTimeout(measure, MEASURE_INTERVAL_MS)
          return
        }
        setTrackW(b.width)
      } catch (err) {
        // 竞态兜底（门检与查询之间窗口刚被隐藏）：放弃本轮，尺寸变化时 effect
        // 重跑；只记一次日志防刷屏（错误路径每次阻塞 2s，不进高频重试）
        if (!warned) {
          warned = true
          logError(`[ProgressBar] 轨道宽测量失败（窗口冻结竞态兜底）: ${errMsg(err)}`)
        }
      }
    }
    timer = setTimeout(measure, MEASURE_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [renderer, winW, winH])

  const indeterminate = value === undefined

  // 不确定模式相位时钟：保底路径照跑（现状行为，与 motion 开关无关——它本就是
  // JS 驱动的静态渲染）；连续路径同一节拍下奇偶翻转驱动往返插值；motion 关闭且
  // 已测得时不跑 interval（reduced-motion 合规，fill 静态见下方 fillW）
  useEffect(() => {
    if (!indeterminate) return
    if (trackW != null && !motionEnabled) return
    const id = setInterval(() => setPhase((p) => (p + 1) % 8), INDETERMINATE_STEP_MS)
    return () => clearInterval(id)
  }, [indeterminate, trackW, motionEnabled])

  const lightTrackBorder = mode === 'light'
  const pct = value !== undefined ? Math.max(0, Math.min(100, value)) : 0

  // —— 保底路径：像素宽未测得 → 原静态百分比渲染（fill 宽动画逐帧 re-layout
  //    子树的铁律由轨道 overflow:'hidden' 兜底，fill 无文本）——
  if (trackW == null) {
    const fallbackPct = indeterminate ? (phase % 8) * 10 : pct
    return (
      <div
        ref={trackRef}
        testId={testId}
        style={{
          position: 'relative',
          height: 3,
          borderRadius: 1.5,
          backgroundColor: t.bg.elevated,
          overflow: 'hidden',
          ...(lightTrackBorder ? { borderWidth: 1, borderColor: t.border.subtle } : {}),
        }}>
        <div
          style={{
            height: 3,
            borderRadius: 1.5,
            backgroundColor: t.ember,
            width: `${fallbackPct}%`,
          }}
        />
      </div>
    )
  }

  // —— 主路径：motion.div 数值 width 插值 ——
  // 不确定模式：奇数相位走满行程、偶数回零（600ms 半周期 = 插值 duration，往返
  // 恰好衔接）；motion 关闭时静态呈满行程宽（不空条也不闪动）。确定模式百分比
  // 换算像素，跳变交给中途起步语义补间
  const fillW = indeterminate
    ? motionEnabled
      ? phase % 2 === 1
        ? trackW * INDETERMINATE_TRAVEL
        : 0
      : trackW * INDETERMINATE_TRAVEL
    : (trackW * pct) / 100

  return (
    <div
      ref={trackRef}
      testId={testId}
      style={{
        position: 'relative',
        height: 3,
        borderRadius: 1.5,
        backgroundColor: t.bg.elevated,
        overflow: 'hidden',
        ...(lightTrackBorder ? { borderWidth: 1, borderColor: t.border.subtle } : {}),
      }}>
      <motion.div
        initial={false}
        animate={{ width: fillW }}
        transition={indeterminate
          ? { duration: motionEnabled ? INDETERMINATE_STEP_MS / 1000 : 0, ease: 'easeInOut' }
          : { duration: motionEnabled ? dur.enter : 0, ease: EASE_OUT_QUAD }}
        style={{ height: 3, borderRadius: 1.5, backgroundColor: t.ember }}
      />
    </div>
  )
}
