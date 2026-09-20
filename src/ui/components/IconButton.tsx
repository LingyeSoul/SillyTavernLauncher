/**
 * IconButton（收口 AppShell 主题切换/退出、VersionView 刷新的裸写图标按钮配方）：
 * 正方形图标按钮 + 键盘可达（tabIndex 0）+ ember 聚焦辉环（同 Input 降级 #4：
 * GPUIX 无 :focus 伪类，onFocus/onBlur 状态驱动，即时出现）。
 */
import { useState } from 'react'
import type { IconName } from './icons'
import { ICONS } from './icons'
import { useTheme } from '../theme'

export interface IconButtonProps {
  icon: IconName
  /** 图标内边距规格：28（侧栏 footer）/ 32（视图标题区） */
  size?: 28 | 32
  /** 图标像素；缺省 16，侧栏 footer 大图标可传 19 对齐 NavItem 规格 */
  iconSize?: number
  label: string
  onClick: () => void
  disabled?: boolean
  testId?: string
}

export function IconButton({
  icon,
  size = 28,
  iconSize = 16,
  label,
  onClick,
  disabled = false,
  testId,
}: IconButtonProps) {
  const t = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <div
      onClick={disabled ? undefined : onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      tabIndex={disabled ? undefined : 0}
      role="button"
      aria-label={label}
      testId={testId}
      style={{
        position: 'relative',
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: t.radius.sm,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.32 : 1,
        hover: { backgroundColor: t.bg.hover },
        boxShadow: focused
          ? { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 3, color: t.glow.ember }
          : undefined,
      }}>
      <svg source={ICONS[icon]} style={{ width: iconSize, height: iconSize, color: t.text.secondary }} />
    </div>
  )
}
