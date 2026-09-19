/**
 * 错误对话框（设计 §4.7，480 宽）：正文区 bg-deep + 1px subtle + radius 6 +
 * mono 12 status.error，可选中复制（GPUIX 文本天然可选）；长文案 JS 拆行。
 * 复制详情 = clip.exe（platform.copyToClipboard），成功 Toast。
 */
import { useState } from 'react'
import { useUiState } from '../../stores/uiState'
import { uiStateActions } from '../../stores/uiState'
import { copyToClipboard } from '../../services/platform'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'

const TEXTS = {
  copy: '复制详情',
  copied: '已复制到剪贴板',
  copyFail: '复制失败',
  close: '关闭',
} as const

export interface ErrorDialogProps {
  title: string
  message: string
  detail?: string
}

export function ErrorDialog({ title, message, detail }: ErrorDialogProps) {
  const t = useTheme()
  const [copying, setCopying] = useState(false)
  const fullText = detail ? `${message}\n\n${detail}` : message

  const handleCopy = (): void => {
    setCopying(true)
    void copyToClipboard(fullText).then((ok) => {
      setCopying(false)
      uiStateActions.pushToast(ok ? 'success' : 'error', ok ? TEXTS.copied : TEXTS.copyFail)
    })
  }

  return (
    <Modal
      open
      width={480}
      title={title}
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={
        <>
          <Button variant="default" icon="copy" disabled={copying} onClick={handleCopy} testId="error-copy">
            {TEXTS.copy}
          </Button>
          <Button variant="primary" onClick={() => useUiState.getState().closeTopDialog()} testId="error-close">
            {TEXTS.close}
          </Button>
        </>
      }>
      <div
        style={{
          backgroundColor: t.bg.deep,
          borderWidth: 1,
          borderColor: t.border.subtle,
          borderRadius: t.radius.md,
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}>
        {fullText.split('\n').map((line, i) => (
          <text
            key={i}
            style={{ fontSize: 12, fontFamily: t.font.mono, color: t.status.error, lineHeight: 18 }}>
            {line}
          </text>
        ))}
      </div>
    </Modal>
  )
}
