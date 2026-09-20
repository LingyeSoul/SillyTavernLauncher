/**
 * Radio（设计 §5.2）：16 圆 · 边 1.5 · 选中 = ember + 6px 内点（pointerEvents:'none'）。
 * 键盘可达：tabIndex 0 + onFocus/onBlur 状态驱动 ember 聚焦辉环（同 Input 降级 #4）。
 */
import { useState } from 'react'
import { useTheme } from '../theme'

export interface RadioProps {
  checked: boolean
  label?: string
  onChange: () => void
  testId?: string
}

export function Radio({ checked, label, onChange, testId }: RadioProps) {
  const t = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <div
      onClick={onChange}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      tabIndex={0}
      role="radio"
      aria-selected={checked}
      testId={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 36,
        cursor: 'pointer',
        userSelect: 'none',
      }}>
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          borderWidth: 1.5,
          borderColor: checked ? t.ember : t.border.default,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: focused
            ? { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 3, color: t.glow.ember }
            : undefined,
        }}>
        {checked && (
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: t.ember,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
      {label && (
        <text
          style={{
            fontSize: t.fs.field,
            color: checked ? t.text.primary : t.text.secondary,
            fontFamily: t.font.sans,
          }}>
          {label}
        </text>
      )}
    </div>
  )
}
