/**
 * Select（设计 §5.4）：包装 @gpuix/react/select 无样式原语。
 * - Trigger 外观同 Input rest 态 + 右侧 chevron。
 * - Content 走 deferred anchored（盖过 virtual-list），不透明 bg.overlay（浮层铁律）。
 * - 选中项 check 图标 + ember 字 = Forge 菜单选中项配方；键盘导航原语自带。
 * - 下拉进场淡入（§6 菜单动效，dur.menu）：面板 chrome（bg/边框/padding 在
 *   FloatingLayer 内层 div 上）即时出现，仅内容 0.12s easeOut 淡入；只动 opacity
 *   零位移，不与 anchored 定位交互。包装安全性已对 0.9.0 源码核实：Content 对
 *   children 原样透传给 FloatingLayer（无结构校验/无 React.Children 遍历），Item
 *   注册走 React context（useLayoutEffect + registerItem），键盘导航焦点在
 *   FloatingLayer 容器（autoFocus），均不依赖"Item 必须是 Content 直接子节点"。
 */
import * as SelectPrimitive from '@gpuix/react/select'
import { motion } from '@gpuix/react'
import { dur } from '../../theme'
import { useMotion, useTheme } from '../theme'
import { ICONS } from './icons'

export interface SelectItem {
  value: string
  label: string
}

export interface SelectProps {
  items: SelectItem[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  width?: number
  testId?: string
}

export function Select({ items, value, onValueChange, placeholder, width, testId }: SelectProps) {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  return (
    <SelectPrimitive.Root items={items} value={value} onValueChange={onValueChange}>
      <div style={{ position: 'relative', width }}>
        <SelectPrimitive.Trigger
          testId={testId}
          style={(state) => ({
            height: t.size.fieldH,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: t.radius.sm,
            cursor: 'pointer',
            backgroundColor: t.bg.surface,
            borderWidth: 1,
            borderColor: state.open ? t.border.default : t.border.subtle,
            userSelect: 'none',
          })}>
          <SelectPrimitive.Value
            placeholder={placeholder}
            style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans }}
          />
          <svg source={ICONS.chevronDown} style={{ width: 16, height: 16, color: t.text.muted }} />
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Content
          side="bottom"
          sideOffset={4}
          style={{
            backgroundColor: t.bg.overlay,
            borderWidth: 1,
            borderColor: t.border.subtle,
            borderRadius: t.radius.md,
            padding: 4,
          }}>
          {/* 进场淡入（reduced-motion 三件套：initial={false} + duration 0；
              无 delay 故无 delay 归零问题）。Content 每次开 dropdown 都重挂
              （open=false 返回 null），淡入天然随开合重播 */}
          <motion.div
            initial={motionEnabled ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{ duration: motionEnabled ? dur.menu : 0, ease: 'easeOut' }}>
            {items.map((m) => (
              <SelectPrimitive.Item
                key={m.value}
                value={m.value}
                style={(state) => ({
                  height: 30,
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: t.radius.sm,
                  cursor: 'pointer',
                  backgroundColor: state.highlighted ? t.bg.hover : 'transparent',
                })}>
                {(state) => (
                  <>
                    <text
                      style={{
                        fontSize: 13,
                        color: state.selected ? t.ember : t.text.primary,
                        fontFamily: t.font.sans,
                        flexGrow: 1,
                      }}>
                      {m.label}
                    </text>
                    {state.selected && (
                      <svg
                        source={ICONS.check}
                        style={{ width: 12, height: 12, color: t.ember, pointerEvents: 'none' }}
                      />
                    )}
                  </>
                )}
              </SelectPrimitive.Item>
            ))}
          </motion.div>
        </SelectPrimitive.Content>
      </div>
    </SelectPrimitive.Root>
  )
}
