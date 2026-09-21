/**
 * 退出确认对话框（设计 §4.7 / D1，400 宽）：gold 警示图标 + 正文；
 * 取消 = primary（安全默认）/ 停止并退出 = quiet + status.error 文字。
 */
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal, useModalClose } from '../components/Modal'
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

/** 动作区（Provider 子树内取 useModalClose，PR4）：取消/停止并退出统一走 requestClose；
 *  确认即进程退出（quitLauncher），退场动画无从展现——统一切换只为关闭语义一致 */
function ExitConfirmActions({ onConfirm }: ExitConfirmDialogProps) {
  const requestClose = useModalClose()
  return (
    <>
      <Button
        variant="quietDanger"
        icon="stop"
        onClick={() => {
          requestClose()
          onConfirm()
        }}
        testId="exit-confirm-stop">
        {TEXTS.stopAndExit}
      </Button>
      <Button variant="primary" onClick={requestClose} testId="exit-confirm-cancel">
        {TEXTS.cancel}
      </Button>
    </>
  )
}

export function ExitConfirmDialog({ onConfirm }: ExitConfirmDialogProps) {
  const t = useTheme()
  return (
    <Modal
      open
      strong
      width={400}
      title={TEXTS.title}
      // 结算回调：退场播完后由 Modal 调用，直呼 closeTopDialog 真卸载（见 Modal.tsx 头注释）
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={<ExitConfirmActions onConfirm={onConfirm} />}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <svg source={ICONS.alertTriangle} style={{ width: 19, height: 19, color: t.gold }} />
        <text style={{ fontSize: 14, color: t.text.primary, fontFamily: t.font.sans, flexGrow: 1 }}>
          {TEXTS.body}
        </text>
      </div>
    </Modal>
  )
}
