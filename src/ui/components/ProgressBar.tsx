/**
 * ProgressBar（设计 §4.3 / M6）：高 3 派生圆角 1.5（机械推导值，非新 token）。
 * - 浅色下轨道 = 白 + 1px subtle 边框保可见性（§7 派生一致性检查项）。
 * - DEVIATION: GPUIX motion 数字目标不接受百分比字符串（width 仅 number px），
 *   确定模式改为静态百分比宽度 + 状态变化即时呈现；不确定模式保留 JS 相位循环
 *   （0→70% 每 600ms 推进，约 1.7 步/秒的轻量重渲染）。
 */
import { useEffect, useState } from 'react'
import { useTheme } from '../theme'

export interface ProgressBarProps {
  /** 0-100；undefined = 不确定模式 */
  value?: number
  testId?: string
}

const INDETERMINATE_STEP_MS = 600

export function ProgressBar({ value, testId }: ProgressBarProps) {
  const t = useTheme()
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    if (value !== undefined) return
    const id = setInterval(() => setPhase((p) => (p + 1) % 8), INDETERMINATE_STEP_MS)
    return () => clearInterval(id)
  }, [value])

  const lightTrackBorder = t.bg.elevated === '#FFFFFF'
  const pct = value !== undefined ? Math.max(0, Math.min(100, value)) : (phase % 8) * 10

  return (
    <div
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
          width: `${pct}%`,
        }}
      />
    </div>
  )
}
