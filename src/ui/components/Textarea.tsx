/**
 * Textarea（设计 §5.3 Textarea 同构）：wrapper alignItems:flex-start + <textarea minRows>。
 * 行高 fontSize 12 + lineHeight 18（mono）；聚焦辉光环同 Input。
 */
import { useState } from 'react'
import { editorTheme, useTheme, useThemeContext } from '../theme'

export interface TextareaProps {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  minRows?: number
  maxRows?: number
  disabled?: boolean
  testId?: string
}

export function Textarea({
  value,
  placeholder,
  onChange,
  minRows = 4,
  maxRows,
  disabled = false,
  testId,
}: TextareaProps) {
  const t = useTheme()
  const { mode } = useThemeContext()
  const [focused, setFocused] = useState(false)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        backgroundColor: t.bg.surface,
        borderWidth: 1,
        borderColor: focused ? t.border.default : t.border.subtle,
        borderRadius: t.radius.sm,
        opacity: disabled ? 0.32 : 1,
        boxShadow: focused
          ? { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 3, color: t.glow.ember }
          : undefined,
      }}>
      <textarea
        value={value}
        placeholder={placeholder}
        minRows={minRows}
        maxRows={maxRows}
        onChange={(e) => onChange(e.value ?? '')}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        testId={testId}
        theme={editorTheme(t, mode)}
        style={{
          paddingLeft: 10,
          paddingRight: 10,
          paddingTop: 8,
          paddingBottom: 8,
          fontSize: 12,
          lineHeight: 18,
          fontFamily: t.font.mono,
          color: t.text.primary,
        }}
      />
    </div>
  )
}
