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
 *   强制重拉列表（对齐原内联 loadVersions 语义）。挂载与手动刷新都两路并行
 *   （2026-09-21）：串行时列表被当前版本读取阻塞，且两读各读一份 pack。
 * - 副标题口径（2026-09-21 修复「能启动酒馆却提示未安装」）：未安装只由 stState
 *   .installed（ST 目录完整性）决定；当前版本读取中 → 读取中...；已安装但读不出
 *   （非 Git 仓库/无 tag/失败）→ 未知。此前 currentVersion 为空一律显「未安装」，
 *   慢读窗口内与事实相反。
 * - 真实版本卡 stagger 入场（theme.ts stagger token）：每项 opacity 0→1 +
 *   top 4→0（≤6px 位移纪律），延迟按序递增、超过 maxItems 封顶；motion 的
 *   initial 仅挂载时生效——同 key 数据刷新天然不重播，无需额外状态。
 */
import { useEffect } from 'react'
import { motion } from '@gpuix/react'
import { getStLifecycle, useStState } from '../../stores/stState'
import { useVersionState, type VersionEntry } from '../../stores/versionState'
import { uiStateActions } from '../../stores/uiState'
import { EASE_OUT_QUAD, dur, stagger } from '../../theme'
import { useMotion, useTheme } from '../theme'
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
  /** 未安装（ST 目录不完整）时才可断言未安装；版本读取中/失败不得冒充 */
  subtitleNone: '未安装',
  subtitleLoading: '读取中...',
  /** 已安装但版本不可读（非 Git 仓库 / 无 tag / 读取失败） */
  subtitleUnknown: '未知',
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
  const { enabled: motionEnabled } = useMotion()
  const currentVersion = useStState((s) => s.currentVersion)
  const versionLoading = useStState((s) => s.versionLoading)
  const installed = useStState((s) => s.installed)
  const refreshVersion = useStState((s) => s.refreshVersion)
  const versions = useVersionState((s) => s.versions)
  const loading = useVersionState((s) => s.loading)
  const error = useVersionState((s) => s.error)
  const ensureVersions = useVersionState((s) => s.ensureVersions)
  const reloadVersions = useVersionState((s) => s.reloadVersions)

  useEffect(() => {
    // 当前版本与版本列表并行拉取：列表不再等当前版本读出（此前串行 + 慢读
    // 让整页空窗数十秒，见 2026-09-21 版本页「未安装」实测）。
    // allSettled：两路各自 try-catch + logError，这里只为兜住意外拒绝的 unhandled 噪音
    void Promise.allSettled([refreshVersion(), ensureVersions()])
  }, [refreshVersion, ensureVersions])

  /** 手动刷新：与挂载同口径两路并行重拉——「当前」芯片与列表互不等待，且并行共用
   *  一份 pack 缓冲（串行两读各读一份 pack，见 services/isoGit 读缓存说明） */
  const handleReload = (): void => {
    void Promise.allSettled([refreshVersion(), reloadVersions()])
  }

  // 副标题口径：未安装只看安装态，读取中/不可读不得冒充「未安装」（用户能在终端
  // 页启动酒馆，却在版本页看到未安装 = 事实错误；2026-09-21 实测修复）
  const subtitle = currentVersion
    ? currentVersion.version
      ? `${TEXTS.subtitlePrefix} ${currentVersion.version}${
          currentVersion.commit ? ` · Commit ${currentVersion.commit.slice(0, 7)}` : ''
        }`
      : currentVersion.commit
        ? `Commit ${currentVersion.commit.slice(0, 7)}`
        : installed
          ? TEXTS.subtitleUnknown
          : TEXTS.subtitleNone
    : versionLoading
      ? TEXTS.subtitleLoading
      : installed
        ? TEXTS.subtitleUnknown
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
        versions?.map((entry, i) => (
          // stagger 入场包装（骨架 SkeletonCards 不参与）：delay 门控归零纪律
          // ——motion 关时 initial={false} + duration 0 + delay 0 三件套齐发，
          // delay 残留会让内容延迟出现（theme.tsx useMotion 注释同款纪律）
          <motion.div
            key={entry.version}
            initial={motionEnabled ? { opacity: 0, top: 4 } : false}
            animate={{ opacity: 1, top: 0 }}
            transition={{
              duration: motionEnabled ? dur.enter : 0,
              ease: EASE_OUT_QUAD,
              delay: motionEnabled ? Math.min(i, stagger.maxItems - 1) * stagger.itemDelay : 0,
            }}
            style={{ position: 'relative' }}>
            <VersionCard
              entry={entry}
              current={(currentVersion?.version ?? '').replace(/^v/, '') === entry.version}
            />
          </motion.div>
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
