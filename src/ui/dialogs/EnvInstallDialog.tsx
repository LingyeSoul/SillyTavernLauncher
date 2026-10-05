/**
 * 内置环境安装对话框（2026-10-05）：系统模式探测不到 Git/Node.js 时的
 * 一键下载安装到 env/（services/envInstaller.ts 的 UI 侧）。
 *
 * 三态：confirm（缺失清单 + 安装计划确认）→ installing（分组件进度行，
 * busy 期间 onClose 置空挡 Escape/关闭，同 InstallDialogs 范式）→
 * 成功即 toast + 自动切 env_mode='portable'（env/ 是便携布局，留在 system
 * 模式 which() 找不到新装的工具，装了等于白装）/ 失败态保留已成功项，
 * 「重试」只装剩余项（installEnvComponents 组件间独立，支持部分成功）。
 *
 * 安装链路在 Actions 组件内（ModalCloseContext 子树），收尾统一走
 * useModalClose 的 requestClose 播退场（Modal.tsx 头注释契约，勿直呼
 * closeTopDialog）；行状态提升到对话框本体供正文进度行渲染。
 *
 * GPUIX 约束：文案单模板字面量子节点；flex 行内可能变长的状态/错误文本
 * minWidth:0 收缩折行；进度行不超内容高度，无滚动需求（Modal 480 预算内）。
 */
import { useState } from 'react'
import {
  ENV_INSTALL_GIT_VERSION,
  ENV_INSTALL_NODE_VERSION,
  installEnvComponents,
  type EnvInstallComponent,
  type EnvInstallPhase,
  type EnvInstallProgress,
} from '../../services/envInstaller'
import { useSettings } from '../../stores/settings'
import { uiStateActions, useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal, useModalClose } from '../components/Modal'
import { ProgressBar } from '../components/ProgressBar'

const TEXTS = {
  title: '安装内置运行环境',
  leadMissing: '系统环境检查未通过，缺少以下组件：',
  leadPlan: '可下载安装到启动器内置环境（env/ 目录）：',
  planNote:
    '安装完成后将自动切换到「内置懒人包环境（env/）」；下载优先经镜像源加速，失败自动换源重试。',
  cancel: '取消',
  install: '下载并安装',
  installing: '安装中…',
  retry: '重试剩余项',
  retryAll: '重试',
  close: '关闭',
  failLead: '安装未完成：',
  failReasonPrefix: '失败原因：',
  gitName: 'Git',
  nodeName: 'Node.js',
  waitConfirm: '等待确认',
} as const

const PHASE_TEXTS: Record<EnvInstallPhase, (percent: number | null, host: string) => string> = {
  download: (percent, host) =>
    percent === null ? `下载中…（${host}）` : `下载中 ${String(percent)}%（${host}）`,
  verify: () => '校验 SHA256 完整性…',
  extract: () => '解压安装中…',
  check: () => '验证可执行文件…',
  done: () => '已安装',
}

type RowStatus = 'pending' | 'installing' | 'done' | 'failed'

interface RowState {
  status: RowStatus
  /** installing 期间的状态文案 */
  phaseText: string
  /** null = 不确定进度 */
  percent: number | null
  /** failed 时的错误详情 */
  error: string
}

type DialogMode = 'confirm' | 'installing' | 'failed'

const INITIAL_ROWS: Record<EnvInstallComponent, RowState> = {
  git: { status: 'pending', phaseText: '', percent: null, error: '' },
  node: { status: 'pending', phaseText: '', percent: null, error: '' },
}

/** Escape 结算专用：直呼真卸载（Modal onClose 结算契约，见 Modal.tsx 头注释） */
function closeTop(): void {
  useUiState.getState().closeTopDialog()
}

function componentName(c: EnvInstallComponent): string {
  return c === 'git' ? TEXTS.gitName : TEXTS.nodeName
}

function componentPlanText(c: EnvInstallComponent): string {
  return c === 'git'
    ? `• Git for Windows MinGit ${ENV_INSTALL_GIT_VERSION}（约 40 MB）`
    : `• Node.js v${ENV_INSTALL_NODE_VERSION} LTS（约 36 MB）`
}

export interface EnvInstallDialogProps {
  gitMissing: boolean
  gitMessage: string
  nodeMissing: boolean
  nodeMessage: string
}

/**
 * 动作区 + 安装链路（Provider 子树内取 useModalClose）：确认/重试同一条
 * runInstall；成功后 toast + 切 portable + requestClose 播退场收尾。
 */
function EnvInstallActions({
  mode,
  rows,
  setRows,
  setMode,
}: {
  mode: DialogMode
  rows: Record<EnvInstallComponent, RowState>
  setRows: (updater: (prev: Record<EnvInstallComponent, RowState>) => Record<EnvInstallComponent, RowState>) => void
  setMode: (mode: DialogMode) => void
}) {
  const requestClose = useModalClose()
  const installing = mode === 'installing'
  const retryTargets = (['git', 'node'] as const).filter((c) => rows[c].status === 'failed')

  const runInstall = (components: EnvInstallComponent[]): void => {
    if (components.length === 0) return
    setMode('installing')
    setRows((prev) => {
      const next = { ...prev }
      for (const c of components) {
        next[c] = { status: 'installing', phaseText: '等待开始…', percent: null, error: '' }
      }
      return next
    })
    void (async () => {
      const onProgress = (p: EnvInstallProgress): void => {
        // percent 已量化到整数（服务层 floor），重复值 set 同内容——天然节流
        setRows((prev) => {
          const row = prev[p.component]
          if (row.status !== 'installing') return prev
          return {
            ...prev,
            [p.component]: {
              ...row,
              phaseText: PHASE_TEXTS[p.phase](p.percent, p.detail ?? ''),
              percent: p.phase === 'download' ? p.percent : null,
            },
          }
        })
      }
      const result = await installEnvComponents(components, onProgress)
      if (result.ok) {
        uiStateActions.pushToast('success', result.message)
        // env/ 是便携布局：切到 portable 才会用上新装的工具（system 模式走 which()）
        useSettings.getState().update({ envMode: 'portable' })
        requestClose()
        return
      }
      uiStateActions.pushToast('error', result.message)
      setRows((prev) => {
        const next = { ...prev }
        for (const c of components) {
          const failure = result.failures.find((f) => f.component === c)
          next[c] = failure
            ? { status: 'failed', phaseText: '安装失败', percent: null, error: failure.message }
            : { status: 'done', phaseText: '已安装', percent: null, error: '' }
        }
        return next
      })
      setMode('failed')
    })()
  }

  return (
    <>
      <Button variant="quiet" disabled={installing} onClick={requestClose} testId="env-install-cancel">
        {mode === 'failed' ? TEXTS.close : TEXTS.cancel}
      </Button>
      {mode === 'failed' ? (
        <Button
          variant="primary"
          icon="download"
          disabled={retryTargets.length === 0}
          onClick={() => runInstall(retryTargets)}
          testId="env-install-retry">
          {retryTargets.length === 2 ? TEXTS.retryAll : TEXTS.retry}
        </Button>
      ) : (
        <Button
          variant="primary"
          icon="download"
          disabled={installing}
          onClick={() => {
            const targets = (['git', 'node'] as const).filter((c) => rows[c].status !== 'done')
            runInstall(targets)
          }}
          testId="env-install-confirm">
          {installing ? TEXTS.installing : TEXTS.install}
        </Button>
      )}
    </>
  )
}

export function EnvInstallDialog(props: EnvInstallDialogProps) {
  const t = useTheme()
  const initialComponents: EnvInstallComponent[] = [
    ...(props.gitMissing ? (['git'] as const) : []),
    ...(props.nodeMissing ? (['node'] as const) : []),
  ] as EnvInstallComponent[]

  const [mode, setMode] = useState<DialogMode>('confirm')
  const [rows, setRows] = useState<Record<EnvInstallComponent, RowState>>(INITIAL_ROWS)

  const labelStyle = {
    fontSize: 13,
    fontWeight: 600,
    color: t.text.primary,
    fontFamily: t.font.sans,
    flexShrink: 0,
    width: 64,
  }
  const bodyStyle = {
    fontSize: 14,
    color: t.text.primary,
    fontFamily: t.font.sans,
    lineHeight: 22,
  }
  const hintStyle = {
    fontSize: 12,
    color: t.text.muted,
    fontFamily: t.font.sans,
    lineHeight: 18,
  }

  return (
    <Modal
      open
      width={480}
      title={TEXTS.title}
      onClose={mode === 'installing' ? undefined : closeTop}
      actions={
        <EnvInstallActions mode={mode} rows={rows} setRows={setRows} setMode={setMode} />
      }>
      {mode === 'confirm' && (
        <>
          <text style={bodyStyle}>{TEXTS.leadMissing}</text>
          {props.gitMissing && <text style={bodyStyle}>{`• Git：${props.gitMessage}`}</text>}
          {props.nodeMissing && <text style={bodyStyle}>{`• Node.js：${props.nodeMessage}`}</text>}
          <div style={{ height: 10 }} />
          <text style={bodyStyle}>{TEXTS.leadPlan}</text>
          {initialComponents.map((c) => (
            <text key={c} style={bodyStyle}>
              {componentPlanText(c)}
            </text>
          ))}
          <div style={{ height: 10 }} />
          <text style={hintStyle}>{TEXTS.planNote}</text>
        </>
      )}

      {(mode === 'installing' || mode === 'failed') && (
        <>
          {mode === 'failed' && <text style={bodyStyle}>{TEXTS.failLead}</text>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {initialComponents.map((c) => {
              const row = rows[c]
              const statusColor =
                row.status === 'failed'
                  ? t.status.error
                  : row.status === 'done'
                    ? t.status.success
                    : t.text.secondary
              return (
                <div key={c} testId={`env-install-row-${c}`}>
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <text style={labelStyle}>{componentName(c)}</text>
                    <text
                      style={{
                        fontSize: 13,
                        color: statusColor,
                        fontFamily: t.font.sans,
                        flexGrow: 1,
                        minWidth: 0,
                        whiteSpace: 'normal',
                      }}>
                      {row.status === 'pending' ? TEXTS.waitConfirm : row.phaseText}
                    </text>
                  </div>
                  {row.status === 'installing' && (
                    <div style={{ marginTop: 5 }}>
                      <ProgressBar
                        value={row.percent ?? undefined}
                        testId={`env-install-progress-${c}`}
                      />
                    </div>
                  )}
                  {row.status === 'failed' && row.error.length > 0 && (
                    <text
                      style={{
                        fontSize: 12,
                        color: t.text.muted,
                        fontFamily: t.font.sans,
                        marginTop: 3,
                        whiteSpace: 'normal',
                      }}>
                      {`${TEXTS.failReasonPrefix}${row.error}`}
                    </text>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}
