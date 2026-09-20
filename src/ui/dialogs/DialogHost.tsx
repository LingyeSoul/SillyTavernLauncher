/**
 * DialogHost：按 uiState.dialogs 栈渲染**栈顶**对话框。
 *
 * 只渲染栈顶（而非全栈 map）：GPUIX 0.9.0 多个 deferred anchored 共存时，
 * 上层卸载后下层的绘制/命中层不恢复（首启 EULA→welcome 切换实测丢失）；
 * 仅渲染栈顶让下层对话框在顶关闭后全新挂载，绕开该怪癖，模态语义也更正确
 * （被完全遮挡的对话框本就无需保持挂载）。栈底对话框的内部状态（如答题进度）
 * 在上层关闭后会重置——当前叠弹组合（welcome+eula）无跨层状态依赖
 * （welcome 总在 EULA 之后首次出现）。
 */
import { useUiState } from '../../stores/uiState'
import type { DialogDescriptor } from '../../stores/uiState'
import { EulaDialog } from './EulaDialog'
import { WelcomeDialog } from './WelcomeDialog'
import { IpWhitelistDialog, HostWhitelistDialog } from './WhitelistDialogs'
import { AgeConfirmDialog } from './AgeConfirmDialog'
import { UpdateAvailableDialog } from './UpdateAvailableDialog'
import { ErrorDialog } from './ErrorDialog'
import { ExitConfirmDialog } from './ExitConfirmDialog'
import { SyncFirstRunDialog } from './SyncFirstRunDialog'
import { VersionSwitchDialog } from './VersionSwitchDialog'
import { GitInstallDialog, ZipInstallDialog } from './InstallDialogs'
import { DeleteExtensionDialog } from './DeleteExtensionDialog'

export function DialogHost() {
  const dialogs = useUiState((s) => s.dialogs)
  const top = dialogs[dialogs.length - 1]
  return top === undefined ? null : <DialogSlot key={dialogs.length - 1} dialog={top} />
}

function DialogSlot({ dialog }: { dialog: DialogDescriptor }) {
  switch (dialog.kind) {
    case 'eula':
      return <EulaDialog />
    case 'welcome':
      return <WelcomeDialog />
    case 'ipWhitelist':
      return <IpWhitelistDialog />
    case 'hostWhitelist':
      return <HostWhitelistDialog />
    case 'ageConfirm':
      return <AgeConfirmDialog mode={dialog.mode} onConfirm={dialog.onConfirm} />
    case 'updateAvailable':
      return (
        <UpdateAvailableDialog
          currentVersion={dialog.currentVersion}
          latestVersion={dialog.latestVersion}
          changelog={dialog.changelog}
          downloadUrl={dialog.downloadUrl}
        />
      )
    case 'error':
      return <ErrorDialog title={dialog.title} message={dialog.message} detail={dialog.detail} />
    case 'exitConfirm':
      return <ExitConfirmDialog onConfirm={dialog.onConfirm} />
    case 'syncFirstRun':
      return <SyncFirstRunDialog onConfirm={dialog.onConfirm} />
    case 'versionSwitch':
      return (
        <VersionSwitchDialog
          version={dialog.version}
          commit={dialog.commit}
          date={dialog.date}
          tagName={dialog.tagName}
        />
      )
    case 'gitInstall':
      return <GitInstallDialog />
    case 'zipInstall':
      return <ZipInstallDialog />
    case 'deleteExtension':
      return <DeleteExtensionDialog ext={dialog.ext} />
    default:
      return null
  }
}
