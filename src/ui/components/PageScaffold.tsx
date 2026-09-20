/**
 * PageScaffold（「固定头 + 内容滚动」自管形态的组件化收口，2026-09-20）：
 * 根列容器（flexGrow:1 + minHeight:0，供 AppShell 自管挂载）→ 固定头区
 * （padFormX/Y 内边距，末尾 1px border-subtle 分隔线）→ 内容滚动区
 * （SmartScrollArea：内容超高才开滚动，装得下则滚轮无效）。
 * 标题与常驻提示不随内容滚走。版本/同步/扩展/设置四视图共用（DEVIATION:
 * §3.A/§4.2-4.5 原单滚动型，固定头推广经 O11 回写）；设置页 tab 切换经
 * scrollKey 重挂滚动区（回到顶部，亦避免残留越界滚动偏移）。
 * 铁律：本组件即视图唯一垂直滚动容器，AppShell 不得再包外层 overflow:scroll。
 */
import type { Key, ReactNode } from 'react'
import { layout } from '../../theme'
import { useTheme } from '../theme'
import { SmartScrollArea } from './SmartScroll'

export interface PageScaffoldProps {
  /** 固定头内容（PageHeader，可追加常驻提示行等），底部自动收 1px 分隔线 */
  header: ReactNode
  /** 滚动区内容 */
  children: ReactNode
  /** 内容版本号（数据加载等改变内容高度的时机），驱动 SmartScrollArea 重测 */
  contentKey?: unknown
  /** 滚动区重挂键（如设置页 activeTab）：变化即重挂滚动区并回到顶部 */
  scrollKey?: Key
  /** 滚动区 testId（默认 'page-scroll'） */
  testId?: string
}

export function PageScaffold({ header, children, contentKey, scrollKey, testId = 'page-scroll' }: PageScaffoldProps) {
  const t = useTheme()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
      }}>
      {/* ============ 固定区：workspace-heading + 1px 分隔线（不随内容滚动）============ */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          paddingTop: layout.padFormY,
          paddingLeft: layout.padFormX,
          paddingRight: layout.padFormX,
        }}>
        {header}
        <div style={{ height: 1, backgroundColor: t.border.subtle }} />
      </div>

      {/* ============ 滚动区：唯一垂直滚动容器（有界高度；内容装得下时不滚动）============ */}
      <SmartScrollArea key={scrollKey} contentKey={contentKey} testId={testId}>
        {children}
      </SmartScrollArea>
    </div>
  )
}
