/**
 * 扩展视图（设计 §4.4，固定头型 PageScaffold，2026-09-20 对齐设置页）：
 * DEVIATION: §4.4 原单滚动型（heading 随内容滚动），现推广固定头并 SmartScroll
 * 化（O11 回写）。workspace-heading + 安装按钮组固定不随内容滚动，全局/用户双列表滚动。
 * 扩展卡图标：无图标资源时回退 28px bg-elevated + 首字母（manifest 无图标字段的常态）。
 * 安装/删除/移动全部经对话框确认（dialogs/gitInstall、zipInstall、deleteExtension）。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  extensionDisplayFields,
  getExtensionManager,
  type ExtensionInfo,
} from '../../services/extensions'
import { useTerminalLogs } from '../../stores/terminalLogs'
import { uiStateActions, useUiState } from '../../stores/uiState'
import { layout } from '../../theme'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { FieldHint } from '../components/FieldHint'
import { PageHeader } from '../components/PageHeader'
import { PageScaffold } from '../components/PageScaffold'
import { SectionTitle } from '../components/Card'
import { Tooltip } from '../components/Tooltip'

const TEXTS = {
  title: '扩展管理',
  subtitle: '管理 SillyTavern 的全局与用户扩展',
  gitInstall: 'Git 安装',
  zipInstall: 'ZIP 安装',
  globalSection: '全局扩展',
  userSection: '用户扩展',
  globalPathHint: '全局扩展对所有用户生效，路径: SillyTavern/public/scripts/extensions/third-party',
  userPathHint: '用户扩展仅对当前用户生效，路径: SillyTavern/data/default-user/extensions',
  emptyGlobal: '暂无全局扩展',
  emptyUser: '暂无用户扩展',
  emptyHint: '通过右上角的 Git 安装或 ZIP 安装添加扩展',
  move: '移动',
  moveGlobalToUser: '移动到用户扩展',
  moveUserToGlobal: '移动到全局扩展',
  remove: '删除',
  invalidExt: '无效扩展',
  author: '作者',
  name: '名称',
  versionUnknown: '未知',
} as const

export function ExtensionsView() {
  const t = useTheme()
  const [globalExts, setGlobalExts] = useState<ExtensionInfo[]>([])
  const [userExts, setUserExts] = useState<ExtensionInfo[]>([])
  // 安装/删除对话框完成后 bump 此计数，驱动本视图重扫（Bug#3：列表不刷新）
  const extensionsVersion = useUiState((s) => s.extensionsVersion)

  const refresh = useCallback(() => {
    // 日志统一进终端（Bug#7：原先只进 console）
    const manager = getExtensionManager({
      log: (message) => useTerminalLogs.getState().appendLine(message),
    })
    const all = manager.getAllExtensions()
    setGlobalExts(all.global)
    setUserExts(all.user)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, extensionsVersion])

  return (
    <PageScaffold
      contentKey={`${globalExts.length}-${userExts.length}`}
      header={
        <PageHeader
          title={TEXTS.title}
          subtitle={TEXTS.subtitle}
          actions={
            <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
              <Button variant="primary" icon="box" onClick={() => uiStateActions.openDialog({ kind: 'gitInstall' })} testId="ext-git-install">
                {TEXTS.gitInstall}
              </Button>
              <Button variant="default" icon="archive" onClick={() => uiStateActions.openDialog({ kind: 'zipInstall' })} testId="ext-zip-install">
                {TEXTS.zipInstall}
              </Button>
            </div>
          }
        />
      }>

      {/* 全局扩展（列表型 section 不包 Card：行自身即卡片，同 SyncView 发现列表先例） */}
      <div style={{ marginBottom: layout.padFormY }}>
        <SectionTitle title={TEXTS.globalSection} count={globalExts.length} />
        <FieldHint style={{ marginBottom: t.space.fieldGap }}>{TEXTS.globalPathHint}</FieldHint>
        {globalExts.length === 0 ? (
          <EmptyState icon="puzzle" title={TEXTS.emptyGlobal} hint={TEXTS.emptyHint} />
        ) : (
          globalExts.map((ext) => <ExtensionCard key={ext.path} ext={ext} onChanged={refresh} />)
        )}
      </div>

      {/* 用户扩展 */}
      <div>
        <SectionTitle title={TEXTS.userSection} count={userExts.length} />
        <FieldHint style={{ marginBottom: t.space.fieldGap }}>{TEXTS.userPathHint}</FieldHint>
        {userExts.length === 0 ? (
          <EmptyState icon="puzzle" title={TEXTS.emptyUser} hint={TEXTS.emptyHint} />
        ) : (
          userExts.map((ext) => <ExtensionCard key={ext.path} ext={ext} onChanged={refresh} />)
        )}
      </div>
    </PageScaffold>
  )
}

function ExtensionCard({ ext, onChanged }: { ext: ExtensionInfo; onChanged: () => void }) {
  const t = useTheme()
  const fields = extensionDisplayFields(ext)
  const initial = (fields.displayName || ext.name).charAt(0).toUpperCase() || '?'
  const isGlobal = ext.extType === 'global'

  const doMove = (): void => {
    const manager = getExtensionManager()
    const target = isGlobal ? 'user' : 'global'
    const result = manager.moveExtension(ext, target)
    if (result.ok) uiStateActions.pushToast('success', result.message)
    else uiStateActions.pushToast('error', result.message)
    onChanged()
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 56,
        paddingLeft: 12,
        paddingRight: 8,
        paddingTop: 8,
        paddingBottom: 8,
        marginBottom: t.space.cardGap,
        backgroundColor: t.bg.surface,
        borderWidth: 1,
        borderColor: ext.isValid ? t.border.subtle : t.status.warning,
        borderRadius: t.radius.md,
      }}>
      {/* 图标回退：28px bg-elevated + 首字母（manifest 无图标字段） */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          backgroundColor: t.bg.elevated,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
        <text style={{ fontSize: t.fs.field, fontWeight: 600, color: t.text.secondary, fontFamily: t.font.sans }}>
          {initial}
        </text>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <text
            style={{
              fontSize: t.fs.field,
              fontWeight: 500,
              color: ext.isValid ? t.text.primary : t.status.warning,
              fontFamily: t.font.sans,
            }}>
            {fields.displayName}
          </text>
          <text style={{ fontSize: t.fs.micro, color: t.text.muted, fontFamily: t.font.mono }}>
            {`v${fields.version}`}
          </text>
          {!ext.isValid && (
            <text style={{ fontSize: t.fs.micro, color: t.status.warning, fontFamily: t.font.sans }}>
              {TEXTS.invalidExt}
            </text>
          )}
        </div>
        <text style={{ fontSize: t.fs.micro, color: t.text.muted, fontFamily: t.font.sans }}>
          {`${TEXTS.author}: ${fields.author} · ${TEXTS.name}: ${ext.name}`}
        </text>
        {!ext.isValid && (
          <text style={{ fontSize: t.fs.micro, color: t.status.warning, fontFamily: t.font.sans }}>
            {ext.errorMsg}
          </text>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'row', gap: 4, flexShrink: 0 }}>
        <Tooltip label={isGlobal ? TEXTS.moveGlobalToUser : TEXTS.moveUserToGlobal}>
          <Button variant="quiet" onClick={doMove} testId={`ext-move-${ext.name}`}>
            {TEXTS.move}
          </Button>
        </Tooltip>
        <Button
          variant="quietDanger"
          icon="trash"
          onClick={() => uiStateActions.openDialog({ kind: 'deleteExtension', ext })}
          testId={`ext-delete-${ext.name}`}>
          {TEXTS.remove}
        </Button>
      </div>
    </div>
  )
}
