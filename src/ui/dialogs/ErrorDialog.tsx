/**
 * 错误对话框（设计 §4.7，480 宽）：正文区 bg-deep + 1px subtle + radius 6 +
 * mono 12 status.error，可选中复制（GPUIX 文本天然可选）；长文案 JS 拆行。
 * 详情区 maxHeight 280 SmartScroll：长栈/stderr 超高才滚（Modal 面板 maxHeight
 * 480 无裁剪，裸溢出会画出面板压过按钮区），短文案自动非滚动容器（勿裸
 * overflow:scroll——短内容滚轮可推越界，见 SmartScroll 头注释）。
 * 复制详情 = clip.exe（platform.copyToClipboard），成功 Toast。
 * 挂载后正文盒一次性 M11 错误抖动（§6 表：motion 无 keyframes → JS 三步序列
 * left −3→3→0，每步 dur.shakeStep linear；抖正文内容根，不抖 Modal 遮罩/面板）。
 */
import { useEffect, useState } from 'react'
import { motion } from '@gpuix/react'
import { useUiState } from '../../stores/uiState'
import { uiStateActions } from '../../stores/uiState'
import { copyToClipboard } from '../../services/platform'
import { dur } from '../../theme'
import { useMotion, useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal, useModalClose } from '../components/Modal'
import { SmartScrollArea } from '../components/SmartScroll'

const TEXTS = {
  copy: '复制详情',
  copied: '已复制到剪贴板',
  copyFail: '复制失败',
  close: '关闭',
} as const

/** M11 抖动位移序列（±3px ≤6px 位移纪律；末步 0 = 静态样式，无残留） */
const SHAKE_STEPS = [-3, 3, 0] as const

export interface ErrorDialogProps {
  title: string
  message: string
  detail?: string
}

/** 动作区（Provider 子树内取 useModalClose，PR4）：关闭按钮走 requestClose 播退场 */
function ErrorDialogActions({ fullText }: { fullText: string }) {
  const requestClose = useModalClose()
  const [copying, setCopying] = useState(false)

  const handleCopy = (): void => {
    setCopying(true)
    void copyToClipboard(fullText).then((ok) => {
      setCopying(false)
      uiStateActions.pushToast(ok ? 'success' : 'error', ok ? TEXTS.copied : TEXTS.copyFail)
    })
  }

  return (
    <>
      <Button variant="default" icon="copy" disabled={copying} onClick={handleCopy} testId="error-copy">
        {TEXTS.copy}
      </Button>
      <Button variant="primary" onClick={requestClose} testId="error-close">
        {TEXTS.close}
      </Button>
    </>
  )
}

export function ErrorDialog({ title, message, detail }: ErrorDialogProps) {
  const t = useTheme()
  const { enabled: motionEnabled } = useMotion()
  // 抖动步进（0..2）：motion 开时挂载后每 dur.shakeStep 推进一步，播完停在末步
  // （一次性，不循环）；motion 关时恒 0 且 left 直接取 0（不播）
  const [shakeStep, setShakeStep] = useState(0)
  const fullText = detail ? `${message}\n\n${detail}` : message

  useEffect(() => {
    if (!motionEnabled) return
    // 两拍定时器各推进一步（100ms → step1、200ms → step2），中途起步语义保证
    // 三步连续：每步 animate 目标切换都带自己的 dur.shakeStep linear 过渡
    const ms = dur.shakeStep * 1000
    const t1 = setTimeout(() => setShakeStep(1), ms)
    const t2 = setTimeout(() => setShakeStep(2), ms * 2)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [motionEnabled])

  return (
    <Modal
      open
      width={480}
      title={title}
      // 结算回调：退场播完后由 Modal 调用，直呼 closeTopDialog 真卸载（见 Modal.tsx 头注释）
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={<ErrorDialogActions fullText={fullText} />}>
      {/* M11 抖动宿主 = 正文内容根（Modal 面板/遮罩不动）。initial={false}：
          挂载首帧即位于 animate 目标（motion 开 = SHAKE_STEPS[0] 即 -3，无隐式
          0→-3 滑入；motion 关 = 0），后续每步目标切换由 transition 过渡 */}
      <motion.div
        initial={false}
        animate={{ left: motionEnabled ? SHAKE_STEPS[shakeStep] : 0 }}
        transition={{ duration: motionEnabled ? dur.shakeStep : 0, ease: 'linear' }}
        style={{
          position: 'relative',
          backgroundColor: t.bg.deep,
          borderWidth: 1,
          borderColor: t.border.subtle,
          borderRadius: t.radius.md,
          padding: 12,
        }}>
        <SmartScrollArea maxHeight={280} padX={0} padY={0} contentKey={fullText} testId="error-detail-scroll">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {fullText.split('\n').map((line, i) => (
              <text
                key={i}
                style={{ fontSize: 12, fontFamily: t.font.mono, color: t.status.error, lineHeight: 18 }}>
                {line}
              </text>
            ))}
          </div>
        </SmartScrollArea>
      </motion.div>
    </Modal>
  )
}
