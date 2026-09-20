/**
 * Skeleton（设计 §5.9）：bg-elevated · radius 4 · shimmer 1.5s（共享时钟由
 * ThemeProvider 下发，全应用一个 interval，C3 单实例纪律）。
 * 数值宽块 = 扫光：白色亮带（线性渐变）经 motion 平移横穿块面，相位由共享时钟
 * 0–3 数值相位驱动；'100%' 等弹性宽无像素基准，回退 opacity 呼吸（原配方）。
 */
import { motion } from '@gpuix/react'
import { useTheme, useThemeContext } from '../theme'

export interface SkeletonBlockProps {
  width?: number | string
  height?: number
}

export function SkeletonBlock({ width = '100%', height = 16 }: SkeletonBlockProps) {
  const t = useTheme()
  const { shimmerPhase, motionEnabled } = useThemeContext()
  const px = typeof width === 'number' ? width : 0
  // 扫光路径：仅数值宽可实现（StyleDesc.left 仅 number，GPUIX 降级：百分比无锚）
  if (px > 0 && motionEnabled) {
    const stripeW = px * 0.55
    // 相位 0→3：亮带从块左侧外推进到右侧外，回绕 = 下一扫周期（全程 1.5s）
    const left = -stripeW + (shimmerPhase / 3) * (px + stripeW)
    return (
      <div
        style={{
          width,
          minHeight: 16,
          height,
          borderRadius: t.radius.sm,
          backgroundColor: t.bg.elevated,
          position: 'relative',
          overflow: 'hidden',
        }}>
        <motion.div
          initial={false}
          animate={{ left }}
          transition={{ duration: 0.35, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: stripeW,
            background: {
              type: 'linear-gradient',
              angle: 90,
              stops: [
                { color: 'rgb(255 255 255 / 0%)', position: 0 },
                { color: 'rgb(255 255 255 / 16%)', position: 1 },
              ],
            },
          }}
        />
      </div>
    )
  }
  return (
    <motion.div
      initial={false}
      animate={{ opacity: motionEnabled ? (shimmerPhase >= 2 ? 0.5 : 1) : 1 }}
      transition={{ duration: motionEnabled ? 0.75 : 0, ease: 'easeInOut' }}
      style={{
        width,
        minHeight: 16,
        height,
        borderRadius: t.radius.sm,
        backgroundColor: t.bg.elevated,
      }}
    />
  )
}

/** 版本视图加载态：5 张高 64 骨架卡（与真实布局同构，D3：禁 spinner 顶替） */
export function SkeletonCards({ count = 5 }: { count?: number }) {
  const t = useTheme()
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            height: 64,
            padding: t.space.cardPad,
            backgroundColor: t.bg.surface,
            borderWidth: 1,
            borderColor: t.border.subtle,
            borderRadius: t.radius.md,
            marginBottom: t.space.cardGap,
          }}>
          <SkeletonBlock width={180} height={14} />
          <SkeletonBlock width={120} height={11} />
        </div>
      ))}
    </>
  )
}
