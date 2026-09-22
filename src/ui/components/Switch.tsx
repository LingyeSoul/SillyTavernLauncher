/**
 * Toggle / Switch（设计 §5.1）：轨道 32×18 · 圆点 14 · on=ember / off=bg-hover+1px subtle。
 * 轨道/圆点 pointerEvents:'none'（填充子元素铁律）——修复 BUG-S1：GPUIX 命中测试解析到
 * 最深可命中盒子，轨道 div 会吞掉点击（text/svg 会被跳过，div 盒子不会），事件到不了根
 * 节点 onClick；轨道穿透后命中落在持有 onClick 的根节点。圆点滑动 = motion.div（M3）。
 */
import { useState } from 'react'
import { motion } from '@gpuix/react'
import { useMotion, useTheme } from '../theme'

export interface SwitchProps {
  on: boolean
  onChange: (on: boolean) => void
  label?: string
  disabled?: boolean
  testId?: string
}

export function Switch({ on, onChange, label, disabled = false, testId }: SwitchProps) {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  const [focused, setFocused] = useState(false)
  return (
    <div
      onClick={disabled ? undefined : () => onChange(!on)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      tabIndex={disabled ? undefined : 0}
      role="switch"
      aria-selected={on}
      aria-label={label}
      testId={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        userSelect: 'none',
        opacity: disabled ? 0.32 : 1,
      }}>
      <div
        style={{
          position: 'relative',
          width: 32,
          height: 18,
          borderRadius: 9,
          pointerEvents: 'none',
          backgroundColor: on ? t.ember : t.bg.hover,
          borderWidth: 1,
          borderColor: on ? t.ember : t.border.subtle,
          boxShadow: focused
            ? { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 3, color: t.glow.ember }
            : undefined,
        }}>
        <motion.div
          initial={false}
          animate={{ left: on ? 16 : 1 }}
          transition={{ duration: motionEnabled ? 0.14 : 0, ease: 'easeOut' }}
          style={{
            position: 'absolute',
            top: 1,
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: t.text.primary,
            pointerEvents: 'none',
          }}
        />
      </div>
      {label && (
        <text style={{ fontSize: t.fs.field, color: t.text.primary, fontFamily: t.font.sans }}>{label}</text>
      )}
    </div>
  )
}

export interface SwitchRowProps {
  label: string
  /** 可选描述行；警示描述（descWarning）转 warning 色 */
  desc?: string
  descWarning?: boolean
  on: boolean
  onChange: (v: boolean) => void
  testId?: string
  /** 紧凑档：对话框内 34/44；默认常规档：设置页 40/48 */
  compact?: boolean
  /** 禁用态：前置条件未满足（如静默启动需先开自动启动与托盘），点击不触发切换 */
  disabled?: boolean
}

/** 开关行：标签（可选描述）左 + Switch 右。SettingsView.switchRow 与
 *  WhitelistDialogs.renderSwitchRow 的共享形状（同款排版去重，两处历史
 *  行高差以 compact 档位区分，不让裸数字穿越组件边界）。 */
export function SwitchRow({
  label,
  desc,
  descWarning = false,
  on,
  onChange,
  testId,
  compact = false,
  disabled = false,
}: SwitchRowProps) {
  const t = useTheme()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: desc ? (compact ? 44 : 48) : compact ? 34 : 40,
        gap: 12,
      }}>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, gap: 2 }}>
        <text style={{ fontSize: 13, fontWeight: 500, color: t.text.primary, fontFamily: t.font.sans }}>
          {label}
        </text>
        {desc && (
          <text
            style={{
              fontSize: t.fs.caption,
              color: descWarning ? t.status.warning : t.text.muted,
              fontFamily: t.font.sans,
            }}>
            {desc}
          </text>
        )}
      </div>
      <Switch on={on} onChange={onChange} testId={testId} disabled={disabled} />
    </div>
  )
}
