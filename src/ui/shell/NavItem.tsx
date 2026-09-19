/**
 * NavItem（设计 §3.B）：Forge 激活三件套 = glow.ember 底 + 橙字 + 绝对定位 2px 左橙条
 * （BoxShadow 无 inset 字段，左条改绝对定位子 div = inset 阴影语义的精确等效，降级 #14）。
 * hover 即时切 bg.hover 底（140ms 过渡不可实现，降级 #3）；激活项 hover 不额外变色。
 */
import { useTheme } from '../theme'
import { ICONS, type IconName } from '../components/icons'

export interface NavItemProps {
  icon: IconName
  label: string
  active: boolean
  onClick: () => void
  testId?: string
}

export function NavItem({ icon, label, active, onClick, testId }: NavItemProps) {
  const t = useTheme()
  return (
    <div
      onClick={onClick}
      role="menuitem"
      aria-selected={active}
      testId={testId}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        height: t.size.navItemH,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: t.radius.nav,
        backgroundColor: active ? t.glow.ember : 'transparent',
        cursor: 'pointer',
        userSelect: 'none',
        hover: active ? undefined : { backgroundColor: t.bg.hover },
      }}>
      {/* 左橙条：仅激活时渲染；inset 2px 0 的等效物 */}
      {active && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 5,
            bottom: 5,
            width: 2,
            borderRadius: 1,
            backgroundColor: t.ember,
            pointerEvents: 'none',
          }}
        />
      )}
      <svg
        source={ICONS[icon]}
        style={{
          width: 19,
          height: 19,
          color: active ? t.ember : t.text.primary,
          opacity: active ? 1 : 0.85,
        }}
      />
      <text
        style={{
          fontSize: 13,
          fontWeight: 400,
          color: active ? t.ember : t.text.secondary,
          fontFamily: t.font.sans,
        }}>
        {label}
      </text>
    </div>
  )
}
