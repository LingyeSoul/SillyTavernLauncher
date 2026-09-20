/**
 * Checkbox（设计 §5.2）：16 方 · radius 3 · 选中 = ember 底 + 对勾 svg（onPrimary 色）。
 * 键盘可达：tabIndex 0 + onFocus/onBlur 状态驱动 ember 聚焦辉环（同 Input 降级 #4）。
 */
import { useState } from 'react'
import { useTheme } from '../theme'
import { ICONS } from './icons'

export interface CheckboxProps {
  checked: boolean
  label?: string
  onChange: (checked: boolean) => void
  testId?: string
}

export function Checkbox({ checked, label, onChange, testId }: CheckboxProps) {
  const t = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <div
      onClick={() => onChange(!checked)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      tabIndex={0}
      role="checkbox"
      aria-selected={checked}
      testId={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        userSelect: 'none',
      }}>
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 3,
          backgroundColor: checked ? t.ember : 'transparent',
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
          <svg
            source={ICONS.check}
            style={{ width: 10, height: 10, color: t.onPrimary, pointerEvents: 'none' }}
          />
        )}
      </div>
      {/* 标签须可收缩折行：text 作 flex 子项时 auto min-size = 整行不折行宽度，
          缺 minWidth:0 会把定宽容器（Modal）撑爆画出边界（GPUIX 规则 8） */}
      {label && (
        <text
          style={{
            fontSize: t.fs.field,
            color: t.text.primary,
            fontFamily: t.font.sans,
            flexGrow: 1,
            minWidth: 0,
            whiteSpace: 'normal',
          }}>
          {label}
        </text>
      )}
    </div>
  )
}
