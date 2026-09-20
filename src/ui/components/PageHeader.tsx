/**
 * PageHeader（设计 §4 workspace-heading 收口）：26px/600 标题 + 13px muted 副标题（纵排）
 * 居左，右侧可选操作区，space-between 分布，下间距 sectionGap。原裸写副本
 * （VersionView/ExtensionsView/SettingsView/SyncView 四处）收口于此。
 */
import type { ReactNode } from 'react'
import { useTheme } from '../theme'

export interface PageHeaderProps {
  title: string
  /** 副标题（版本号/状态行等）；mono 用于版本号类信息 */
  subtitle?: string
  subtitleMono?: boolean
  /** 右侧操作区（刷新按钮/安装按钮组等） */
  actions?: ReactNode
}

export function PageHeader({ title, subtitle, subtitleMono = false, actions }: PageHeaderProps) {
  const t = useTheme()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: t.space.sectionGap,
      }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <text style={{ fontSize: t.fs.h1, fontWeight: 600, color: t.text.primary, fontFamily: t.font.sans }}>
          {title}
        </text>
        {subtitle !== undefined && (
          <text
            style={{
              fontSize: t.fs.field,
              color: t.text.muted,
              fontFamily: subtitleMono ? t.font.mono : t.font.sans,
            }}>
            {subtitle}
          </text>
        )}
      </div>
      {actions}
    </div>
  )
}
