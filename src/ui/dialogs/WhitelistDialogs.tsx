/**
 * IP / Host 白名单编辑对话框（设计 §4.7）：textarea mono 12 minRows 10 + 提示。
 * 保存回调语义 1:1 对齐 Flet edit_ip_whitelist / edit_host_whitelist
 * （unified 模式下双向同步；保存后提示"重启酒馆后生效"）。
 * DEVIATION: Flet 版 IP 对话框内的 6 个附加开关（过滤模式/转发头/私网保护组）
 *   按 §4.7 压缩规格未迁移——主开关仍在设置页，细化字段可后续按需恢复。
 * PrivateRangesDialog：ST 新增 privateAddressWhitelist（SSRF 防护）的放行网段
 *   编辑入口（Flet 版"私网保护组"的裁剪补偿）；格式与 ST 的 ip-matching 对齐，
 *   支持 CIDR 与通配符（如 192.168.1.0/24、192.168.1.*）。
 */
import { useState } from 'react'
import { getStConfig, useSettings } from '../../stores/settings'
import { uiStateActions, useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'
import { Textarea } from '../components/Textarea'

const TEXTS = {
  ipTitle: '编辑 IP 白名单',
  ipHint: '每行一个 IP 地址或网段',
  hostTitle: '编辑主机白名单',
  hostHint: '每行一个主机名',
  rangesTitle: '编辑私网放行网段',
  rangesHint:
    '每行一个 CIDR 或通配符网段（如 192.168.1.0/24、192.168.1.*、127.0.0.0/8）；酒馆连接不上本地/局域网后端时，将要访问的网段加入此处',
  save: '保存',
  cancel: '取消',
  ipSavedToast: (n: number, on: boolean) =>
    `网络白名单配置已更新，重启酒馆后生效：访问过滤${on ? '开启' : '关闭'}, IP数: ${n}`,
  hostSavedToast: (n: number, on: boolean, scan: boolean) =>
    `主机白名单配置已更新：${on ? '开启' : '关闭'}, 记录未受信任主机请求: ${scan ? '开启' : '关闭'}, 主机数: ${n}`,
  rangesSavedToast: (n: number, on: boolean) =>
    `私网放行网段已保存，重启酒馆后生效：过滤${on ? '开启' : '关闭'}, 网段数: ${n}`,
  rangesEmptyError: '私网请求过滤开启时至少保留一个放行网段（如 127.0.0.0/8），否则本地后端将全部被拦截',
  rangesSaveFail: '放行网段保存失败，请检查 SillyTavern/config.yaml 写入权限',
} as const

/** ← IpWhitelistDialog._parse_lines：按行拆分去重去空 */
function parseLines(value: string): string[] {
  return [...new Set(value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0))]
}

export function IpWhitelistDialog() {
  const t = useTheme()
  const st = getStConfig()
  const reload = useSettings((s) => s.reload)
  const [draft, setDraft] = useState(st.whitelistIps.join('\n'))

  const handleSave = (): void => {
    const ips = parseLines(draft)
    st.whitelistIps = ips
    if (st.unifiedWhitelist) {
      st.syncWhitelists('ip')
    } else {
      st.save()
    }
    uiStateActions.pushToast('success', TEXTS.ipSavedToast(ips.length, st.whitelistMode))
    reload()
    useUiState.getState().closeTopDialog()
  }

  return (
    <Modal
      open
      width={480}
      title={TEXTS.ipTitle}
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={
        <>
          <Button variant="quiet" onClick={() => useUiState.getState().closeTopDialog()} testId="ip-whitelist-cancel">
            {TEXTS.cancel}
          </Button>
          <Button variant="primary" onClick={handleSave} testId="ip-whitelist-save">
            {TEXTS.save}
          </Button>
        </>
      }>
      <Textarea value={draft} onChange={setDraft} minRows={10} testId="ip-whitelist-textarea" />
      <div style={{ height: 6 }} />
      <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
        {TEXTS.ipHint}
      </text>
    </Modal>
  )
}

export function HostWhitelistDialog() {
  const t = useTheme()
  const st = getStConfig()
  const reload = useSettings((s) => s.reload)
  const [draft, setDraft] = useState(st.hostWhitelistHosts.join('\n'))

  const handleSave = (): void => {
    const hosts = parseLines(draft)
    st.hostWhitelistHosts = hosts
    if (st.unifiedWhitelist) {
      st.syncWhitelists('host')
    } else {
      st.save()
    }
    uiStateActions.pushToast(
      'success',
      TEXTS.hostSavedToast(hosts.length, st.hostWhitelistEnabled, st.hostWhitelistScan),
    )
    reload()
    useUiState.getState().closeTopDialog()
  }

  return (
    <Modal
      open
      width={480}
      title={TEXTS.hostTitle}
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={
        <>
          <Button variant="quiet" onClick={() => useUiState.getState().closeTopDialog()} testId="host-whitelist-cancel">
            {TEXTS.cancel}
          </Button>
          <Button variant="primary" onClick={handleSave} testId="host-whitelist-save">
            {TEXTS.save}
          </Button>
        </>
      }>
      <Textarea value={draft} onChange={setDraft} minRows={10} testId="host-whitelist-textarea" />
      <div style={{ height: 6 }} />
      <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
        {TEXTS.hostHint}
      </text>
    </Modal>
  )
}

export function PrivateRangesDialog() {
  const t = useTheme()
  const st = getStConfig()
  const reload = useSettings((s) => s.reload)
  const [draft, setDraft] = useState(st.privateAddressAllowedRanges.join('\n'))

  const handleSave = (): void => {
    const ranges = parseLines(draft)
    // 过滤开启时清空网段 = 拦截一切私网出站（本地后端全断），属误操作，直接拦下
    if (st.privateAddressWhitelistEnabled && ranges.length === 0) {
      uiStateActions.pushToast('error', TEXTS.rangesEmptyError)
      return
    }
    st.privateAddressAllowedRanges = ranges
    if (st.save()) {
      uiStateActions.pushToast('success', TEXTS.rangesSavedToast(ranges.length, st.privateAddressWhitelistEnabled))
    } else {
      uiStateActions.pushToast('error', TEXTS.rangesSaveFail)
    }
    reload()
    useUiState.getState().closeTopDialog()
  }

  return (
    <Modal
      open
      width={480}
      title={TEXTS.rangesTitle}
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={
        <>
          <Button variant="quiet" onClick={() => useUiState.getState().closeTopDialog()} testId="private-ranges-cancel">
            {TEXTS.cancel}
          </Button>
          <Button variant="primary" onClick={handleSave} testId="private-ranges-save">
            {TEXTS.save}
          </Button>
        </>
      }>
      <Textarea value={draft} onChange={setDraft} minRows={10} testId="private-ranges-textarea" />
      <div style={{ height: 6 }} />
      <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
        {TEXTS.rangesHint}
      </text>
    </Modal>
  )
}
