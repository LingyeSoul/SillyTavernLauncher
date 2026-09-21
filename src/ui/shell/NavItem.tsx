/**
 * NavItem（设计 §3.B）：Forge 激活三件套 = glow.ember 底 + 橙字 + 绝对定位 2px 左橙条
 * （BoxShadow 无 inset 字段，左条改绝对定位子 div = inset 阴影语义的精确等效，降级 #14）。
 * hover 即时切 bg.hover 底（140ms 过渡不可实现，降级 #3）；激活项 hover 不额外变色。
 * 左橙条动画（2026-09-21 动效 PR1）：常挂 + width(2↔0)/opacity(1↔0) 双动画
 * （dur.state + easeOut），激活指示从瞬现瞬消改连续生长/收没；absolute 脱流
 * 不 re-layout 兄弟且无子树文本，width 动画安全。
 */
import { motion } from '@gpuix/react'
import { dur } from '../../theme'
import { useMotion, useTheme } from '../theme'
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
  const { enabled: motionEnabled } = useMotion()
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
      {/* 左橙条：常挂 + width/opacity 双动画；inset 2px 0 的等效物。motion 关时
          duration 归零 = 即时切换；initial={false} 挂载不播入场 */}
      <motion.div
        initial={false}
        animate={{ width: active ? 2 : 0, opacity: active ? 1 : 0 }}
        transition={{ duration: motionEnabled ? dur.state : 0, ease: 'easeOut' }}
        style={{
          position: 'absolute',
          left: 0,
          top: 5,
          bottom: 5,
          borderRadius: 1,
          backgroundColor: t.ember,
          pointerEvents: 'none',
        }}
      />
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
          fontSize: t.fs.field,
          fontWeight: 400,
          color: active ? t.ember : t.text.secondary,
          fontFamily: t.font.sans,
        }}>
        {label}
      </text>
    </div>
  )
}
