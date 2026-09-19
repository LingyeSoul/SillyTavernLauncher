/**
 * 退出确认对话框（设计 §4.7 / D1，400 宽）：gold 警示图标 + 正文；
 * 取消 = primary（安全默认）/ 停止并退出 = quiet + status.error 文字。
 */
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'
import { ICONS } from '../components/icons'

const TEXTS = {
  title: '退出启动器',
  body: '关闭启动器将同时停止正在运行的 SillyTavern。',
  cancel: '取消',
  stopAndExit: '停止并退出',
} as const

export interface ExitConfirmDialogProps {
  onConfirm: () => void
}

export function ExitConfirmDialog({ onConfirm }: ExitConfirmDialogProps) {
  const t = useTheme()
  return (
    <Modal
      open
      strong
      width={400}
      title={TEXTS.title}
      actions={
        <>
          <Button
            variant="quietDanger"
            icon="stop"
            onClick={() => {
              useUiState.getState().closeTopDialog()
              onConfirm()
            }}
            testId="exit-confirm-stop">
            {TEXTS.stopAndExit}
          </Button>
          <Button variant="primary" onClick={() => useUiState.getState().closeTopDialog()} testId="exit-confirm-cancel">
            {TEXTS.cancel}
          </Button>
        </>
      }>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <svg source={ICONS.alertTriangle} style={{ width: 19, height: 19, color: t.gold }} />
        <text style={{ fontSize: 14, color: t.text.primary, fontFamily: t.font.sans, flexGrow: 1 }}>
          {TEXTS.body}
        </text>
      </div>
    </Modal>
  )
}
