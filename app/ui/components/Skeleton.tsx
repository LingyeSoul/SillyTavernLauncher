/**
 * Skeleton（设计 §5.9）：bg-elevated · radius 4 · shimmer 1.5s（共享时钟由
 * ThemeProvider 下发，全应用一个 interval）。
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
  return (
    <motion.div
      initial={false}
      animate={{ opacity: motionEnabled ? (shimmerPhase ? 0.5 : 1) : 1 }}
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
