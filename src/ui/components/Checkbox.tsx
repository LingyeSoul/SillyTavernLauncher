/**
 * Checkbox（设计 §5.2）：16 方 · radius 3 · 选中 = ember 底 + 对勾 svg（onPrimary 色）。
 * 键盘可达：tabIndex 0 + onFocus/onBlur 状态驱动 ember 聚焦辉环（同 Input 降级 #4）。
 * 盒体 pointerEvents:'none'（填充子元素铁律，BUG-S1 同机制）：选中态 ember 填充盒
 * 会吞掉点击且事件不冒泡到根 onClick（未选中透明态无填充绘制、天然穿透，故仅在
 * 选中态发作——checkbox-hittest.test.tsx 回归）。
 */
import { useState } from 'react'
import { useTheme } from '../theme'
import { ControlLabel } from './ControlLabel'
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
          pointerEvents: 'none',
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
      {/* 标签折行规则见 ControlLabel（与 Radio 共用） */}
      {label && <ControlLabel color={t.text.primary}>{label}</ControlLabel>}
    </div>
  )
}
