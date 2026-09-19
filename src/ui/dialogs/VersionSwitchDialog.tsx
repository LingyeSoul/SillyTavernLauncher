/**
 * 版本切换确认对话框（设计 §4.7，440 宽）：目标版本 mono 芯片 + 日期 12 muted +
 * 警示 13 status.warning"切换版本可能会导致一些问题，请注意备份数据！"。
 * 确认后执行 executeVersionSwitch（stLifecycle.switchStVersion）。
 */
import { useState } from 'react'
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'
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

export function VersionSwitchDialog({ version, commit, date, tagName }: VersionSwitchDialogProps) {
  const t = useTheme()
  const [switching, setSwitching] = useState(false)

  const handleConfirm = (): void => {
    setSwitching(true)
    useUiState.getState().closeTopDialog()
    void executeVersionSwitch(version, commit, tagName)
  }

  return (
    <Modal
      open
      width={440}
      title={TEXTS.title}
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={
        <>
          <Button variant="quiet" onClick={() => useUiState.getState().closeTopDialog()} testId="version-switch-cancel">
            {TEXTS.cancel}
          </Button>
          <Button variant="primary" disabled={switching} onClick={handleConfirm} testId="version-switch-confirm">
            {switching ? TEXTS.switching : TEXTS.confirm}
          </Button>
        </>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <text style={{ fontSize: 13, color: t.text.muted, fontFamily: t.font.sans }}>
            {`${TEXTS.versionLabel}:`}
          </text>
          <div
            style={{
              display: 'flex',
              paddingLeft: 6,
              paddingRight: 6,
              paddingTop: 2,
              paddingBottom: 2,
              borderWidth: 1,
              borderColor: t.border.default,
              borderRadius: 3,
            }}>
            <text style={{ fontSize: 11, fontFamily: t.font.mono, color: t.text.secondary }}>
              {`v${version}`}
            </text>
          </div>
        </div>
        <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
          {`${TEXTS.dateLabel}: ${date}`}
        </text>
        <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.mono }}>
          {`${TEXTS.commitLabel}: ${commit.slice(0, 7)}`}
        </text>
        <div style={{ height: 6 }} />
        <text style={{ fontSize: 13, color: t.status.warning, fontFamily: t.font.sans }}>
          {TEXTS.warning}
        </text>
      </div>
    </Modal>
  )
}
