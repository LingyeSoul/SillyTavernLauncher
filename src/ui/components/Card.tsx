/**
 * Card（设计 §5.5）：elevation 0 + 1px 边框（B1：暗色下卡片禁阴影，分层靠边框与阶梯）。
 * Section 标题：15px/600 text.primary（§5.5 配方值；§2.B 的 fs.h3=16 归对话框标题）
 * + 可选计数 fs.caption text.muted。
 */
import type { ReactNode } from 'react'
import type { StyleDesc } from '@gpuix/react'
import { useTheme } from '../theme'

export interface CardProps {
  children?: ReactNode
  style?: StyleDesc
}

export function Card({ children, style }: CardProps) {
  const t = useTheme()
  return (
    <div
      style={{
        backgroundColor: t.bg.surface,
        borderWidth: 1,
        borderColor: t.border.subtle,
        borderRadius: t.radius.md,
        padding: t.space.cardPad,
        marginBottom: t.space.cardGap,
        ...style,
      }}>
      {children}
    </div>
  )
}

export interface SectionTitleProps {
  title: string
  count?: number
  style?: StyleDesc
}

export function SectionTitle({ title, count, style }: SectionTitleProps) {
  const t = useTheme()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 8,
        marginBottom: t.space.fieldGap,
        ...style,
      }}>
      <text style={{ fontSize: 15, fontWeight: 600, color: t.text.primary, fontFamily: t.font.sans }}>
        {title}
      </text>
      {count !== undefined && (
        <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>{count}</text>
      )}
    </div>
  )
}
