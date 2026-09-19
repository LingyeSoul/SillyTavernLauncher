/**
 * 版本视图（设计 §4.2，单滚动型）：版本卡片列表 + 切换确认 + 刷新。
 * - 当前版本卡：glow.ember 底 + 左 2px ember 条 + [当前] 芯片。
 * - 刷新中显示 5 张骨架卡（§5.9，D3：禁 spinner 顶替）。
 * - 版本数据来自 services/git.getStTags（视图经 hook 消费服务，不绕过）。
 */
import { useCallback, useEffect, useState } from 'react'
import { compareVersions } from '../../services/env'
import { getStTags } from '../../services/git'
import type { GitTag } from '../../services/types'
import { getStLifecycle, useStState } from '../../stores/stState'
import { useTerminalLogs } from '../../stores/terminalLogs'
import { uiStateActions } from '../../stores/uiState'
import { layout } from '../../theme'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { SkeletonCards } from '../components/Skeleton'
import { Tooltip } from '../components/Tooltip'
import { ICONS } from '../components/icons'

const TEXTS = {
  title: '版本管理',
  subtitlePrefix: '当前',
  subtitleNone: '未安装',
  refreshTip: '刷新版本列表',
  refreshing: '正在刷新版本信息...',
  currentChip: '当前',
  switchTo: '切换到此版本',
  sourcePrefix: '来源:',
  listHint: '可选版本（升级请在终端页面使用更新按钮进行！！！）',
  emptyTitle: '暂无可用版本',
  emptyHint: '请先安装 SillyTavern 或点击刷新获取版本列表',
  loadFailed: '获取版本列表失败',
} as const

interface VersionEntry {
  version: string
  tag: GitTag
}

export function VersionView() {
  const t = useTheme()
  const currentVersion = useStState((s) => s.currentVersion)
  const refreshVersion = useStState((s) => s.refreshVersion)
  const [versions, setVersions] = useState<VersionEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadVersions = useCallback(async () => {
    if (loading) return
    setLoading(true)
    setError(null)
    useTerminalLogs.getState().appendLine(TEXTS.refreshing)
    try {
      await refreshVersion()
      const result = await getStTags()
      if (!result.ok || !result.data) {
        setError(result.message)
        setVersions([])
        return
      }
      const entries = Object.entries(result.data.versions)
        .map(([version, tag]) => ({ version, tag }))
        .sort((a, b) => compareVersions(b.version, a.version))
      setVersions(entries)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setVersions([])
    } finally {
      setLoading(false)
    }
  }, [loading, refreshVersion])

  useEffect(() => {
    void loadVersions()
    // 仅挂载时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const subtitle = currentVersion
    ? `${TEXTS.subtitlePrefix} ${currentVersion.version ?? ''}${
        currentVersion.commit ? ` · Commit ${currentVersion.commit.slice(0, 7)}` : ''
      }`
    : TEXTS.subtitleNone

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        paddingTop: layout.padFormY,
        paddingBottom: layout.padFormY,
        paddingLeft: layout.padFormX,
        paddingRight: layout.padFormX,
      }}>
      {/* workspace-heading */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <text style={{ fontSize: 26, fontWeight: 600, color: t.text.primary, fontFamily: t.font.sans }}>
            {TEXTS.title}
          </text>
          <text style={{ fontSize: 13, color: t.text.muted, fontFamily: t.font.mono }}>
            {subtitle}
          </text>
        </div>
        <Tooltip label={TEXTS.refreshTip}>
          <div
            onClick={() => void loadVersions()}
            role="button"
            aria-label={TEXTS.refreshTip}
            testId="version-refresh"
            style={{
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: t.radius.sm,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.32 : 1,
              hover: { backgroundColor: t.bg.hover },
            }}>
            <svg source={ICONS.refresh} style={{ width: 19, height: 19, color: t.text.secondary }} />
          </div>
        </Tooltip>
      </div>

      <div style={{ height: 16 }} />

      {error && (
        <text style={{ fontSize: 13, color: t.status.error, fontFamily: t.font.sans, marginBottom: 8 }}>
          {`${TEXTS.loadFailed}: ${error}`}
        </text>
      )}
      <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans, marginBottom: 8 }}>
        {TEXTS.listHint}
      </text>

      {loading && <SkeletonCards count={5} />}

      {!loading && versions !== null && versions.length === 0 && (
        <EmptyState
          icon="gitBranch"
          title={TEXTS.emptyTitle}
          hint={TEXTS.emptyHint}
          action={
            <Button variant="primary" icon="refresh" onClick={() => void loadVersions()} testId="version-empty-refresh">
              刷新
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
    </div>
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
          <text style={{ fontSize: 13, fontWeight: 600, fontFamily: t.font.mono, color: t.text.primary }}>
            {`v${entry.version}`}
          </text>
          <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>{date}</text>
        </div>
        <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
          {`${TEXTS.sourcePrefix} tag ${entry.tag.tag_name}`}
        </text>
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {current && (
          <div
            style={{
              display: 'flex',
              paddingLeft: 6,
              paddingRight: 6,
              paddingTop: 2,
              paddingBottom: 2,
              borderWidth: 1,
              borderColor: t.ember,
              borderRadius: 3,
            }}>
            <text style={{ fontSize: 11, fontFamily: t.font.mono, color: t.ember }}>
              {TEXTS.currentChip}
            </text>
          </div>
        )}
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
