/**
 * 酒馆更新确认对话框（st_ask_before_update，2026-10-06，400 宽）：
 * 启动酒馆检出 SillyTavern 新版本时，由用户选择「更新后启动 / 跳过更新直接启动」。
 * 强选择模态（strong：不响应 Escape）——store 侧 startStWithUpdateConfirm 的
 * confirm Promise 只经动作按钮结算，强模态保证二选一必答、Promise 不悬空。
 * 跳过 = primary（安全默认：不动用户的目录树）；更新 = default + download 图标。
 */
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal, useModalClose } from '../components/Modal'
import { ICONS } from '../components/icons'

const TEXTS = {
  title: '检测到酒馆更新',
  body: '启动前检查发现 SillyTavern 新版本，是否更新？',
  hint: '可在「设置 → 酒馆设置 → 更新」中调整此行为。',
  updateAndStart: '更新后启动',
  skipAndStart: '跳过更新，直接启动',
} as const

export interface StUpdateConfirmDialogProps {
  onConfirm: (update: boolean) => void
}

/** 动作区（Provider 子树内取 useModalClose，PR4）：两个出口统一走 requestClose 播退场 */
function StUpdateConfirmActions({ onConfirm }: StUpdateConfirmDialogProps) {
  const requestClose = useModalClose()
  const closeAnd = (update: boolean): void => {
    requestClose()
    onConfirm(update)
  }
  return (
    <>
      <Button variant="default" icon="download" onClick={() => closeAnd(true)} testId="st-update-confirm-update">
        {TEXTS.updateAndStart}
      </Button>
      <Button variant="primary" icon="play" onClick={() => closeAnd(false)} testId="st-update-confirm-skip">
        {TEXTS.skipAndStart}
      </Button>
    </>
  )
}

export function StUpdateConfirmDialog({ onConfirm }: StUpdateConfirmDialogProps) {
  const t = useTheme()
  return (
    <Modal
      open
      strong
      width={400}
      title={TEXTS.title}
      // 结算回调：退场播完后由 Modal 调用，直呼 closeTopDialog 真卸载（见 Modal.tsx 头注释）
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={<StUpdateConfirmActions onConfirm={onConfirm} />}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <svg source={ICONS.download} style={{ width: 19, height: 19, color: t.gold }} />
        <text style={{ fontSize: 14, color: t.text.primary, fontFamily: t.font.sans, flexGrow: 1 }}>
          {TEXTS.body}
        </text>
      </div>
      <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans, marginTop: 8 }}>
        {TEXTS.hint}
      </text>
    </Modal>
  )
}
