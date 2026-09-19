/**
 * ToastHost（设计 §5.11）：单例 + 队列，窗口右上 inset 12。
 * - 语义色只出现在 2px 左条 + 图标（B2 纪律：语义色表状态，不整面铺色）。
 * - DEVIATION: 自动关闭由 store 按语义分级调度（uiState.TOAST_AUTO_MS）——
 *   设计 §5.11 原值 timeout -1 仅手动关；进 240ms easeOut 上浮；退场 + 60ms 空档由 store 管理。
 *
 * GPUIX 0.9.0 约束（实测）：anchored surface 若被内容撑成窗口大小，会把基础树
 * 绘制裁剪到只剩 surface 上沿之外（外壳只见 8px 条，Modal 同理被遮罩掩盖）。
 * 因此 surface 必须内容定尺寸（只包 toast 盒子），用 side/align/fit=snap 钳到
 * 窗口右上（与 FloatingLayer/Tooltip 同配方）。文本 whiteSpace normal 换行，
 * 否则不换行文本会横向溢出盒子（maxWidth 不约束文本度量）。
 */
import { motion } from '@gpuix/react'
import { EASE_OUT_QUAD, dur } from '../../theme'
import { useMotion, useTheme } from '../theme'
import { useUiState } from '../../stores/uiState'
import type { ToastKind } from '../../stores/uiState'
import { ICONS, type IconName } from './icons'

const SEMANTIC: Record<ToastKind, { icon: IconName; colorKey: 'error' | 'warning' | 'info' | 'success' }> = {
  info: { icon: 'info', colorKey: 'info' },
  success: { icon: 'check', colorKey: 'success' },
  warning: { icon: 'alertTriangle', colorKey: 'warning' },
  error: { icon: 'alertTriangle', colorKey: 'error' },
}

export function ToastHost() {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  const toast = useUiState((s) => s.toast)
  const closing = useUiState((s) => s.toastClosing)
  const dismiss = useUiState((s) => s.dismissToast)

  // 无 toast 时不挂层（避免空层参与命中/绘制）
  if (toast === null) return null

  return (
    // surface = toast 盒子自身（内容定尺寸）。side=top + align=end + fit=snap
    // 把盒子钳到窗口顶部右对齐；offset.x=-12 补右侧 inset（snapMargin 不作用于
    // 右缘，实测 0.9.0）。（父容器为外壳根 div，撑满窗口）
    <anchored side="top" align="end" gap={0} offset={{ x: -12, y: 0 }} fit="snap" snapMargin={12} deferred priority={1} occlude={false}>
      <motion.div
        initial={motionEnabled ? { opacity: 0, top: -8 } : false}
        animate={closing ? { opacity: 0, top: -8 } : { opacity: 1, top: 0 }}
        transition={{ duration: motionEnabled ? dur.enter : 0, ease: EASE_OUT_QUAD }}
        onClick={dismiss}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          width: 360,
          backgroundColor: t.bg.overlay, // 不透明（浮层铁律）
          borderWidth: 1,
          borderColor: t.border.subtle,
          borderRadius: t.radius.md,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 12,
          paddingRight: 12,
          cursor: 'pointer',
          pointerEvents: 'auto',
        }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 8,
            bottom: 8,
            width: 2,
            borderRadius: 1,
            backgroundColor: t.status[SEMANTIC[toast.kind].colorKey],
            pointerEvents: 'none',
          }}
        />
        <svg
          source={ICONS[SEMANTIC[toast.kind].icon]}
          style={{ width: 16, height: 16, color: t.status[SEMANTIC[toast.kind].colorKey], flexShrink: 0 }}
        />
        <text
          style={{
            fontSize: 13,
            color: t.text.primary,
            fontFamily: t.font.sans,
            flexGrow: 1,
            width: 280,
            whiteSpace: 'normal',
            textOverflow: 'ellipsis',
          }}>
          {toast.message}
        </text>
        <div
          onClick={dismiss}
          role="button"
          aria-label="关闭"
          testId="toast-dismiss"
          style={{ cursor: 'pointer', display: 'flex', flexShrink: 0 }}>
          <svg source={ICONS.x} style={{ width: 12, height: 12, color: t.text.muted }} />
        </div>
      </motion.div>
    </anchored>
  )
}
