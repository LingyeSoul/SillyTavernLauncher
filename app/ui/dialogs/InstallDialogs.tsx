/**
 * 扩展安装对话框 ×2（设计 §4.7）：
 * - Git 安装（480）：仓库 URL input mono 13 + 安装目标 Select（全局/用户）。
 * - ZIP 安装（480）：路径只读 input mono + 浏览…（PowerShell OpenFileDialog）+ 目标 Select。
 * 校验语义 ← extension_page（http(s)/git@ 前缀、非空 ZIP 路径）；安装有 busy 状态反馈。
 */
import { useState } from 'react'
import { getExtensionManager, type ExtensionType } from '../../services/extensions'
import { pickZipFile } from '../../services/platform'
import { useTerminalLogs } from '../../stores/terminalLogs'
import { uiStateActions, useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'

const TEXTS = {
  gitTitle: '从 Git 安装扩展',
  gitHint: '支持 GitHub 仓库，自动使用设置的镜像源加速下载',
  gitUrlLabel: 'Git 仓库地址',
  gitUrlEmpty: '请输入 Git 仓库地址',
  gitUrlInvalid: '无效的 Git 仓库地址',
  zipTitle: '从 ZIP 安装扩展',
  zipHint: '请选择 ZIP 文件或输入文件路径',
  zipPathLabel: 'ZIP 文件路径',
  zipPathPlaceholder: '请选择 ZIP 文件',
  zipBrowse: '浏览…',
  zipEmpty: '请选择 ZIP 文件',
  targetLabel: '安装到',
  install: '安装',
  installing: '安装中...',
  cancel: '取消',
} as const

const TARGET_ITEMS = [
  { value: 'global', label: '全局插件' },
  { value: 'user', label: '用户插件' },
]

function closeTop(): void {
  useUiState.getState().closeTopDialog()
}

export function GitInstallDialog() {
  const t = useTheme()
  const [url, setUrl] = useState('')
  const [target, setTarget] = useState('global')
  const [installing, setInstalling] = useState(false)

  const handleInstall = (): void => {
    const trimmed = url.trim()
    if (!trimmed) {
      uiStateActions.pushToast('error', TEXTS.gitUrlEmpty)
      return
    }
    // ← extension_page 的 URL 校验（http:// / https:// / git@）
    if (!(trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('git@'))) {
      uiStateActions.pushToast('error', TEXTS.gitUrlInvalid)
      return
    }
    const extType: ExtensionType = target === 'global' ? 'global' : 'user'
    setInstalling(true)
    closeTop()
    void (async () => {
      const manager = getExtensionManager({
        log: (message) => useTerminalLogs.getState().appendLine(message),
      })
      const result = await manager.installFromGit(trimmed, extType)
      uiStateActions.pushToast(result.ok ? 'success' : 'error', result.message)
    })()
  }

  return (
    <Modal
      open
      width={480}
      title={TEXTS.gitTitle}
      onClose={closeTop}
      actions={
        <>
          <Button variant="quiet" onClick={closeTop} testId="git-install-cancel">
            {TEXTS.cancel}
          </Button>
          <Button variant="primary" icon="download" disabled={installing} onClick={handleInstall} testId="git-install-confirm">
            {installing ? TEXTS.installing : TEXTS.install}
          </Button>
        </>
      }>
      <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans, marginBottom: 8 }}>
        {TEXTS.gitHint}
      </text>
      <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans, marginBottom: 4 }}>
        {TEXTS.gitUrlLabel}
      </text>
      <Input value={url} onChange={setUrl} mono testId="git-install-url" />
      <div style={{ height: 8 }} />
      <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans, marginBottom: 4 }}>
        {TEXTS.targetLabel}
      </text>
      <Select items={TARGET_ITEMS} value={target} onValueChange={setTarget} width={160} testId="git-install-target" />
    </Modal>
  )
}

export function ZipInstallDialog() {
  const t = useTheme()
  const [path, setPath] = useState('')
  const [target, setTarget] = useState('global')
  const [installing, setInstalling] = useState(false)
  const [picking, setPicking] = useState(false)

  const handleBrowse = (): void => {
    setPicking(true)
    void pickZipFile().then((picked) => {
      setPicking(false)
      if (picked) setPath(picked)
    })
  }

  const handleInstall = (): void => {
    const trimmed = path.trim()
    if (!trimmed) {
      uiStateActions.pushToast('error', TEXTS.zipEmpty)
      return
    }
    const extType: ExtensionType = target === 'global' ? 'global' : 'user'
    setInstalling(true)
    closeTop()
    void (async () => {
      const manager = getExtensionManager({
        log: (message) => useTerminalLogs.getState().appendLine(message),
      })
      const result = await manager.installFromZip(trimmed, extType)
      uiStateActions.pushToast(result.ok ? 'success' : 'error', result.message)
    })()
  }

  return (
    <Modal
      open
      width={480}
      title={TEXTS.zipTitle}
      onClose={closeTop}
      actions={
        <>
          <Button variant="quiet" onClick={closeTop} testId="zip-install-cancel">
            {TEXTS.cancel}
          </Button>
          <Button variant="primary" icon="archive" disabled={installing} onClick={handleInstall} testId="zip-install-confirm">
            {installing ? TEXTS.installing : TEXTS.install}
          </Button>
        </>
      }>
      <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans, marginBottom: 8 }}>
        {TEXTS.zipHint}
      </text>
      <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans, marginBottom: 4 }}>
        {TEXTS.zipPathLabel}
      </text>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <Input value={path} onChange={setPath} placeholder={TEXTS.zipPathPlaceholder} mono testId="zip-install-path" />
        </div>
        <Button variant="default" icon="folder" disabled={picking} onClick={handleBrowse} testId="zip-install-browse">
          {TEXTS.zipBrowse}
        </Button>
      </div>
      <div style={{ height: 8 }} />
      <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans, marginBottom: 4 }}>
        {TEXTS.targetLabel}
      </text>
      <Select items={TARGET_ITEMS} value={target} onValueChange={setTarget} width={160} testId="zip-install-target" />
    </Modal>
  )
}
