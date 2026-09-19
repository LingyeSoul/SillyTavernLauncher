/**
 * Checkbox（设计 §5.2）：16 方 · radius 3 · 选中 = ember 底 + 对勾 svg（onPrimary 色）。
 */
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
  return (
    <div
      onClick={() => onChange(!checked)}
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
        }}>
        {checked && (
          <svg
            source={ICONS.check}
            style={{ width: 10, height: 10, color: t.onPrimary, pointerEvents: 'none' }}
          />
        )}
      </div>
      {label && (
        <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans }}>{label}</text>
      )}
    </div>
  )
}
