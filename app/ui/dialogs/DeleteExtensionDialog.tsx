/**
 * 删除扩展确认对话框（设计 §4.7，400 宽）：
 * 名称 13/500 + 路径 mono 11 muted + 正文；取消 primary / 删除 quiet + error 文字。
 * 文案 ← extension_page.show_delete_confirm_dialog。
 */
import { useUiState } from '../../stores/uiState'
import { uiStateActions } from '../../stores/uiState'
import { extensionDisplayFields, getExtensionManager, type ExtensionInfo } from '../../services/extensions'
import { useTerminalLogs } from '../../stores/terminalLogs'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'

const TEXTS = {
  title: '确认删除',
  body: (name: string) => `确定要删除插件 "${name}" 吗？`,
  irreversible: '此操作不可恢复！',
  nameLabel: '插件名称',
  cancel: '取消',
  remove: '删除',
} as const

export interface DeleteExtensionDialogProps {
  ext: ExtensionInfo
}

export function DeleteExtensionDialog({ ext }: DeleteExtensionDialogProps) {
  const t = useTheme()
  const fields = extensionDisplayFields(ext)

  const handleDelete = (): void => {
    useUiState.getState().closeTopDialog()
    const manager = getExtensionManager({
      log: (message) => useTerminalLogs.getState().appendLine(message),
    })
    const result = manager.deleteExtension(ext)
    uiStateActions.pushToast(result.ok ? 'success' : 'error', result.message)
    // 删除完成后 bump 计数驱动 ExtensionsView 重扫
    uiStateActions.bumpExtensions()
  }

  return (
    <Modal
      open
      width={400}
      title={TEXTS.title}
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={
        <>
          <Button variant="quietDanger" icon="trash" onClick={handleDelete} testId="delete-ext-confirm">
            {TEXTS.remove}
          </Button>
          <Button variant="primary" onClick={() => useUiState.getState().closeTopDialog()} testId="delete-ext-cancel">
            {TEXTS.cancel}
          </Button>
        </>
      }>
      <text style={{ fontSize: 13, fontWeight: 500, color: t.text.primary, fontFamily: t.font.sans }}>
        {TEXTS.body(fields.displayName)}
      </text>
      <div style={{ height: 4 }} />
      <text style={{ fontSize: 11, color: t.text.muted, fontFamily: t.font.mono }}>
        {`${TEXTS.nameLabel}: ${ext.name}`}
      </text>
      <text style={{ fontSize: 11, color: t.text.muted, fontFamily: t.font.mono }}>
        {ext.path}
      </text>
      <div style={{ height: 6 }} />
      <text style={{ fontSize: 13, color: t.status.error, fontFamily: t.font.sans }}>
        {TEXTS.irreversible}
      </text>
    </Modal>
  )
}
