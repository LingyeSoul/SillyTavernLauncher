/**
 * FieldHint（字段/区块说明文字，2026-09-20 消重收口）：
 * 全应用统一的 muted caption 形状（fs.caption + text.muted + font.sans），
 * 收敛各视图原先内联的同形 <text>。附加间距经 style 透传（marginBottom 等）；
 * 语义色（警示/错误）不走本组件——红字保留给真异常。
 */
import type { ReactNode } from 'react'
import type { StyleDesc } from '@gpuix/react'
import { useTheme } from '../theme'

export function FieldHint({ children, style, testId }: { children: ReactNode; style?: StyleDesc; testId?: string }) {
  const t = useTheme()
  return (
    <text testId={testId} style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans, ...style }}>
      {children}
    </text>
  )
}
