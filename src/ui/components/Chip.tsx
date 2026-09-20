/**
 * Chip（设计 §2.B micro + §2.C radius.chip）：徽章芯片统一配方——1px 边框 +
 * radius.chip(3) + 内边距 6/2 + micro(11) mono 文本。原 6 处裸写副本
 * （AppShell 状态徽章/版本"当前"/同步服务器序号/关于页版本/更新对话框版本对/
 * 版本切换对话框）收口于此，色值仍全部 token。
 */
import { useTheme } from '../theme'

export interface ChipProps {
  children: string
  /** 边框与文字色；缺省 text.secondary + border.default */
  color?: string
  /** 强调态：边框与文字用主题色 ember（VersionView"当前"芯片） */
  accent?: boolean
  testId?: string
}

export function Chip({ children, color, accent = false, testId }: ChipProps) {
  const t = useTheme()
  const tone = accent ? t.ember : (color ?? t.text.secondary)
  return (
    <div
      testId={testId}
      style={{
        display: 'flex',
        alignSelf: 'flex-start',
        paddingLeft: 6,
        paddingRight: 6,
        paddingTop: 2,
        paddingBottom: 2,
        borderWidth: 1,
        borderColor: tone,
        borderRadius: t.radius.chip,
      }}>
      <text style={{ fontSize: t.fs.micro, fontFamily: t.font.mono, color: tone }}>{children}</text>
    </div>
  )
}
