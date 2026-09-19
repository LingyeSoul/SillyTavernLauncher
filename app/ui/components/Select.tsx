/**
 * Select（设计 §5.4）：包装 @gpuix/react/select 无样式原语。
 * - Trigger 外观同 Input rest 态 + 右侧 chevron。
 * - Content 走 deferred anchored（盖过 virtual-list），不透明 bg.overlay（浮层铁律）。
 * - 选中项 check 图标 + ember 字 = Forge 菜单选中项配方；键盘导航原语自带。
 */
import * as SelectPrimitive from '@gpuix/react/select'
import { useTheme } from '../theme'
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
        </SelectPrimitive.Content>
      </div>
    </SelectPrimitive.Root>
  )
}
