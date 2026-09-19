/**
 * Tooltip 包装（设计 §5.12）：@gpuix/react/tooltip，Provider delayDuration 350（原值）。
 * Content：bg.overlay 不透明 + 1px subtle + radius 4 + padding 4 8 + 12px text.secondary。
 */
import type { ReactNode } from 'react'
import * as TooltipPrimitive from '@gpuix/react/tooltip'
import { useTheme } from '../theme'

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={350}>{children}</TooltipPrimitive.Provider>
}

export interface TooltipProps {
  label: string
  children: ReactNode
}

/** 挂在可点击 div 外层：Trigger asChild 让目标本身成为 hover 命中区 */
export function Tooltip({ label, children }: TooltipProps) {
  const t = useTheme()
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Content
        side="bottom"
        sideOffset={6}
        style={{
          backgroundColor: t.bg.overlay,
          borderWidth: 1,
          borderColor: t.border.subtle,
          borderRadius: t.radius.sm,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 4,
          paddingBottom: 4,
        }}>
        <text style={{ fontSize: 12, color: t.text.secondary, fontFamily: t.font.sans }}>
          {label}
        </text>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Root>
  )
}
