/**
 * 年龄确认对话框（设计 §4.7，400 宽）：正文 14 + 警示 13 status.warning。
 * 覆盖 Flet 的 install_confirm（首次下载）与 first_start（首次启动）两个同构对话框。
 */
import { useState } from 'react'
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Checkbox } from '../components/Checkbox'
import { Modal, useModalClose } from '../components/Modal'

const TEXTS = {
  installTitle: '安装确认',
  installBody:
    '您即将下载第三方开源软件 SillyTavern。该软件可能支持 AI 角色扮演、情感互动等功能，' +
    '使用这些功能需遵守《人工智能拟人化互动服务管理暂行办法》。' +
    '本启动器不建议未满18周岁用户独立使用。未满14周岁用户须在监护人明确知情并同意的前提下使用。',
  startTitle: '启动确认',
  startBody:
    '您即将启动 SillyTavern，该软件可能包含 AI 角色扮演、情感互动等功能，' +
    '使用这些功能需遵守《人工智能拟人化互动服务管理暂行办法》。' +
    '本启动器不建议未满18周岁用户独立使用。未满14周岁用户须在监护人明确知情并同意的前提下使用。',
  ageCheckbox: '我已确认本人已年满18周岁，或作为未满18周岁用户已取得监护人同意',
  confirmInstall: '确认下载',
  confirmStart: '确认启动',
  cancel: '取消',
} as const

export interface AgeConfirmDialogProps {
  mode: 'install' | 'start'
  onConfirm: (ok: boolean) => void
}

/** 动作区（Provider 子树内取 useModalClose，PR4）：取消/确认统一走 requestClose 播退场 */
function AgeConfirmActions({ mode, checked, onConfirm }: AgeConfirmDialogProps & { checked: boolean }) {
  const requestClose = useModalClose()

  const closeAnd = (ok: boolean): void => {
    requestClose()
    onConfirm(ok)
  }

  return (
    <>
      <Button variant="quiet" onClick={() => closeAnd(false)} testId="age-cancel">
        {TEXTS.cancel}
      </Button>
      <Button
        variant="primary"
        icon={mode === 'install' ? 'download' : 'play'}
        disabled={!checked}
        onClick={() => closeAnd(true)}
        testId="age-confirm">
        {mode === 'install' ? TEXTS.confirmInstall : TEXTS.confirmStart}
      </Button>
    </>
  )
}

export function AgeConfirmDialog({ mode, onConfirm }: AgeConfirmDialogProps) {
  const t = useTheme()
  const [checked, setChecked] = useState(false)

  return (
    <Modal
      open
      strong
      width={400}
      title={mode === 'install' ? TEXTS.installTitle : TEXTS.startTitle}
      // 结算回调：退场播完后由 Modal 调用，直呼 closeTopDialog 真卸载（见 Modal.tsx 头注释）
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={<AgeConfirmActions mode={mode} checked={checked} onConfirm={onConfirm} />}>
      {/* 长文案 JS 拆行（无 white-space:pre） */}
      {(mode === 'install' ? TEXTS.installBody : TEXTS.startBody)
        .split('。')
        .filter((s) => s.length > 0)
        .map((sentence, i) => (
          <text
            key={i}
            style={{ fontSize: 14, color: t.text.primary, fontFamily: t.font.sans, lineHeight: 22 }}>
            {`${sentence}。`}
          </text>
        ))}
      <div style={{ height: 10 }} />
      <text style={{ fontSize: 13, color: t.status.warning, fontFamily: t.font.sans, marginBottom: 12 }}>
        {mode === 'install' ? '请确认后再继续下载' : '请确认后再继续启动'}
      </text>
      <Checkbox checked={checked} onChange={setChecked} label={TEXTS.ageCheckbox} testId="age-checkbox" />
    </Modal>
  )
}
