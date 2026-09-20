/**
 * 版本视图（设计 §4.2，固定头型 PageScaffold，2026-09-20 对齐设置页）：
 * DEVIATION: §4.2 原单滚动型（heading 随内容滚动），现推广固定头并 SmartScroll
 * 化（O11 回写）。workspace-heading（标题/当前版本/列表提示/刷新按钮）固定不随
 * 内容滚动，仅版本卡片列表区滚动。
 * - 当前版本卡：glow.ember 底 + 左 2px ember 条 + [当前] 芯片。
 * - 刷新中显示 5 张骨架卡（§5.9，D3：禁 spinner 顶替）。
 * - 版本数据来自 services/git.getStTags（视图经 hook 消费服务，不绕过）。
 * - 列表/加载/错误状态暂存于 stores/versionState（2026-09-20）：切页卸载不丢
 *   缓存，切回直接渲染已暂存数据，不再重走骨架动画与重复 git 扫描；手动刷新
 *   先 refreshVersion 再 reloadVersions 强制重拉（对齐原内联 loadVersions 语义，
 *   刷新后「当前」芯片同步校正）。挂载时静默 refreshVersion（本地 git describe）
 *   保证「当前」芯片在终端页更新/切版本后仍准确。
 */
import { useEffect } from 'react'
import { getStLifecycle, useStState } from '../../stores/stState'
import { useVersionState, type VersionEntry } from '../../stores/versionState'
import { uiStateActions } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { IconButton } from '../components/IconButton'
import { PageHeader } from '../components/PageHeader'
import { PageScaffold } from '../components/PageScaffold'
import { FieldHint } from '../components/FieldHint'
import { EmptyState } from '../components/EmptyState'
import { SkeletonCards } from '../components/Skeleton'
import { Tooltip } from '../components/Tooltip'

const TEXTS = {
  title: '版本管理',
  subtitlePrefix: '当前',
  subtitleNone: '未安装',
  refreshTip: '刷新版本列表',
  currentChip: '当前',
  switchTo: '切换到此版本',
  sourcePrefix: '来源:',
  listHint: '可选版本（升级请在终端页面使用更新按钮进行！！！）',
  emptyTitle: '暂无可用版本',
  emptyHint: '请先安装 SillyTavern 或点击刷新获取版本列表',
  loadFailed: '获取版本列表失败',
  refresh: '刷新',
} as const

export function VersionView() {
  const t = useTheme()
  const currentVersion = useStState((s) => s.currentVersion)
  const refreshVersion = useStState((s) => s.refreshVersion)
  const versions = useVersionState((s) => s.versions)
  const loading = useVersionState((s) => s.loading)
  const error = useVersionState((s) => s.error)
  const ensureVersions = useVersionState((s) => s.ensureVersions)
  const reloadVersions = useVersionState((s) => s.reloadVersions)

  useEffect(() => {
    void (async () => {
      // 先刷当前版本（本地 git describe，快）再拉列表：保证卡片渲染时「当前」芯片就绪
      await refreshVersion()
      await ensureVersions()
    })()
  }, [refreshVersion, ensureVersions])

  /** 手动刷新：先刷「当前」版本再强制重拉列表（对齐原内联 loadVersions 语义），
   *  刷新后「当前」芯片随终端页切版本/更新立即校正 */
  const handleReload = (): void => {
    void (async () => {
      await refreshVersion()
      await reloadVersions()
    })()
  }

  const subtitle = currentVersion
    ? `${TEXTS.subtitlePrefix} ${currentVersion.version ?? ''}${
        currentVersion.commit ? ` · Commit ${currentVersion.commit.slice(0, 7)}` : ''
      }`
    : TEXTS.subtitleNone

  return (
    <PageScaffold
      contentKey={`${loading}-${versions?.length ?? 0}-${error ?? ''}`}
      header={
        <>
          <PageHeader
            title={TEXTS.title}
            subtitle={subtitle}
            subtitleMono
            actions={
              <Tooltip label={TEXTS.refreshTip}>
                <IconButton
                  icon="refresh"
                  iconSize={19}
                  size={32}
                  label={TEXTS.refreshTip}
                  disabled={loading}
                  onClick={handleReload}
                  testId="version-refresh"
                />
              </Tooltip>
            }
          />
          {/* 列表提示（升级引导）：常驻固定区，不随列表滚走；与分隔线的间距统一
              sectionGap token（SyncView 安全警示同款，勿写裸值） */}
          <FieldHint style={{ marginBottom: t.space.sectionGap }}>{TEXTS.listHint}</FieldHint>
        </>
      }>
      {error && (
        <text style={{ fontSize: t.fs.field, color: t.status.error, fontFamily: t.font.sans, marginBottom: 8 }}>
          {`${TEXTS.loadFailed}: ${error}`}
        </text>
      )}

      {loading && <SkeletonCards count={5} />}

      {!loading && versions !== null && versions.length === 0 && (
        <EmptyState
          icon="gitBranch"
          title={TEXTS.emptyTitle}
          hint={TEXTS.emptyHint}
          action={
            <Button variant="primary" icon="refresh" onClick={handleReload} testId="version-empty-refresh">
              {TEXTS.refresh}
            </Button>
          }
        />
      )}

      {!loading &&
        versions?.map((entry) => (
          <VersionCard
            key={entry.version}
            entry={entry}
            current={(currentVersion?.version ?? '').replace(/^v/, '') === entry.version}
          />
        ))}
    </PageScaffold>
  )
}

function VersionCard({ entry, current }: { entry: VersionEntry; current: boolean }) {
  const t = useTheme()
  const openDialog = uiStateActions.openDialog
  const date = entry.tag.date.slice(0, 10)
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 64,
        paddingLeft: 16,
        paddingRight: 12,
        marginBottom: t.space.cardGap,
        backgroundColor: current ? t.glow.ember : t.bg.surface,
        borderWidth: 1,
        borderColor: current ? t.ember : t.border.subtle,
        borderRadius: t.radius.md,
        hover: current ? undefined : { borderColor: t.border.default },
      }}>
      {/* 左 2px ember 条（仅当前版本，绝对定位子 div = inset 阴影等效） */}
      {current && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 6,
            bottom: 6,
            width: 2,
            borderRadius: 1,
            backgroundColor: t.ember,
            pointerEvents: 'none',
          }}
        />
      )}
      {/* GPUIX text 的多个字符串子节点会各生成独立文本节点纵向堆叠（无内联 run），
          拼接文案必须合成单个模板字面量子节点，否则行数翻倍撑破卡片 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <text style={{ fontSize: t.fs.field, fontWeight: 600, fontFamily: t.font.mono, color: t.text.primary }}>
            {`v${entry.version}`}
          </text>
          <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>{date}</text>
        </div>
        <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
          {`${TEXTS.sourcePrefix} tag ${entry.tag.tag_name}`}
        </text>
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {current && <Chip accent>{TEXTS.currentChip}</Chip>}
        {!current && (
          <Button
            variant="quiet"
            onClick={() => {
              openDialog({
                kind: 'versionSwitch',
                version: entry.version,
                commit: entry.tag.commit,
                date,
                tagName: entry.tag.tag_name,
              })
            }}
            testId={`version-switch-${entry.version}`}>
            {TEXTS.switchTo}
          </Button>
        )}
      </div>
    </div>
  )
}

/** 切换版本执行（对话框确认后调用；dialogs/versionSwitch 引用） */
export async function executeVersionSwitch(
  version: string,
  commit: string,
  tagName: string,
): Promise<void> {
  const result = await getStLifecycle().switchStVersion({ version, commit }, tagName)
  if (result.ok) uiStateActions.pushToast('success', result.message)
  else uiStateActions.pushToast('error', result.message)
  const { refreshVersion, refresh } = useStState.getState()
  refreshVersion().catch(() => undefined)
  refresh()
}
