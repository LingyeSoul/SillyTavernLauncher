/**
 * TabItem：固定头分页的页签项（设置页/扩展页共用，2026-09-21 提取——原两处
 * ~50 行逐行重复）。激活 = ember 下划线（绝对定位压在 tab 栏 1px 分隔线上）
 * + 600 字重，未激活 hover 即时切 bg.hover；可选计数 fs.caption muted 随标签
 * 常显（flex row 内相邻 text 才同行）。
 */
import type { ReactElement } from 'react'
import { useTheme } from '../theme'

export interface TabItemProps {
  label: string
  active: boolean
  onClick: () => void
  testId: string
  /** 常显计数（扩展页用）；不传则不渲染 */
  count?: number
}

export function TabItem({ label, active, onClick, testId, count }: TabItemProps): ReactElement {
  const t = useTheme()
  return (
    <div
      onClick={onClick}
      role="tab"
      aria-selected={active}
      testId={testId}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        height: 34,
        paddingLeft: 14,
        paddingRight: 14,
        borderRadius: t.radius.sm,
        cursor: 'pointer',
        userSelect: 'none',
        hover: active ? undefined : { backgroundColor: t.bg.hover },
      }}>
      {active && (
        <div
          style={{
            position: 'absolute',
            left: 10,
            right: 10,
            bottom: -1,
            height: 2,
            borderRadius: 1,
            backgroundColor: t.ember,
            pointerEvents: 'none',
          }}
        />
      )}
      <text
        style={{
          fontSize: t.fs.field,
          fontWeight: active ? 600 : 400,
          color: active ? t.ember : t.text.secondary,
          fontFamily: t.font.sans,
        }}>
        {label}
      </text>
      {count !== undefined && (
        <text
          style={{
            fontSize: t.fs.caption,
            color: t.text.muted,
            fontFamily: t.font.sans,
            marginLeft: 6,
          }}>
          {`${count}`}
        </text>
      )}
    </div>
  )
}
