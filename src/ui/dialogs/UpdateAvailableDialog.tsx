/**
 * 更新可用对话框（设计 §4.7，520 宽）：版本对 mono 芯片 [current] → [next] +
 * changelog <markdown> maxHeight 280 内部滚动（模态浮层内合法）。
 * 前往下载 = cmd start（platform.openUrl）。
 */
import { editorTheme, useTheme, useThemeContext } from '../theme'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { Modal } from '../components/Modal'
import { useUiState } from '../../stores/uiState'
import { openUrl } from '../../services/platform'

const TEXTS = {
  title: '发现新版本',
  betaNotice: '这是一个测试版本，建议谨慎更新。',
  releaseNotice: '建议更新到最新版本以获得更好的体验和新功能。',
  noChangelog: '暂无更新日志',
  download: '前往下载',
  later: '稍后提醒',
} as const

export interface UpdateAvailableDialogProps {
  currentVersion: string
  latestVersion: string
  changelog: string | null
  downloadUrl: string
}

export function UpdateAvailableDialog({
  currentVersion,
  latestVersion,
  changelog,
  downloadUrl,
}: UpdateAvailableDialogProps) {
  const t = useTheme()
  const { mode } = useThemeContext()
  const isBeta = /beta|测试版|alpha|rc/i.test(latestVersion)

  return (
    <Modal
      open
      width={520}
      title={TEXTS.title}
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={
        <>
          <Button variant="quiet" onClick={() => useUiState.getState().closeTopDialog()} testId="update-later">
            {TEXTS.later}
          </Button>
          <Button
            variant="primary"
            icon="externalLink"
            onClick={() => {
              void openUrl(downloadUrl)
              useUiState.getState().closeTopDialog()
            }}
            testId="update-download">
            {TEXTS.download}
          </Button>
        </>
      }>
      {/* 版本对 */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Chip>{`v${currentVersion}`}</Chip>
        <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.mono }}>→</text>
        <Chip>{`v${latestVersion}`}</Chip>
      </div>
      <text style={{ fontSize: t.fs.field, color: isBeta ? t.status.warning : t.text.secondary, fontFamily: t.font.sans, marginBottom: 8 }}>
        {isBeta ? TEXTS.betaNotice : TEXTS.releaseNotice}
      </text>

      {/* changelog：markdown 内部滚动 */}
      <div
        style={{
          maxHeight: 280,
          overflow: 'scroll',
          backgroundColor: t.bg.deep,
          borderWidth: 1,
          borderColor: t.border.subtle,
          borderRadius: t.radius.md,
          padding: 12,
        }}>
        {changelog ? (
          <markdown source={changelog} theme={editorTheme(t, mode)} />
        ) : (
          <text style={{ fontSize: t.fs.field, color: t.text.muted, fontFamily: t.font.sans }}>
            {TEXTS.noChangelog}
          </text>
        )}
      </div>
    </Modal>
  )
}
