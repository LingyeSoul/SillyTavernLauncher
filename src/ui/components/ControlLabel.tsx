/**
 * ControlLabel：表单控件（Checkbox/Radio）共用标签 text（2026-09-21 提取——
 * 原两处样式与注释逐行重复）。
 * 标签须可收缩折行：text 作 flex 子项时 auto min-size = 整行不折行宽度，
 * 缺 minWidth:0 会把定宽容器（Modal）撑爆画出边界（GPUIX 规则 8）。
 */
import type { ReactElement } from 'react'
import { useTheme } from '../theme'

export function ControlLabel({ color, children }: { color: string; children: string }): ReactElement {
  const t = useTheme()
  return (
    <text
      style={{
        fontSize: t.fs.field,
        color,
        fontFamily: t.font.sans,
        flexGrow: 1,
        minWidth: 0,
        whiteSpace: 'normal',
      }}>
      {children}
    </text>
  )
}
