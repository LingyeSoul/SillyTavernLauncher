/**
 * 扩展视图（设计 §4.4，2026-09-20 分 tab 对齐设置页）：
 * DEVIATION: §4.4 原单滚动型（heading 随内容滚动）→ 固定头 + SmartScroll → 现按
 * 用户要求全局/用户双列表分 tab（设置页同款「固定头 + tab 栏 + scrollKey 重挂」形态）：
 * workspace-heading + 安装按钮组 + tab 栏固定不随内容滚动，tab 内列表滚动（切 tab
 * 重挂回顶部）。tab 标签携带计数（原 SectionTitle 计数移入：浏览全局时用户扩展数
 * 仍常显，tab 内不再重复渲染同名 section 标题）。
 * 扩展卡图标：无图标资源时回退 28px bg-elevated + 首字母（manifest 无图标字段的常态）。
 * 安装/删除/移动全部经对话框确认（dialogs/gitInstall、zipInstall、deleteExtension）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  extensionDisplayFields,
  getExtensionManager,
  type ExtensionInfo,
} from '../../services/extensions'
import { useTerminalLogs } from '../../stores/terminalLogs'
import { uiStateActions, useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { FieldHint } from '../components/FieldHint'
import { PageHeader } from '../components/PageHeader'
import { PageScaffold } from '../components/PageScaffold'
import { Tooltip } from '../components/Tooltip'

type ExtensionsTabId = 'global' | 'user'

const TEXTS = {
  title: '扩展管理',
  subtitle: '管理 SillyTavern 的全局与用户扩展',
  // 分 tab（对齐设置页）
  tabGlobal: '全局扩展',
  tabUser: '用户扩展',
  gitInstall: 'Git 安装',
  zipInstall: 'ZIP 安装',
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

/** tab 顺序即默认关注顺序：全局 → 用户（默认激活第一项） */
const EXTENSIONS_TABS: Array<{ id: ExtensionsTabId; label: string }> = [
  { id: 'global', label: TEXTS.tabGlobal },
  { id: 'user', label: TEXTS.tabUser },
]

export function ExtensionsView() {
  const t = useTheme()
  const [activeTab, setActiveTab] = useState<ExtensionsTabId>('global')
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

  const tabLists: Record<ExtensionsTabId, ExtensionInfo[]> = {
    global: globalExts,
    user: userExts,
  }

  /** tab 项：激活 = ember 下划线（绝对定位压在 tab 栏 1px 分隔线上）+ 600 字重，
   *  未激活 hover 即时切 bg.hover（设置页 tabItem 同款）；计数 fs.caption muted
   *  随标签常显（flex row 内相邻 text 才同行） */
  const tabItem = (tab: { id: ExtensionsTabId; label: string }): ReactElement => {
    const active = activeTab === tab.id
    return (
      <div
        key={tab.id}
        onClick={() => setActiveTab(tab.id)}
        role="tab"
        aria-selected={active}
        testId={`extensions-tab-${tab.id}`}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 34,
          paddingLeft: 14,
          paddingRight: 14,
          borderRadius: t.radius.sm,
          cursor: 'pointer',
          userSelect: 'none',
          hover: active ? undefined : { backgroundColor: t.bg.hover },
        }}>
        {active && (
          <div
            style={{
              position: 'absolute',
              left: 10,
              right: 10,
              bottom: -1,
              height: 2,
              borderRadius: 1,
              backgroundColor: t.ember,
              pointerEvents: 'none',
            }}
          />
        )}
        <text
          style={{
            fontSize: t.fs.field,
            fontWeight: active ? 600 : 400,
            color: active ? t.ember : t.text.secondary,
            fontFamily: t.font.sans,
          }}>
          {tab.label}
        </text>
        <text
          style={{
            fontSize: t.fs.caption,
            color: t.text.muted,
            fontFamily: t.font.sans,
            marginLeft: 6,
          }}>
          {`${tabLists[tab.id].length}`}
        </text>
      </div>
    )
  }

  /** 单 tab 内容：路径提示 + 列表（列表型 section 不包 Card：行自身即卡片，
   *  同 SyncView 发现列表先例） */
  const tabList = (id: ExtensionsTabId): ReactElement => {
    const exts = tabLists[id]
    const emptyTitle = id === 'global' ? TEXTS.emptyGlobal : TEXTS.emptyUser
    const pathHint = id === 'global' ? TEXTS.globalPathHint : TEXTS.userPathHint
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <FieldHint style={{ marginBottom: t.space.fieldGap }}>{pathHint}</FieldHint>
        {exts.length === 0 ? (
          <EmptyState icon="puzzle" title={emptyTitle} hint={TEXTS.emptyHint} />
        ) : (
          exts.map((ext) => <ExtensionCard key={ext.path} ext={ext} onChanged={refresh} />)
        )}
      </div>
    )
  }

  return (
    <PageScaffold
      contentKey={`${globalExts.length}-${userExts.length}`}
      scrollKey={activeTab}
      testId="extensions-tab-scroll"
      header={
        <>
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
          {/* tab 栏：底部 1px 分隔线由 PageScaffold 收口（激活下划线压线） */}
          <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
            {EXTENSIONS_TABS.map(tabItem)}
          </div>
        </>
      }>
      {/* 滚动区仅 tab 内容：scrollKey 按 tab 重挂 → 切 tab 回到顶部（设置页同款） */}
      {activeTab === 'global' && tabList('global')}
      {activeTab === 'user' && tabList('user')}
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
