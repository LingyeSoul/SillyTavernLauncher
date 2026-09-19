/**
 * Radio（设计 §5.2）：16 圆 · 边 1.5 · 选中 = ember + 6px 内点（pointerEvents:'none'）。
 */
import { useTheme } from '../theme'

export interface RadioProps {
  checked: boolean
  label?: string
  onChange: () => void
  testId?: string
}

export function Radio({ checked, label, onChange, testId }: RadioProps) {
  const t = useTheme()
  return (
    <div
      onClick={onChange}
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
            fontSize: 13,
            color: checked ? t.text.primary : t.text.secondary,
            fontFamily: t.font.sans,
          }}>
          {label}
        </text>
      )}
    </div>
  )
}
