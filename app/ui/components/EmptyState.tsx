/**
 * EmptyState（设计 §5.10）：72px 描边方块 + 1px border-default + radius 8 +
 * 18px/500 secondary 标题 + padding 48/20（layout-grammar §2.D 逐值）。
 * 禁裸"暂无数据"文本（D2）。
 */
import type { ReactNode } from 'react'
import { useTheme } from '../theme'
import { ICONS, type IconName } from './icons'

export interface EmptyStateProps {
  icon?: IconName
  title: string
  hint?: string
  /** 可选主操作按钮 */
  action?: ReactNode
}

export function EmptyState({ icon = 'folder', title, hint, action }: EmptyStateProps) {
  const t = useTheme()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 48,
        paddingBottom: 48,
        paddingLeft: 20,
        paddingRight: 20,
        gap: 12,
      }}>
      <div
        style={{
          width: t.size.emptyMark,
          height: t.size.emptyMark,
          borderWidth: 1,
          borderColor: t.border.default,
          borderRadius: t.radius.lg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <svg
          source={ICONS[icon]}
          style={{ width: 24, height: 24, color: t.text.muted, opacity: 0.85 }}
        />
      </div>
      <text
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: t.text.secondary,
          fontFamily: t.font.sans,
        }}>
        {title}
      </text>
      {hint && (
        <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>{hint}</text>
      )}
      {action}
    </div>
  )
}
