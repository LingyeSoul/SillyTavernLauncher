/**
 * Modal（设计 §5.8）：FloatingLayer + 不透明遮罩（pointerEvents:'auto' 吃滚轮，铁律）
 * + Tab 陷阱（focusNextWithin/focusPreviousWithin 官方模式）+ Escape 关闭 + 关闭恢复焦点。
 * 退场：GPUIX 无 exit 动画 → closing 状态反向 animate + setTimeout(240ms) 后真卸载（降级 #8）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { motion, useGpuixRequired, useWindowSize } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'
import { EASE_OUT_QUAD, dur } from '../../theme'
import { useMotion, useTheme } from '../theme'

export interface ModalProps {
  open: boolean
  onClose?: () => void
  title?: ReactNode
  width?: number
  children?: ReactNode
  actions?: ReactNode
  /** 强选择模态（EULA/退出确认）：不响应 Escape */
  strong?: boolean
}

const EXIT_MS = 240

export function Modal({
  open,
  onClose,
  title,
  width = 440,
  children,
  actions,
  strong = false,
}: ModalProps) {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  const renderer = useGpuixRequired()
  const { width: windowWidth, height: windowHeight } = useWindowSize()
  const panelRef = useRef<PublicInstance | null>(null)
  const restoreRef = useRef<number | null>(null)
  const [closing, setClosing] = useState(false)

  // 打开时记录焦点、关闭时恢复
  useEffect(() => {
    if (open) {
      restoreRef.current = renderer.getFocusedElementId?.() ?? null
      return () => {
        if (restoreRef.current != null) renderer.focusElement?.(restoreRef.current)
      }
    }
  }, [open, renderer])

  // 退场动画状态：open 由 true→false 时先演退场再由父级卸载
  useEffect(() => {
    if (!open) setClosing(false)
  }, [open])

  if (!open) return null

  const requestClose = (): void => {
    if (!onClose) return
    if (!motionEnabled) {
      onClose()
      return
    }
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      onClose()
    }, EXIT_MS)
  }

  const enterOrExit = closing
    ? { opacity: 0, top: 6 }
    : { opacity: 1, top: 0 }

  return (
    // 裸 anchored（不用 FloatingLayer：其硬编码 occlude:true，层盒撑满窗口时会
    // 遮挡全部后方点击）。occlude=false + 根盒 pointerEvents none 不挡主界面；
    // 输入阻断由遮罩（pointerEvents auto）自身承担。
    //
    // GPUIX 0.9.0 已知约束：anchored surface 被内容撑成窗口大小时，基础树的绘制
    // 会被裁剪到 surface 上沿之外（实测外壳只剩 8px）。模态下这不可见——遮罩本就
    // 意图盖住主界面，且命中测试走保留树不受影响，关层后绘制恢复——故接受此结构；
    // Toast 等透明背层的浮层则必须内容定尺寸（见 Toast.tsx）。
    <anchored deferred priority={1} occlude={false}>
      <div
        style={{
          width: windowWidth,
          height: windowHeight,
          pointerEvents: 'none',
          backgroundColor: 'transparent',
        }}>
        {/* 遮罩：40% 黑；pointerEvents:'auto' 吃滚轮（GPUIX 滚轮不冒泡） */}
        <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          backgroundColor: t.scrim,
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <motion.div
          initial={motionEnabled ? { opacity: 0, top: 6 } : false}
          animate={enterOrExit}
          transition={{ duration: motionEnabled ? dur.enter : 0, ease: EASE_OUT_QUAD }}
          style={{
            position: 'relative',
            width,
            maxHeight: 480,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: t.bg.overlay, // 不透明（浮层铁律）
            borderWidth: 1,
            borderColor: t.border.subtle,
            borderRadius: t.radius.md,
            pointerEvents: 'auto',
          }}>
          {/* Tab 陷阱挂内层面板；Escape 关闭（强选择模态除外） */}
          <div
            ref={(r) => {
              panelRef.current = r
            }}
            style={{ display: 'flex', flexDirection: 'column', padding: 16 }}
            onKeyDown={(e) => {
              if (!strong && e.key === 'escape') requestClose()
              if (e.key === 'tab' && panelRef.current) {
                if (e.modifiers?.shift) renderer.focusPreviousWithin?.(panelRef.current.id)
                else renderer.focusNextWithin?.(panelRef.current.id)
              }
            }}>
            {title !== undefined && (
              <text
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: t.text.primary,
                  fontFamily: t.font.sans,
                }}>
                {title}
              </text>
            )}
            <div style={{ marginTop: 12, minHeight: 0 }}>{children}</div>
            {actions !== undefined && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  gap: 8,
                  marginTop: 16,
                }}>
                {actions}
              </div>
            )}
          </div>
        </motion.div>
      </div>
      </div>
    </anchored>
  )
}
