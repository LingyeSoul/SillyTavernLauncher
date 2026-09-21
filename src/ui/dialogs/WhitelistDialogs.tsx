/**
 * 网络白名单 / 主机白名单编辑对话框（设计 §4.7）。
 * IpWhitelistDialog 2026-09-20 迁移完成 Flet 版 ip_whitelist_dialog.py 的两节式布局：
 * 「访问来源」（过滤模式/转发头/IP 列表 + 添加当前网段）与「私有地址请求保护」
 * （SSRF 过滤/可信私网网段 + 信任当前网段/允许未解析主机/两类请求日志），
 * 6 开关 + 2 textarea + 重置/取消/保存，保存回调语义 1:1 对齐 Flet 版
 * core/event.py edit_ip_whitelist.on_save（unified 模式下双向同步；toast 汇报
 * 访问过滤/IP 数/私网保护/可信范围数；保存后提示"重启酒馆后生效"）。
 * 原 PrivateRangesDialog 的网段编辑能力已并入本对话框（含"过滤开启时网段不能
 * 清空"防误操作守卫，守卫值取草稿开关而非落盘值——开关与网段同框编辑后，
 * 本次打开过滤且清空网段同样必须拦下），独立组件已删除。
 * HostWhitelistDialog：主机白名单列表编辑，未改动。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { getStConfig, useSettings } from '../../stores/settings'
import { DEFAULT_PRIVATE_ADDRESS_RANGES, type StConfig } from '../../services/stConfig'
import { uiStateActions, useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal, useModalClose } from '../components/Modal'
import { SectionTitle } from '../components/Card'
import { SwitchRow } from '../components/Switch'
import { Textarea } from '../components/Textarea'

const TEXTS = {
  ipTitle: '网络白名单',
  sectionAccess: '访问来源',
  sectionPrivate: '私有地址请求保护',
  modeLabel: '启用 IP 白名单过滤',
  modeDesc: '启用后，只有白名单中的 IP 才能访问服务',
  forwardedLabel: '检查转发头中的白名单 IP',
  ipsLabel: '允许的 IP 地址列表',
  ipsHint: '每行一个 IP 地址或网段',
  ipsSupport: '支持 IPv4、IPv6、CIDR 和通配符网段',
  addSubnet: '添加当前网段',
  privateEnabledLabel: '启用私有地址请求过滤（SSRF 防护）',
  privateEnabledDesc: '阻止服务器请求未受信任的私有地址，重启酒馆后生效',
  rangesLabel: '可信私有地址范围',
  rangesHint: '每行一个 IP、CIDR 或通配符网段',
  rangesSupport: '酒馆连接不上本地/局域网后端时，将要访问的网段加入此处',
  trustSubnet: '信任当前网段',
  allowUnresolvedLabel: '允许无法解析的主机',
  allowUnresolvedDesc: '仅在确有需要时开启；无法解析的主机将绕过此项检查',
  logBlockedLabel: '记录被阻止的请求',
  logAllowedLabel: '记录已允许的请求',
  reset: '重置为默认值',
  subnetDetectFail: '无法检测当前网段（获取本地 IP 失败），请手动填写',
  hostTitle: '编辑主机白名单',
  hostHint: '每行一个主机名',
  save: '保存',
  cancel: '取消',
  // ← event.py edit_ip_whitelist.on_save 的 showMsg 文案（1:1）
  ipSavedToast: (n: number, on: boolean, privateOn: boolean, m: number) =>
    `网络白名单配置已更新，重启酒馆后生效：访问过滤${on ? '开启' : '关闭'}, IP数: ${n}; 私网保护${privateOn ? '开启' : '关闭'}, 可信范围数: ${m}`,
  hostSavedToast: (n: number, on: boolean, scan: boolean) =>
    `主机白名单配置已更新：${on ? '开启' : '关闭'}, 记录未受信任主机请求: ${scan ? '开启' : '关闭'}, 主机数: ${n}`,
  // ← PrivateRangesDialog 防误操作守卫文案（并入后保留）
  rangesEmptyError: '私网请求过滤开启时至少保留一个放行网段（如 127.0.0.0/8），否则本地后端将全部被拦截',
  // ← 旧 PrivateRangesDialog rangesSaveFail 的失败反馈语义（stConfig save 契约：失败必须可被调用方感知）
  ipSaveFail: '网络白名单保存失败，请检查 SillyTavern/config.yaml 写入权限',
  hostSaveFail: '主机白名单保存失败，请检查 SillyTavern/config.yaml 写入权限',
} as const

/** ← IpWhitelistDialog._parse_lines：按行拆分去重去空 */
export function parseLines(value: string): string[] {
  return [...new Set(value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0))]
}

/** 合并对话框的 8 字段草稿（← ip_whitelist_dialog.py 的 8 个控件值） */
export interface IpWhitelistDraft {
  mode: boolean
  forwarded: boolean
  ips: string
  privateEnabled: boolean
  allowUnresolved: boolean
  logBlocked: boolean
  logAllowed: boolean
  ranges: string
}

/** ← _reset_to_default 默认值：与 stConfig 各字段默认值一致
 *  （布尔/ips 为 stConfig 字段初始值的 UI 侧书写，锁定关系见 ipWhitelistDialog.test.ts；
 *  ranges 直取 stConfig 导出的 DEFAULT_PRIVATE_ADDRESS_RANGES，不复制魔数）。 */
export function defaultIpWhitelistDraft(): IpWhitelistDraft {
  return {
    mode: true,
    forwarded: true,
    ips: '::1\n127.0.0.1',
    privateEnabled: false,
    allowUnresolved: false,
    logBlocked: true,
    logAllowed: false,
    ranges: DEFAULT_PRIVATE_ADDRESS_RANGES.join('\n'),
  }
}

/** 打开对话框时从 StConfig 实例读当前值构造草稿（← show() 的控件初值装配） */
export function draftFromStConfig(st: StConfig): IpWhitelistDraft {
  return {
    mode: st.whitelistMode,
    forwarded: st.enableForwardedWhitelist,
    ips: st.whitelistIps.join('\n'),
    privateEnabled: st.privateAddressWhitelistEnabled,
    allowUnresolved: st.privateAddressAllowUnresolvedHosts,
    logBlocked: st.privateAddressLogBlocked,
    logAllowed: st.privateAddressLogAllowed,
    ranges: st.privateAddressAllowedRanges.join('\n'),
  }
}

/** ← _append_current_subnet：网段 insert 到头部去重；已存在时原样返回（不动用户排版） */
export function insertSubnetLine(value: string, subnet: string): string {
  const entries = parseLines(value)
  if (entries.includes(subnet)) return value
  return [subnet, ...entries].join('\n')
}

/** ← PrivateRangesDialog 防误操作守卫（纯函数，锁定关系见 ipWhitelistDialog.test.ts）：
 *  过滤开启时清空网段 = 拦截一切私网出站（本地后端全断）。守卫取草稿开关而非
 *  落盘值——开关与网段同框编辑后，本次打开过滤且清空网段同样必须拦下。 */
export function ipWhitelistDraftError(draft: IpWhitelistDraft): string | null {
  if (draft.privateEnabled && parseLines(draft.ranges).length === 0) {
    return TEXTS.rangesEmptyError
  }
  return null
}

/** IP 白名单动作区（Provider 子树内取 useModalClose，PR4）：取消/保存统一走
 *  requestClose 播退场；保存逻辑 ← _on_save → event.py on_save 1:1 随迁 */
function IpWhitelistActions({ draft, onReset }: { draft: IpWhitelistDraft; onReset: () => void }) {
  const requestClose = useModalClose()
  const st = getStConfig()
  const reload = useSettings((s) => s.reload)

  const handleSave = (): void => {
    const ips = parseLines(draft.ips)
    const ranges = parseLines(draft.ranges)
    // 守卫（← PrivateRangesDialog）：过滤开启时清空网段的误操作拦下（见 ipWhitelistDraftError）
    const guardError = ipWhitelistDraftError(draft)
    if (guardError !== null) {
      uiStateActions.pushToast('error', guardError)
      return
    }
    st.whitelistMode = draft.mode
    st.enableForwardedWhitelist = draft.forwarded
    st.whitelistIps = ips
    st.privateAddressWhitelistEnabled = draft.privateEnabled
    st.privateAddressAllowedRanges = ranges
    st.privateAddressAllowUnresolvedHosts = draft.allowUnresolved
    st.privateAddressLogBlocked = draft.logBlocked
    st.privateAddressLogAllowed = draft.logAllowed
    // 落盘结果必须可感知（← 旧 PrivateRangesDialog 失败分支）：失败 toast + 保留
    // 对话框供重试，不 reload/不关窗——成功路径才提示/刷新/关窗
    const saved = st.unifiedWhitelist ? st.syncWhitelists('ip') : st.save()
    if (!saved) {
      uiStateActions.pushToast('error', TEXTS.ipSaveFail)
      return
    }
    uiStateActions.pushToast('success', TEXTS.ipSavedToast(ips.length, draft.mode, draft.privateEnabled, ranges.length))
    reload()
    requestClose()
  }

  return (
    <>
      <Button variant="quiet" icon="refresh" onClick={onReset} testId="ip-whitelist-reset">
        {TEXTS.reset}
      </Button>
      <Button variant="quiet" onClick={requestClose} testId="ip-whitelist-cancel">
        {TEXTS.cancel}
      </Button>
      <Button variant="primary" icon="save" onClick={handleSave} testId="ip-whitelist-save">
        {TEXTS.save}
      </Button>
    </>
  )
}

export function IpWhitelistDialog() {
  const t = useTheme()
  const st = getStConfig()
  const [draft, setDraft] = useState<IpWhitelistDraft>(() => draftFromStConfig(st))

  const patch = (partial: Partial<IpWhitelistDraft>): void => {
    setDraft((d) => ({ ...d, ...partial }))
  }

  /** ← _append_current_subnet：智能检测当前网段，null 时提示无法检测 */
  const handleAddSubnet = (field: 'ips' | 'ranges'): void => {
    void (async () => {
      const subnet = await st.getCurrentSubnet()
      if (!subnet) {
        uiStateActions.pushToast('warning', TEXTS.subnetDetectFail)
        return
      }
      // 函数式更新：getCurrentSubnet await 期间用户仍在编辑，闭包里的 draft 已过期
      setDraft((d) => {
        const next = insertSubnetLine(d[field], subnet)
        return field === 'ips' ? { ...d, ips: next } : { ...d, ranges: next }
      })
    })()
  }

  /** 开关行：标签左（可选描述，警示描述转 warning 色）+ Switch 右（共享 SwitchRow，紧凑档） */
  const renderSwitchRow = (
    key: string,
    label: string,
    on: boolean,
    onChange: (v: boolean) => void,
    desc?: string,
    descWarning = false,
  ): ReactElement => (
    <SwitchRow
      key={key}
      label={label}
      desc={desc}
      descWarning={descWarning}
      on={on}
      onChange={onChange}
      testId={`ip-whitelist-${key}`}
      compact
    />
  )

  /** textarea 块：标题行（label + 网段按钮）+ 多行输入 + 支持格式说明 */
  const renderTextareaBlock = (
    key: 'ips' | 'ranges',
    label: string,
    hint: string,
    support: string,
    addLabel: string,
  ): ReactElement => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text
          style={{
            fontSize: 13,
            color: t.text.primary,
            fontFamily: t.font.sans,
            flexGrow: 1,
          }}>
          {label}
        </text>
        <Button variant="quiet" onClick={() => handleAddSubnet(key)} testId={`ip-whitelist-add-${key}`}>
          {addLabel}
        </Button>
      </div>
      <Textarea
        value={draft[key]}
        onChange={(v) => patch(key === 'ips' ? { ips: v } : { ranges: v })}
        placeholder={hint}
        minRows={4}
        maxRows={8}
        testId={`ip-whitelist-${key}-textarea`}
      />
      <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
        {support}
      </text>
    </div>
  )

  return (
    <Modal
      open
      width={600}
      title={TEXTS.ipTitle}
      // 结算回调：退场播完后由 Modal 调用，直呼 closeTopDialog 真卸载（见 Modal.tsx 头注释）
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={
        <IpWhitelistActions
          draft={draft}
          onReset={() => setDraft(defaultIpWhitelistDraft())}
        />
      }>
      {/* 单一根 div + 内部滚动（模态浮层内合法，同 EulaDialog 正文模式）；
          Modal 面板 maxHeight 480，扣除标题/动作条/内边距后内容区限高 330 */}
      <div
        style={{
          maxHeight: 330,
          overflow: 'scroll',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
        {/* ===== 访问来源（← Flet「访问来源」节）===== */}
        <SectionTitle title={TEXTS.sectionAccess} style={{ marginBottom: 0 }} />
        {renderSwitchRow('mode', TEXTS.modeLabel, draft.mode, (v) => patch({ mode: v }), TEXTS.modeDesc)}
        {renderSwitchRow('forwarded', TEXTS.forwardedLabel, draft.forwarded, (v) => patch({ forwarded: v }))}
        {renderTextareaBlock('ips', TEXTS.ipsLabel, TEXTS.ipsHint, TEXTS.ipsSupport, TEXTS.addSubnet)}
        <div style={{ height: 1, backgroundColor: t.border.subtle, marginTop: 4, marginBottom: 4 }} />
        {/* ===== 私有地址请求保护（← Flet「私有地址请求保护」节）===== */}
        <SectionTitle title={TEXTS.sectionPrivate} style={{ marginBottom: 0 }} />
        {renderSwitchRow(
          'private-enabled',
          TEXTS.privateEnabledLabel,
          draft.privateEnabled,
          (v) => patch({ privateEnabled: v }),
          TEXTS.privateEnabledDesc,
        )}
        {renderTextareaBlock('ranges', TEXTS.rangesLabel, TEXTS.rangesHint, TEXTS.rangesSupport, TEXTS.trustSubnet)}
        {renderSwitchRow(
          'allow-unresolved',
          TEXTS.allowUnresolvedLabel,
          draft.allowUnresolved,
          (v) => patch({ allowUnresolved: v }),
          TEXTS.allowUnresolvedDesc,
          true,
        )}
        {renderSwitchRow('log-blocked', TEXTS.logBlockedLabel, draft.logBlocked, (v) => patch({ logBlocked: v }))}
        {renderSwitchRow('log-allowed', TEXTS.logAllowedLabel, draft.logAllowed, (v) => patch({ logAllowed: v }))}
      </div>
    </Modal>
  )
}

/** 主机白名单动作区（Provider 子树内取 useModalClose，PR4）：取消/保存统一播退场 */
function HostWhitelistActions({ draft }: { draft: string }) {
  const requestClose = useModalClose()
  const st = getStConfig()
  const reload = useSettings((s) => s.reload)

  const handleSave = (): void => {
    const hosts = parseLines(draft)
    st.hostWhitelistHosts = hosts
    // 落盘结果必须可感知：失败 toast + 保留对话框供重试（同 IpWhitelistDialog）
    const saved = st.unifiedWhitelist ? st.syncWhitelists('host') : st.save()
    if (!saved) {
      uiStateActions.pushToast('error', TEXTS.hostSaveFail)
      return
    }
    uiStateActions.pushToast(
      'success',
      TEXTS.hostSavedToast(hosts.length, st.hostWhitelistEnabled, st.hostWhitelistScan),
    )
    reload()
    requestClose()
  }

  return (
    <>
      <Button variant="quiet" onClick={requestClose} testId="host-whitelist-cancel">
        {TEXTS.cancel}
      </Button>
      <Button variant="primary" onClick={handleSave} testId="host-whitelist-save">
        {TEXTS.save}
      </Button>
    </>
  )
}

export function HostWhitelistDialog() {
  const t = useTheme()
  const st = getStConfig()
  const [draft, setDraft] = useState(st.hostWhitelistHosts.join('\n'))

  return (
    <Modal
      open
      width={480}
      title={TEXTS.hostTitle}
      // 结算回调：退场播完后由 Modal 调用，直呼 closeTopDialog 真卸载（见 Modal.tsx 头注释）
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={<HostWhitelistActions draft={draft} />}>
      <Textarea value={draft} onChange={setDraft} minRows={10} testId="host-whitelist-textarea" />
      <div style={{ height: 6 }} />
      <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
        {TEXTS.hostHint}
      </text>
    </Modal>
  )
}
