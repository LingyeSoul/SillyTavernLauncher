/**
 * 同步视图（设计 §4.3，单滚动型）：服务端/客户端配置 + 发现列表 + 进度 + 日志。
 *
 * DEVIATION: 设计文档 §4.3 的"mini 日志卡 overflow scroll"与 GPUIX 嵌套滚动铁律冲突
 *   （本视图自身已在唯一滚动容器内），改为固定高度 120 + 50 行环形缓冲 + 截尾显示
 *   （overflow hidden，最新行始终可见）。铁律优先。
 * DEVIATION: Flet 版首启同步服务器的 30s 倒计时警告对话框已于 2026-09-20 迁移
 *   （ui/dialogs/SyncFirstRunDialog，经 uiState 对话框栈挂载）；视图内安全警示
 *   文案保留作为常驻补偿（旧版行为）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { DiscoveredServer } from '../../services/sync/manager'
import type { SyncLogLevel } from '../../services/sync/server'
import { getConfigStore } from '../../services/configStore'
import { getSyncManager, useSyncState, type SyncLogEntry } from '../../stores/syncState'
import { useUiState } from '../../stores/uiState'
import { getLocalIp } from '../../services/network'
import { layout } from '../../theme'
import { useTheme } from '../theme'
import { shouldShowFirstRunDialog } from '../dialogs/SyncFirstRunDialog'
import { Button } from '../components/Button'
import { Card, SectionTitle } from '../components/Card'
import { Chip } from '../components/Chip'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/EmptyState'
import { Input } from '../components/Input'
import { ProgressBar } from '../components/ProgressBar'
import { Select } from '../components/Select'
import { Switch } from '../components/Switch'

const TEXTS = {
  title: '数据同步',
  statusReady: '就绪',
  statusSyncing: '同步中...',
  statusServer: '服务器运行中',
  statusError: '错误',
  warning: '请仅在信任的网络上使用本功能！',
  serverSection: '服务器配置',
  serverSwitch: '启动同步服务',
  serverUrl: '服务器地址: 未启动',
  serverUrlPrefix: '服务器地址: ',
  portLabel: '服务端口',
  hostLabel: '监听地址 (仅局域网)',
  clientSection: '客户端配置',
  clientUrlLabel: '服务器地址',
  clientUrlHint: '例如: http://192.168.1.100:9999',
  methodLabel: '同步方法',
  backupSwitch: '备份现有数据',
  scan: '扫描服务器',
  startSync: '开始同步',
  stopSync: '停止同步',
  discoveredSection: '发现的服务器',
  useThis: '使用此服务器',
  authRequired: '需要从服务端复制带令牌的完整地址',
  noAuth: '服务器未启用访问认证',
  emptyDiscovered: '未发现服务器',
  emptyDiscoveredHint: '请确认目标设备已启动同步服务且在同一局域网内',
  syncingText: '正在同步数据...',
  logSection: '日志',
  urlMissing: '请输入服务器地址',
  syncDone: '数据同步完成!',
  syncFailed: '数据同步失败!',
} as const

const METHOD_ITEMS = [
  { value: 'auto', label: '自动 (优先ZIP)' },
  { value: 'zip', label: 'ZIP全量同步' },
  { value: 'incremental', label: '增量同步' },
]

function statusText(status: string): string {
  const map: Record<string, string> = {
    idle: TEXTS.statusReady,
    syncing: TEXTS.statusSyncing,
    server: TEXTS.statusServer,
    error: TEXTS.statusError,
  }
  return map[status] ?? status
}

export function SyncView() {
  const t = useTheme()
  // Bug#2：manager 模块级单例（视图卸载后服务器/同步任务不失联），日志缓冲在 syncState store
  const logs = useSyncState((s) => s.logs)

  const [status, setStatus] = useState<string>('idle')
  const [serverRunning, setServerRunning] = useState(false)
  const [serverUrlText, setServerUrlText] = useState<string>(TEXTS.serverUrl)
  const [port, setPort] = useState('9999')
  const [host, setHost] = useState('192.168.1.100')
  const [clientUrl, setClientUrl] = useState('http://192.168.1.100:9999')
  const [method, setMethod] = useState('auto')
  const [backup, setBackup] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [serverToggling, setServerToggling] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredServer[] | null>(null)

  const syncLog = useCallback((message: string, level: SyncLogLevel = 'info') => {
    useSyncState.getState().appendLog(message, level)
  }, [])

  const refreshStatus = useCallback(() => {
    const m = getSyncManager()
    setStatus(m.syncStatus)
    setServerRunning(m.isServerRunning)
    setServerUrlText(m.isServerRunning ? TEXTS.serverUrlPrefix : TEXTS.serverUrl)
    if (m.isServerRunning) {
      void m.getServerUrl().then((url) => {
        setServerUrlText(TEXTS.serverUrlPrefix + url)
      })
    }
  }, [])

  // 初始化：局域网 IP 作默认监听地址（← Flet _get_default_lan_ip）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const m = getSyncManager()
      await m.initialize()
      if (cancelled) return
      setPort(String(m.serverPort))
      refreshStatus()
      const ip = await getLocalIp()
      if (!cancelled && ip) setHost(m.serverHost || ip)
      else if (!cancelled && m.serverHost) setHost(m.serverHost)
    })().catch((err) => {
      syncLog(`同步功能初始化失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
    })
    return () => {
      cancelled = true
    }
  }, [refreshStatus, syncLog])

  // ← toggle_server 的启动分支（首启警告对话框确认后也走这里）
  const startServer = (): void => {
    const m = getSyncManager()
    setServerToggling(true)
    void (async () => {
      try {
        const portNum = /^\d+$/.test(port) ? Number(port) : 9999
        const ok = await m.startSyncServer({ port: portNum, host: host.trim() || undefined })
        if (!ok) syncLog('启动同步服务失败', 'error')
        // manager 可能把陈旧监听地址回退为当前局域网 IP（config 自愈），输入框同步刷新
        else setHost(m.serverHost)
      } catch (err) {
        syncLog(`启动同步服务时出错: ${err instanceof Error ? err.message : String(err)}`, 'error')
      } finally {
        setServerToggling(false)
        refreshStatus()
      }
    })()
  }

  // ← toggle_server 的停止分支
  const stopServer = (): void => {
    const m = getSyncManager()
    setServerToggling(true)
    void (async () => {
      try {
        const ok = await m.stopSyncServer()
        if (!ok) syncLog('停止同步服务失败', 'error')
      } catch (err) {
        syncLog(`停止同步服务时出错: ${err instanceof Error ? err.message : String(err)}`, 'error')
      } finally {
        setServerToggling(false)
        refreshStatus()
      }
    })()
  }

  // ← _on_server_toggle：开启且未展示过首启警告 → 推入 30s 倒计时对话框，
  // 用户确认关闭后才真正启动服务器（onConfirm=startServer，模态期间
  // port/host 不可编辑，闭包捕获值与确认时一致）；关闭/已提示过路径行为不变
  const toggleServer = (on: boolean): void => {
    if (on && shouldShowFirstRunDialog(getConfigStore())) {
      useUiState.getState().openDialog({ kind: 'syncFirstRun', onConfirm: startServer })
      return
    }
    if (on) startServer()
    else stopServer()
  }

  const scanServers = (): void => {
    const m = getSyncManager()
    setScanning(true)
    setDiscovered(null)
    void (async () => {
      try {
        const servers = await m.detectNetworkServers()
        setDiscovered(servers)
      } catch (err) {
        syncLog(`扫描服务器时出错: ${err instanceof Error ? err.message : String(err)}`, 'error')
        setDiscovered([])
      } finally {
        setScanning(false)
      }
    })()
  }

  const startSync = (): void => {
    const url = clientUrl.trim()
    if (!url) {
      syncLog(TEXTS.urlMissing, 'warning')
      return
    }
    const m = getSyncManager()
    setSyncing(true)
    setStatus('syncing')
    void (async () => {
      try {
        // 取消句柄由 manager 持有（Bug#2），视图卸载后 stopSync 仍可取消
        const ok = await m.syncFromServer(url, {
          method: method as 'auto' | 'zip' | 'incremental',
          backup,
        })
        syncLog(ok ? TEXTS.syncDone : TEXTS.syncFailed, ok ? 'success' : 'error')
      } catch (err) {
        syncLog(`同步过程中出错: ${err instanceof Error ? err.message : String(err)}`, 'error')
      } finally {
        setSyncing(false)
        refreshStatus()
      }
    })()
  }

  const stopSync = (): void => {
    getSyncManager().cancelActiveSync()
    syncLog('正在取消同步...', 'warning')
  }

  const logColor = (level: SyncLogLevel): string =>
    level === 'error' ? t.status.error
    : level === 'warning' ? t.status.warning
    : level === 'success' ? t.status.success
    : t.status.info

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
      {/* workspace-heading（PageHeader 收口）；安全提示降级为 caption 级说明——
          红字保留给真异常（减法：status.error 是异常色，非常驻装饰） */}
      <PageHeader title={TEXTS.title} subtitle={`状态: ${statusText(status)}`} />
      <text
        style={{
          fontSize: t.fs.caption,
          color: t.text.muted,
          fontFamily: t.font.sans,
          marginBottom: t.space.sectionGap,
        }}>
        {TEXTS.warning}
      </text>

      {/* 服务器配置 */}
      <Card>
        <SectionTitle title={TEXTS.serverSection} />
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Switch
            on={serverRunning}
            onChange={toggleServer}
            label={TEXTS.serverSwitch}
            disabled={serverToggling}
            testId="sync-server-switch"
          />
          <div style={{ flexGrow: 1, minWidth: 0 }} />
          <Input value={host} onChange={setHost} width={140} testId="sync-host" />
          <Input value={port} onChange={setPort} width={96} testId="sync-port" />
        </div>
        <div style={{ height: 8 }} />
        <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.mono }} testId="sync-server-url">
          {serverUrlText}
        </text>
      </Card>

      {/* 客户端配置 */}
      <Card>
        <SectionTitle title={TEXTS.clientSection} />
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <Input
              value={clientUrl}
              onChange={setClientUrl}
              placeholder={TEXTS.clientUrlHint}
              mono
              testId="sync-client-url"
            />
          </div>
          <Select items={METHOD_ITEMS} value={method} onValueChange={setMethod} width={160} testId="sync-method" />
        </div>
        <div style={{ height: 8 }} />
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Switch on={backup} onChange={setBackup} label={TEXTS.backupSwitch} testId="sync-backup" />
          <div style={{ flexGrow: 1, minWidth: 0 }} />
          <Button variant="quiet" icon="search" onClick={scanServers} disabled={scanning} testId="sync-scan">
            {scanning ? '扫描中...' : TEXTS.scan}
          </Button>
          {syncing ? (
            <Button variant="quietDanger" icon="stop" onClick={stopSync} testId="sync-stop">
              {TEXTS.stopSync}
            </Button>
          ) : (
            <Button variant="primary" icon="sync" onClick={startSync} testId="sync-start">
              {TEXTS.startSync}
            </Button>
          )}
        </div>
      </Card>

      {/* 发现的服务器 */}
      <div style={{ marginBottom: t.space.sectionGap }}>
        <SectionTitle title={TEXTS.discoveredSection} count={discovered?.length ?? undefined} />
        {discovered === null ? (
          <EmptyState
            icon="search"
            title={TEXTS.emptyDiscovered}
            hint={TEXTS.emptyDiscoveredHint}
            action={
              <Button variant="primary" icon="search" onClick={scanServers} disabled={scanning} testId="sync-scan-empty">
                {TEXTS.scan}
              </Button>
            }
          />
        ) : discovered.length === 0 ? (
          <EmptyState icon="search" title={TEXTS.emptyDiscovered} hint={TEXTS.emptyDiscoveredHint} />
        ) : (
          discovered.map((server, i) => (
            <div
              key={server.serverUrl}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                height: 48,
                paddingLeft: 12,
                paddingRight: 8,
                marginBottom: t.space.cardGap,
                backgroundColor: t.bg.surface,
                borderWidth: 1,
                borderColor: t.border.subtle,
                borderRadius: t.radius.md,
              }}>
              <Chip color={t.amber}>{`服务器 ${i + 1}`}</Chip>
              <text style={{ fontSize: t.fs.caption, fontFamily: t.font.mono, color: t.text.secondary, flexGrow: 1, minWidth: 0 }}>
                {server.serverUrl}
              </text>
              <text style={{ fontSize: t.fs.micro, color: t.text.muted, fontFamily: t.font.sans, flexShrink: 0 }}>
                {server.info?.auth_required ? TEXTS.authRequired : TEXTS.noAuth}
              </text>
              <Button
                variant="quiet"
                onClick={() => {
                  setClientUrl(server.serverUrl)
                  syncLog(`已选择服务器: ${server.serverUrl}`)
                }}
                testId={`sync-use-${i}`}
              >
                {TEXTS.useThis}
              </Button>
            </div>
          ))
        )}
      </div>

      {/* 同步进度（仅任务进行时渲染） */}
      {(syncing || status === 'syncing') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: t.space.sectionGap }}>
          <ProgressBar testId="sync-progress" />
          <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
            {TEXTS.syncingText}
          </text>
        </div>
      )}

      {/* 同步日志（50 行环形缓冲，固定高度截尾显示；嵌套滚动铁律见文件头 DEVIATION） */}
      <div>
        <SectionTitle title={TEXTS.logSection} />
        <div
          style={{
            height: 120,
            backgroundColor: t.bg.deep,
            borderWidth: 1,
            borderColor: t.border.subtle,
            borderRadius: t.radius.md,
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 10,
            paddingRight: 10,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}>
          {logs.length === 0 ? (
            <text style={{ fontSize: t.fs.caption, fontFamily: t.font.mono, color: t.text.disabled }}>—</text>
          ) : (
            // 7 行 × lineHeight 16 = 112 ≤ 容器 120（原 14px 行高裁掉下伸部约 4px）
            logs.slice(-7).map((entry) => (
              <text
                key={entry.id}
                style={{ fontSize: t.fs.caption, lineHeight: 16, fontFamily: t.font.mono, color: logColor(entry.level) }}>
                {entry.message}
              </text>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
