/**
 * Button（设计 §5.0）：div 实现，无 <button>。
 * - variants: primary / default / quiet / quietDanger
 * - 按下下沉 = position:'relative' + active:{ top: 1 }（translateY 不可用，降级 #5）
 * - primary hover = 整体 opacity 0.92（token 契约内取值，不发明更深的橙）
 * - disabled opacity 0.32（dt disabled-opacity）
 * - 键盘可达：tabIndex 0 + onFocus/onBlur 状态驱动 ember 聚焦辉环（同 Input 降级 #4；
 *   此前仅 Input/Textarea 有聚焦反馈，Button/Switch/Radio/Checkbox/IconButton 补齐）
 */
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTheme } from '../theme'
import { ICONS, type IconName } from './icons'

export type ButtonVariant = 'primary' | 'default' | 'quiet' | 'quietDanger'

export interface ButtonProps {
  children?: ReactNode
  variant?: ButtonVariant
  icon?: IconName
  onClick?: () => void
  disabled?: boolean
  testId?: string
  /** 按下时是否给 aria 反馈（默认 role=button） */
  ariaLabel?: string
  width?: number
  /** default 变体的危险文案（文字/图标用 status.error，底色不变；如终端"停止"按钮） */
  danger?: boolean
}

export function Button({
  children,
  variant = 'default',
  icon,
  onClick,
  disabled = false,
  testId,
  ariaLabel,
  width,
  danger = false,
}: ButtonProps) {
  const t = useTheme()
  const [focused, setFocused] = useState(false)
  const v = {
    primary: {
      backgroundColor: t.ember, color: t.onPrimary,
      hover: { opacity: 0.92 },
    },
    default: {
      backgroundColor: t.bg.surface, borderWidth: 1, borderColor: t.border.subtle,
      color: danger ? t.status.error : t.text.primary, hover: { backgroundColor: t.bg.hover },
    },
    quiet: {
      backgroundColor: 'transparent', color: t.text.secondary,
      hover: { backgroundColor: t.bg.hover, color: t.text.primary },
    },
    quietDanger: {
      backgroundColor: 'transparent', color: t.status.error,
      hover: { backgroundColor: t.bg.hover },
    },
  }[variant]

  return (
    <div
      onClick={disabled ? undefined : onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      tabIndex={disabled ? undefined : 0}
      role="button"
      testId={testId}
      aria-label={ariaLabel ?? (typeof children === 'string' ? children : undefined)}
      aria-disabled={disabled}
      style={{
        position: 'relative',
        top: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: t.size.controlH,
        paddingLeft: 14,
        paddingRight: 14,
        width,
        borderRadius: t.radius.sm,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.32 : 1,
        userSelect: 'none',
        boxShadow: focused
          ? { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 3, color: t.glow.ember }
          : undefined,
        active: disabled ? undefined : { top: 1 },
        ...v,
      }}>
      {icon && <svg source={ICONS[icon]} style={{ width: 16, height: 16, color: v.color }} />}
      <text style={{ fontSize: t.fs.field, fontFamily: t.font.sans, color: v.color }}>{children}</text>
    </div>
  )
}
