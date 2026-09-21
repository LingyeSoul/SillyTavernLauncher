/**
 * 版本切换确认对话框（设计 §4.7，440 宽）：目标版本 mono 芯片 + 日期 12 muted +
 * 警示 13 status.warning"切换版本可能会导致一些问题，请注意备份数据！"。
 * 确认后执行 executeVersionSwitch（stLifecycle.switchStVersion）。
 */
import { useState } from 'react'
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { Modal, useModalClose } from '../components/Modal'
import { executeVersionSwitch } from '../views/VersionView'

const TEXTS = {
  title: '确认切换版本',
  versionLabel: '版本',
  dateLabel: '日期',
  commitLabel: 'Commit',
  warning: '切换版本可能会导致一些问题，请注意备份数据！',
  confirm: '确认切换',
  cancel: '取消',
  switching: '切换中...',
} as const

export interface VersionSwitchDialogProps {
  version: string
  commit: string
  date: string
  tagName: string
}

/** 动作区（Provider 子树内取 useModalClose）：取消/确认统一走 requestClose 播退场（PR4） */
function VersionSwitchActions({ version, commit, tagName }: Pick<VersionSwitchDialogProps, 'version' | 'commit' | 'tagName'>) {
  const requestClose = useModalClose()
  const [switching, setSwitching] = useState(false)

  const handleConfirm = (): void => {
    setSwitching(true)
    requestClose()
    void executeVersionSwitch(version, commit, tagName)
  }

  return (
    <>
      <Button variant="quiet" onClick={requestClose} testId="version-switch-cancel">
        {TEXTS.cancel}
      </Button>
      <Button variant="primary" disabled={switching} onClick={handleConfirm} testId="version-switch-confirm">
        {switching ? TEXTS.switching : TEXTS.confirm}
      </Button>
    </>
  )
}

export function VersionSwitchDialog({ version, commit, date, tagName }: VersionSwitchDialogProps) {
  const t = useTheme()

  return (
    <Modal
      open
      width={440}
      title={TEXTS.title}
      // 结算回调：退场播完后由 Modal 调用，必须直呼 closeTopDialog 真卸载
      // （传 requestClose 会重入死循环，见 Modal.tsx 头注释）
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={<VersionSwitchActions version={version} commit={commit} tagName={tagName} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <text style={{ fontSize: t.fs.field, color: t.text.muted, fontFamily: t.font.sans }}>
            {`${TEXTS.versionLabel}:`}
          </text>
          <Chip>{`v${version}`}</Chip>
        </div>
        <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
          {`${TEXTS.dateLabel}: ${date}`}
        </text>
        <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.mono }}>
          {`${TEXTS.commitLabel}: ${commit.slice(0, 7)}`}
        </text>
        <div style={{ height: 6 }} />
        <text style={{ fontSize: t.fs.field, color: t.status.warning, fontFamily: t.font.sans }}>
          {TEXTS.warning}
        </text>
      </div>
    </Modal>
  )
}
