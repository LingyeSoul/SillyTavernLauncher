/**
 * Input（设计 §5.3）：聚焦 3px 余烬辉光环（结构化 boxShadow spread 3 / blur 0）。
 * - GPUIX 无 :focus 伪类 → onFocus/onBlur React 状态驱动；160ms 渐入不可实现 → 即时出现（降级 #4）。
 * - wrapper 管外观、input 管编辑；input theme.border 置 transparent 防双边框（PoC-3）。
 */
import { useState } from 'react'
import { editorTheme, useTheme, useThemeContext } from '../theme'

export interface InputProps {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  mono?: boolean
  disabled?: boolean
  testId?: string
  width?: number
}

export function Input({
  value,
  placeholder,
  onChange,
  onSubmit,
  mono = false,
  disabled = false,
  testId,
  width,
}: InputProps) {
  const t = useTheme()
  const { mode } = useThemeContext()
  const [focused, setFocused] = useState(false)
  return (
    <div
      style={{
        height: t.size.fieldH,
        width,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: t.bg.surface,
        borderWidth: 1,
        borderColor: focused ? t.border.default : t.border.subtle,
        borderRadius: t.radius.sm,
        opacity: disabled ? 0.32 : 1,
        boxShadow: focused
          ? { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 3, color: t.glow.ember }
          : undefined,
      }}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.value ?? '')}
        onSubmit={onSubmit ? (e) => onSubmit(e.value ?? '') : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        testId={testId}
        theme={editorTheme(t, mode)}
        style={{
          flexGrow: 1,
          minWidth: 0,
          paddingLeft: 10,
          paddingRight: 10,
          fontSize: 13,
          fontFamily: mono ? t.font.mono : t.font.sans,
          color: t.text.primary,
        }}
      />
    </div>
  )
}
