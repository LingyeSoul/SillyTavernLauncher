/**
 * Modal（设计 §5.8）：FloatingLayer + 不透明遮罩（pointerEvents:'auto' 吃滚轮，铁律）
 * + Tab 陷阱（focusNextWithin/focusPreviousWithin 官方模式）+ Escape 关闭 + 关闭恢复焦点。
 * 退场：GPUIX 无 exit 动画 → closing 状态反向 animate + setTimeout(240ms) 后真卸载（降级 #8）。
 * 遮罩淡入淡出（2026-09-21 动效 PR1）：遮罩自身也走 motion opacity 0↔1，与面板
 * 同拍进退；40% 黑 alpha 由 t.scrim 自带，动画的是元素 opacity，不动 backgroundColor。
 *
 * 按钮退场统一（2026-09-21 动效 PR4）：ModalCloseContext 暴露 useModalClose() =
 * 面板级 requestClose，title/children/actions 内的动作按钮一律经它关闭（播退场 +
 * reduced-motion 门控），勿直呼 closeTopDialog（瞬间卸载、绕过门控）。
 * 契约：onClose prop 是**结算回调**——退场播完后由 Modal 调用，必须真正卸载对话框
 * （直呼 closeTopDialog）。不得把 onClose 传成 requestClose：settle 时 closing 已复位，
 * 重入会二次起播退场 → onClose 永不真执行 → 死循环。无 onClose 的 Modal 上
 * requestClose 是空操作——需要动画关闭的对话框必须传 onClose 结算通道。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
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
  /**
   * 面板最大高度（默认 480）。面板**不裁剪**内容——超出会画出面板压过动作区，
   * 故长内容对话框须自行把内容压进预算（正文盒用 SmartScrollArea 钳滚动区）；
   * 本值只提供更大的预算（镜像源设置的 55 行长列表用 560）。
   */
  maxHeight?: number
}

const EXIT_MS = 240

/** 面板内容级 requestClose 通道（Provider 挂在 Modal 面板内容处，缺省 null） */
const ModalCloseContext = createContext<(() => void) | null>(null)

/**
 * 在 Modal 面板内容（title/children/actions）内取当前面板的 requestClose：
 * 播 240ms 退场后才触发 onClose 结算（reduced-motion 立即结算）。
 * 必须由 Provider 子树内的组件调用——对话框的动作区/正文组件内取，不能在
 * 渲染 Modal 的外壳组件里调（Provider 之外，先例 useTheme/useMotion 均 throw）。
 */
export function useModalClose(): () => void {
  const requestClose = useContext(ModalCloseContext)
  if (!requestClose) {
    throw new Error('useModalClose 必须在 Modal 面板内容内使用（ModalCloseContext 子树）')
  }
  return requestClose
}

export function Modal({
  open,
  onClose,
  title,
  width = 440,
  children,
  actions,
  strong = false,
  maxHeight = 480,
}: ModalProps) {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  const renderer = useGpuixRequired()
  const { width: windowWidth, height: windowHeight } = useWindowSize()
  const panelRef = useRef<PublicInstance | null>(null)
  const restoreRef = useRef<number | null>(null)
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [closing, setClosing] = useState(false)

  // 卸载时清掉未触发的退场定时器（避免卸载后仍回调 onClose 误弹掉上层对话框）
  useEffect(() => {
    return () => {
      if (closingTimerRef.current != null) {
        clearTimeout(closingTimerRef.current)
        closingTimerRef.current = null
      }
    }
  }, [])

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
    // 退场中忽略重复触发（双 Escape 连弹两层对话框栈的根因）
    if (closing) return
    if (!motionEnabled) {
      onClose()
      return
    }
    setClosing(true)
    closingTimerRef.current = setTimeout(() => {
      closingTimerRef.current = null
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
        {/* 遮罩：40% 黑（alpha 由 t.scrim 自带，动画走元素 opacity 0↔1）；pointerEvents:
            'auto' 吃滚轮（GPUIX 滚轮不冒泡）；与面板同拍 240ms 淡入淡出，退场窗口内
            保持命中拦截（防 closing 期重复触发） */}
        <motion.div
          initial={motionEnabled ? { opacity: 0 } : false}
          animate={{ opacity: closing ? 0 : 1 }}
          transition={{ duration: motionEnabled ? dur.enter : 0, ease: EASE_OUT_QUAD }}
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
            maxHeight,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: t.bg.overlay, // 不透明（浮层铁律）
            borderWidth: 1,
            borderColor: t.border.subtle,
            borderRadius: t.radius.md,
            pointerEvents: 'auto',
          }}>
          {/* Tab 陷阱挂内层面板；Escape 关闭（强选择模态除外）。
              ModalCloseContext 注入面板级 requestClose：title/children/actions
              内的动作按钮经 useModalClose() 取用，统一走退场动画 + 门控（PR4）。
              closing 期间面板内容 pointerEvents:'none'——退场中的按钮不可再触发
              （防误触旧对话框的业务回调：E2E terminal-error-paths 回归教训，
              点击落在退场中旧按钮上会执行过期的 onConfirm）；遮罩保持 'auto'
              维持模态命中拦截直到卸载 */}
          <ModalCloseContext.Provider value={requestClose}>
            <div
              ref={(r) => {
                panelRef.current = r
              }}
              style={{ display: 'flex', flexDirection: 'column', padding: 16, pointerEvents: closing ? 'none' : undefined }}
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
                    fontSize: t.fs.h3,
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
          </ModalCloseContext.Provider>
        </motion.div>
      </motion.div>
      </div>
    </anchored>
  )
}
