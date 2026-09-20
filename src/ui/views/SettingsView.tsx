/**
 * 设置视图（设计 §4.5 单滚动长表单 → 2026-09-20 改分 tab）：
 * DEVIATION: 设计文档 §4.5 曾声明"6 section 规模下单滚动（折叠面板负收益）"；
 * 现按用户要求分三个 tab，tab 内仍为 section 标题 + 列布局，单 tab 长度可控。
 * 布局为"固定头 + 内容滚动"自管形态（AppShell 对 settings 不再包外层滚动容器）：
 * 标题 + tab 栏固定不动，仅 tab 内容区 overflow:scroll（有界高度，切 tab 按 key
 * 重挂回到顶部）。tab 分组按"配置写到哪"切分：
 * - 环境：Git/Node 运行环境切换 + GitHub 镜像 + 环境工具（use_sys_env 与体检按钮联动，
 *   必须同页；镜像与 patchgit 同属 gitconfig 镜像链路，2026-09-20 自启动器页移入）
 * - 酒馆设置：写 SillyTavern config.yaml 与启动命令的项（启动参数/网络/酒馆更新）
 * - 启动器设置：启动器自身行为与外观（更新检查/自启/动效/终端字体）
 * tray 开关按 D1 移除；autostart 描述改为 D1 新语义。
 * 开关行：高 40（有描述 48），标签 13/500 + 描述 12px muted。
 * 语义 1:1 对齐 Flet 版 handler（listen/hostWhitelist/unified 白名单联动、端口校验、参数校验）。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { dirname, join } from 'node:path'
import { getConfigStore } from '../../services/configStore'
import { checkEnv, resolvePortableEnv, probeSystemGit, probeSystemNode } from '../../services/env'
import { validateCustomArgs } from '../../services/processManager'
import { launchCommandLine } from '../../services/platform'
import { getStConfig, useSettings, TERMINAL_FONT_SIZE_PRESETS, validateTerminalFontFamily } from '../../stores/settings'
import { DEFAULT_PRIVATE_ADDRESS_RANGES } from '../../services/stConfig'
import { useTerminalLogs } from '../../stores/terminalLogs'
import { uiStateActions } from '../../stores/uiState'
import { useThemeContext } from '../theme'
import { layout, THEME_ACCENTS, type ThemeAccentId } from '../../theme'
import { Button } from '../components/Button'
import { Card, SectionTitle } from '../components/Card'
import { Input } from '../components/Input'
import { PageHeader } from '../components/PageHeader'
import { Select } from '../components/Select'
import { SwitchRow } from '../components/Switch'

type SettingsTabId = 'env' | 'st' | 'launcher'

const TEXTS = {
  title: '设置',
  subtitle: '启动器与 SillyTavern 配置',
  // 分 tab
  tabEnv: '环境',
  tabSt: '酒馆设置',
  tabLauncher: '启动器设置',
  // 环境页
  sectionEnvSwitch: '运行环境',
  useSysEnv: '使用系统环境',
  useSysEnvDesc: '懒人包请勿修改，修改后重启生效 | 使用系统已安装的 Git 与 Node.js',
  patchgit: '启用修改Git配置文件',
  patchgitDesc: '开启后修改系统环境的Git配置文件（镜像源改写）',
  mirrorLabel: 'GitHub 镜像',
  mirrorHint: '当不使用官方源时，将使用镜像源加速下载',
  sectionTools: '环境工具',
  checkEnv: '检查内置环境',
  startCmd: '启动命令行',
  // 酒馆设置页
  sectionLaunchArgs: '启动参数',
  useOptimizeArgs: '使用优化参数',
  useOptimizeArgsDesc: '开启后将在启动命令中添加 --max-old-space-size=4096 参数（在自定义启动参数前）',
  customArgsLabel: '自定义启动参数',
  customArgsHint: '在此输入自定义启动参数，将添加到启动命令中，如果你不清楚，请留空！',
  customArgsDesc: '自定义启动参数将添加到启动命令末尾',
  save: '保存',
  sectionNetwork: '网络',
  listen: '启用局域网访问',
  listenDesc: '开启后允许局域网设备访问，并自动启用私有地址请求保护',
  editIpWhitelist: '编辑网络白名单',
  privateFilter: '私网请求过滤 (SSRF 防护)',
  privateFilterDesc: '阻止酒馆向局域网/内网地址发起请求，防范 SSRF 攻击；开启局域网访问时建议保持开启',
  editPrivateRanges: '编辑放行网段',
  privateFilterOn: '私网请求过滤已开启，重启酒馆后生效',
  privateFilterOff: '私网请求过滤已关闭，重启酒馆后生效',
  privateFilterFail: '私网请求过滤设置失败，请检查 SillyTavern/config.yaml 写入权限',
  autoProxy: '自动设置请求代理',
  autoProxyDesc: '开启后酒馆的请求会走启动器自动识别的系统代理',
  portLabel: '监听端口',
  portHint: '默认端口: 8000',
  portDesc: '监听端口一般情况下不需要修改，请勿乱动',
  proxyUrlLabel: '代理URL',
  proxyUrlHint: '有效的代理URL，支持http, https, socks, socks5, socks4, pac',
  hostWhitelist: '启用主机白名单',
  hostWhitelistDesc: '启用主机白名单后，仅允许白名单中的主机访问 SillyTavern。建议开启以增强安全性',
  editHostWhitelist: '编辑白名单',
  unifiedWhitelist: '使用同一白名单',
  unifiedWhitelistDesc: '开启后，IP 白名单和主机白名单将使用相同内容，修改其中一个会自动同步到另一个',
  // 更新（酒馆 tab：酒馆更新检查；启动器 tab：启动器更新检查）
  sectionUpdate: '更新',
  stcheckupdate: '自动检查酒馆更新',
  stcheckupdateDesc: '开启后在每次启动酒馆时先进行更新操作再启动酒馆',
  // 启动器设置页
  checkupdate: '自动检查启动器更新',
  checkupdateDesc: '开启后在每次启动启动器时会自动检查更新并提示(启动器并不会自动安装更新，请手动下载并更新)',
  sectionLauncher: '启动器',
  autostart: '启用自动启动',
  autostartDesc: '启动启动器后自动启动酒馆（主窗口正常显示）',
  reduceMotion: '减少动效',
  reduceMotionDesc: '关闭界面过渡动画与状态动效（性能受限设备建议开启）',
  sectionAppearance: '外观',
  accentLabel: '主题色',
  accentHintPrefix: '当前',
  sectionTerminal: '终端',
  terminalFontSizeLabel: '终端字体大小',
  terminalFontSizeHint: '调整终端日志文本大小，立即生效',
  terminalFontFamilyLabel: '终端字体',
  terminalFontFamilyHint: '终端日志使用的等宽字体；未安装的字体将回退系统默认，含中文的日志建议选择带中文字形的字体（如更纱黑体）',
  terminalFontCustomLabel: '自定义字体名',
  terminalFontCustomHint: '输入系统已安装的字体名称，如 JetBrains Mono',
  terminalFontCustomDesc: '保存后立即生效；字体名需与系统安装名称完全一致',
  terminalPreviewLabel: '预览',
  fontErrorTitle: '字体设置失败',
  // 消息
  portErrorTitle: '端口错误',
  portRangeError: '端口号必须在1-65535之间',
  portInvalidError: '请输入有效的端口号',
  argsErrorTitle: '参数验证失败',
  whitelistCreateFailTitle: '白名单创建失败',
  whitelistCreateFailMsg: '无法创建白名单文件，请检查日志',
  savedToast: '配置文件已保存',
  hostWhitelistOn: '主机白名单已开启',
  hostWhitelistOff: '主机白名单已关闭',
  unifiedOn: '已启用统一白名单，IP 白名单已同步到主机白名单',
  unifiedOff: '已关闭统一白名单',
  cmdStarted: '命令行窗口已启动',
  cmdStartFailTitle: '启动失败',
  cmdStartFailMsg: '启动命令行失败',
} as const

/** tab 顺序即默认关注顺序：环境 → 酒馆 → 启动器（默认激活第一项） */
const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: 'env', label: TEXTS.tabEnv },
  { id: 'st', label: TEXTS.tabSt },
  { id: 'launcher', label: TEXTS.tabLauncher },
]

const MIRROR_ITEMS = [
  { value: 'github', label: '官方源 (github.com)' },
  { value: 'gh-proxy.org', label: '镜像站点 (gh-proxy.org)' },
  { value: 'gh.llkk.cc', label: '镜像站点 (gh.llkk.cc)' },
]

/** 终端字体下拉精选（value 即写入 config 的字体族名；'' = 跟随主题默认 Consolas）。
 *  自定义名不在列表时 Select 触发器直接显示原始字符串（原语 labels.get 兜底）。 */
const TERMINAL_FONT_ITEMS = [
  { value: '', label: '默认 (Consolas)' },
  { value: 'Cascadia Mono', label: 'Cascadia Mono（Windows 11 内置）' },
  { value: 'Cascadia Code', label: 'Cascadia Code（Windows 11 内置）' },
  { value: 'Courier New', label: 'Courier New（Windows 经典）' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono（需自行安装）' },
  { value: 'Fira Code', label: 'Fira Code（需自行安装）' },
  { value: 'Sarasa Mono SC', label: '更纱黑体 Sarasa Mono SC（中文友好，需自行安装）' },
]

const TERMINAL_FONT_SIZE_ITEMS = TERMINAL_FONT_SIZE_PRESETS.map((n) => ({
  value: String(n),
  label: `${n} px`,
}))

/** 预览样张：ASCII + 中文 + 符号各占一角，验证字体回退与字号观感 */
const TERMINAL_FONT_PREVIEW_TEXT = 'Aa01 中文示例 [OK] SillyTavern ✓'

export function SettingsView() {
  const { t, mode, accent, setAccent, setMotionEnabled, motionEnabled } = useThemeContext()
  const settings = useSettings()
  const [activeTab, setActiveTab] = useState<SettingsTabId>('env')
  const [portDraft, setPortDraft] = useState(String(settings.stPort))
  const [proxyDraft, setProxyDraft] = useState(settings.proxyUrl)
  const [argsDraft, setArgsDraft] = useState(settings.customArgs)
  const [fontDraft, setFontDraft] = useState(settings.terminalFontFamily)

  const st = getStConfig()

  /** 开关行：高 40（无描述）/48（有描述），标签左 Switch 右（共享 SwitchRow，常规档） */
  const switchRow = (
    key: string,
    label: string,
    desc: string | undefined,
    on: boolean,
    onChange: (v: boolean) => void,
  ): ReactElement => (
    <SwitchRow key={key} label={label} desc={desc} on={on} onChange={onChange} testId={`setting-${key}`} />
  )

  /** ← listen_changed：开启时创建白名单，失败回滚 + 错误对话框 */
  const handleListen = (v: boolean): void => {
    st.listen = v
    if (v) {
      void st.createWhitelist().then((ok) => {
        if (!ok) {
          st.listen = false
          uiStateActions.openDialog({
            kind: 'error',
            title: TEXTS.whitelistCreateFailTitle,
            message: TEXTS.whitelistCreateFailMsg,
          })
          settings.reload()
          return
        }
        st.save()
        uiStateActions.pushToast('success', TEXTS.savedToast)
        settings.reload()
      })
      return
    }
    st.save()
    uiStateActions.pushToast('success', TEXTS.savedToast)
    settings.reload()
  }

  /** 私网请求过滤开关：开启时补回环放行段（对齐 createWhitelist 最小权限默认），失败不谎报 */
  const handlePrivateFilter = (v: boolean): void => {
    st.privateAddressWhitelistEnabled = v
    if (v) st.ensureLoopbackRanges()
    if (st.save()) {
      uiStateActions.pushToast('success', v ? TEXTS.privateFilterOn : TEXTS.privateFilterOff)
    } else {
      uiStateActions.pushToast('error', TEXTS.privateFilterFail)
    }
    settings.reload()
  }

  /** ← save_port：1-65535 校验 */
  const handleSavePort = (): void => {
    const portNum = Number(portDraft)
    if (!Number.isFinite(portNum) || !/^\d+$/.test(portDraft)) {
      uiStateActions.openDialog({ kind: 'error', title: TEXTS.portErrorTitle, message: TEXTS.portInvalidError })
      return
    }
    if (portNum < 1 || portNum > 65535) {
      uiStateActions.openDialog({ kind: 'error', title: TEXTS.portErrorTitle, message: TEXTS.portRangeError })
      return
    }
    settings.saveStPort(portNum)
  }

  /** ← save_custom_args：先安全校验再保存 */
  const handleSaveArgs = (): void => {
    const validation = validateCustomArgs(argsDraft)
    if (!validation.ok) {
      uiStateActions.openDialog({ kind: 'error', title: TEXTS.argsErrorTitle, message: validation.message })
      return
    }
    settings.saveCustomArgs(argsDraft)
  }

  /** 自定义终端字体名：先校验（非空/长度）再走 update 落盘 */
  const handleSaveFontFamily = (): void => {
    const validation = validateTerminalFontFamily(fontDraft)
    if (!validation.ok) {
      uiStateActions.openDialog({ kind: 'error', title: TEXTS.fontErrorTitle, message: validation.message })
      return
    }
    settings.update({ terminalFontFamily: validation.value })
    setFontDraft(validation.value)
  }

  /** ← in_env_check / sys_env_check：内置环境体检；use_sys_env 开启时改走系统探测 */
  const handleCheckEnv = (): void => {
    const useSysEnv = getConfigStore().get<boolean>('use_sys_env', false)
    if (useSysEnv) {
      const git = probeSystemGit()
      const node = probeSystemNode()
      if (git.ok && node.ok) {
        uiStateActions.pushToast('success', `系统环境检查通过 Git：${git.gitDir} NodeJS：${node.nodeDir}`)
      } else {
        const missing: string[] = []
        if (!git.ok) missing.push(`Git（${git.message}）`)
        if (!node.ok) missing.push(`Node.js 18+（${node.message}）`)
        uiStateActions.pushToast('error', `系统环境检查未通过: ${missing.join(', ')}`)
      }
      return
    }
    const paths = resolvePortableEnv(join(process.cwd(), 'env'))
    const result = checkEnv(paths)
    if (result === true) {
      uiStateActions.pushToast('success', `环境检查通过 Git：${paths.gitExe} NodeJS：${paths.nodeExe}`)
    } else {
      uiStateActions.pushToast('error', result)
    }
  }

  /** ← start_cmd：启动带便携 env PATH 的命令行 */
  const handleStartCmd = (): void => {
    const config = getConfigStore()
    const prependDirs: string[] = []
    if (!config.get<boolean>('use_sys_env', false)) {
      const paths = resolvePortableEnv(join(process.cwd(), 'env'))
      prependDirs.push(dirname(paths.nodeExe), paths.gitDir)
    } else {
      const git = probeSystemGit()
      const node = probeSystemNode()
      if (git.gitDir) prependDirs.push(git.gitDir)
      if (node.nodeDir) prependDirs.push(node.nodeDir)
    }
    const ok = launchCommandLine(prependDirs)
    if (ok) {
      useTerminalLogs.getState().appendLine(TEXTS.cmdStarted)
      uiStateActions.pushToast('success', TEXTS.cmdStarted)
    } else {
      useTerminalLogs.getState().appendLine(`${TEXTS.cmdStartFailMsg}`)
      uiStateActions.openDialog({ kind: 'error', title: TEXTS.cmdStartFailTitle, message: TEXTS.cmdStartFailMsg })
    }
  }

  /** tab 项：激活 = ember 下划线（绝对定位压在 tab 栏 1px 分隔线上）+ 600 字重，
   *  未激活 hover 即时切 bg.hover（NavItem 同款降级） */
  const tabItem = (tab: { id: SettingsTabId; label: string }): ReactElement => {
    const active = activeTab === tab.id
    return (
      <div
        key={tab.id}
        onClick={() => setActiveTab(tab.id)}
        role="tab"
        aria-selected={active}
        testId={`settings-tab-${tab.id}`}
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
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
      }}>
      {/* ============ 固定区：workspace-heading + tab 栏（不随内容滚动）============ */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          paddingTop: layout.padFormY,
          paddingLeft: layout.padFormX,
          paddingRight: layout.padFormX,
        }}>
        <PageHeader title={TEXTS.title} subtitle={TEXTS.subtitle} />

        {/* tab 栏：三项 + 底部 1px 分隔线（激活下划线压线） */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
            {SETTINGS_TABS.map(tabItem)}
          </div>
          <div style={{ height: 1, backgroundColor: t.border.subtle }} />
        </div>
      </div>

      {/* ============ 滚动区：仅 tab 内容（key 按 tab 重挂 → 切 tab 回到顶部，
          也避免切到更短 tab 后残留越界滚动偏移）============ */}
      <div
        key={activeTab}
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minHeight: 0,
          overflow: 'scroll',
          paddingLeft: layout.padFormX,
          paddingRight: layout.padFormX,
          paddingTop: layout.padFormY,
          paddingBottom: layout.padFormY,
        }}>

      {/* ==================== 环境 tab（默认）==================== */}
      {activeTab === 'env' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Card>
            <SectionTitle title={TEXTS.sectionEnvSwitch} />
            {switchRow('use_sys_env', TEXTS.useSysEnv, TEXTS.useSysEnvDesc, settings.useSysEnv, (v) => settings.update({ useSysEnv: v }))}
            {switchRow('patchgit', TEXTS.patchgit, TEXTS.patchgitDesc, settings.patchgit, (v) => settings.update({ patchgit: v }))}
            {/* 镜像行紧随 patchgit：两者同属 gitconfig 镜像链路（2026-09-20 自启动器页移入） */}
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans, flexShrink: 0 }}>
                {TEXTS.mirrorLabel}
              </text>
              <Select
                items={MIRROR_ITEMS}
                value={settings.mirror}
                onValueChange={(v) => void settings.setMirror(v)}
                width={200}
                testId="setting-mirror"
              />
            </div>
            <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans, marginTop: 4 }}>
              {TEXTS.mirrorHint}
            </text>
          </Card>
          <Card>
            <SectionTitle title={TEXTS.sectionTools} />
            <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
              <Button variant="default" icon="settings" onClick={handleCheckEnv} testId="setting-check-env">
                {envCheckLabel(getConfigStore().get<boolean>('use_sys_env', false))}
              </Button>
              <Button variant="default" icon="terminal" onClick={handleStartCmd} testId="setting-start-cmd">
                {TEXTS.startCmd}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* ==================== 酒馆设置 tab ==================== */}
      {activeTab === 'st' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* 启动参数 */}
          <Card>
            <SectionTitle title={TEXTS.sectionLaunchArgs} />
            {switchRow('use_optimize_args', TEXTS.useOptimizeArgs, TEXTS.useOptimizeArgsDesc, settings.useOptimizeArgs, (v) => settings.update({ useOptimizeArgs: v }))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans }}>
                {TEXTS.customArgsLabel}
              </text>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <Input
                    value={argsDraft}
                    onChange={setArgsDraft}
                    placeholder={TEXTS.customArgsHint}
                    mono
                    testId="setting-custom-args"
                  />
                </div>
                <Button variant="primary" icon="save" onClick={handleSaveArgs} width={96} testId="setting-save-args">
                  {TEXTS.save}
                </Button>
              </div>
              <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
                {TEXTS.customArgsDesc}
              </text>
            </div>
          </Card>

          {/* 网络 */}
          <Card>
            <SectionTitle title={TEXTS.sectionNetwork} />
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 12 }}>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                {switchRow('listen', TEXTS.listen, TEXTS.listenDesc, settings.listen, handleListen)}
              </div>
              <Button variant="quiet" icon="edit" onClick={() => uiStateActions.openDialog({ kind: 'ipWhitelist' })} testId="setting-edit-ip-whitelist">
                {TEXTS.editIpWhitelist}
              </Button>
            </div>
            {/* 私网请求过滤：listen 的自动联动项（存量配置由启动自愈兜底），行形态与 listen 一致 */}
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 12 }}>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                {switchRow('private_filter', TEXTS.privateFilter, TEXTS.privateFilterDesc, settings.privateAddressWhitelistEnabled, handlePrivateFilter)}
              </div>
              {/* 网段编辑已并入网络白名单合并对话框（2026-09-20），入口直达同一对话框 */}
              <Button variant="quiet" icon="edit" onClick={() => uiStateActions.openDialog({ kind: 'ipWhitelist' })} testId="setting-edit-private-ranges">
                {TEXTS.editPrivateRanges}
              </Button>
            </div>
            {switchRow('auto_proxy', TEXTS.autoProxy, TEXTS.autoProxyDesc, settings.autoProxy, (v) => settings.update({ autoProxy: v }))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Input value={portDraft} onChange={setPortDraft} placeholder={TEXTS.portHint} width={96} testId="setting-port" />
                <Button variant="primary" icon="save" onClick={handleSavePort} width={96} testId="setting-save-port">
                  {TEXTS.save}
                </Button>
              </div>
              <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
                {TEXTS.portDesc}
              </text>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <Input
                    value={proxyDraft}
                    onChange={setProxyDraft}
                    placeholder={TEXTS.proxyUrlHint}
                    mono
                    testId="setting-proxy-url"
                  />
                </div>
                <Button
                  variant="primary"
                  icon="save"
                  onClick={() => settings.saveProxyUrl(proxyDraft)}
                  width={96}
                  testId="setting-save-proxy"
                >
                  {TEXTS.save}
                </Button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 12 }}>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                {switchRow('host_whitelist', TEXTS.hostWhitelist, TEXTS.hostWhitelistDesc, settings.hostWhitelistEnabled, (v) => {
                  st.hostWhitelistEnabled = v
                  st.save()
                  uiStateActions.pushToast('success', v ? TEXTS.hostWhitelistOn : TEXTS.hostWhitelistOff)
                  settings.reload()
                })}
              </div>
              <Button variant="quiet" icon="edit" onClick={() => uiStateActions.openDialog({ kind: 'hostWhitelist' })} testId="setting-edit-host-whitelist">
                {TEXTS.editHostWhitelist}
              </Button>
            </div>
            {switchRow('unified_whitelist', TEXTS.unifiedWhitelist, TEXTS.unifiedWhitelistDesc, settings.unifiedWhitelist, (v) => {
              st.unifiedWhitelist = v
              if (v) {
                st.syncWhitelists('ip')
                uiStateActions.pushToast('success', TEXTS.unifiedOn)
              } else {
                st.save()
                uiStateActions.pushToast('success', TEXTS.unifiedOff)
              }
              settings.reload()
            })}
          </Card>

          {/* 酒馆更新 */}
          <Card>
            <SectionTitle title={TEXTS.sectionUpdate} />
            {switchRow('stcheckupdate', TEXTS.stcheckupdate, TEXTS.stcheckupdateDesc, settings.stcheckupdate, (v) => settings.update({ stcheckupdate: v }))}
          </Card>
        </div>
      )}

      {/* ==================== 启动器设置 tab ==================== */}
      {activeTab === 'launcher' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* 更新（镜像行已移入环境 tab 的运行环境区，此处仅启动器更新检查） */}
          <Card>
            <SectionTitle title={TEXTS.sectionUpdate} />
            {switchRow('checkupdate', TEXTS.checkupdate, TEXTS.checkupdateDesc, settings.checkupdate, (v) => settings.update({ checkupdate: v }))}
          </Card>

          {/* 启动器（tray 已按 D1 移除） */}
          <Card>
            <SectionTitle title={TEXTS.sectionLauncher} />
            {switchRow('autostart', TEXTS.autostart, TEXTS.autostartDesc, settings.autostart, (v) => settings.update({ autostart: v }))}
            {switchRow('reduce_motion', TEXTS.reduceMotion, TEXTS.reduceMotionDesc, !motionEnabled, (v) => setMotionEnabled(!v))}
          </Card>

          {/* 外观（主题色预设：色板行，点击即存即生效；预览色取当前模式侧的 ember，
              激活项以 2px text.primary 描边标识——全部色板统一 2px 边宽避免选中态抖动） */}
          <Card>
            <SectionTitle title={TEXTS.sectionAppearance} />
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 12 }}>
              <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans, flexShrink: 0 }}>
                {TEXTS.accentLabel}
              </text>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {(Object.keys(THEME_ACCENTS) as ThemeAccentId[]).map((id) => {
                  const active = id === accent
                  return (
                    <div
                      key={id}
                      onClick={() => setAccent(id)}
                      role="radio"
                      aria-checked={active}
                      aria-label={THEME_ACCENTS[id].label}
                      testId={`setting-accent-${id}`}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        backgroundColor: THEME_ACCENTS[id][mode].ember,
                        borderWidth: 2,
                        borderColor: active ? t.text.primary : 'transparent',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                    />
                  )
                })}
              </div>
            </div>
            <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
              {`${TEXTS.accentHintPrefix}：${THEME_ACCENTS[accent].label} · 切换后立即生效`}
            </text>
          </Card>

          {/* 终端（字号/字体族即时生效；自定义字体名走 Input+保存，同 customArgs 模式） */}
          <Card>
            <SectionTitle title={TEXTS.sectionTerminal} />
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans, flexShrink: 0 }}>
                {TEXTS.terminalFontSizeLabel}
              </text>
              <Select
                items={TERMINAL_FONT_SIZE_ITEMS}
                value={String(settings.terminalFontSize)}
                onValueChange={(v) => settings.update({ terminalFontSize: Number(v) })}
                width={120}
                testId="setting-terminal-font-size"
              />
            </div>
            <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans, marginBottom: 12 }}>
              {TEXTS.terminalFontSizeHint}
            </text>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans, flexShrink: 0 }}>
                {TEXTS.terminalFontFamilyLabel}
              </text>
              <Select
                items={TERMINAL_FONT_ITEMS}
                value={settings.terminalFontFamily}
                onValueChange={(v) => {
                  settings.update({ terminalFontFamily: v })
                  setFontDraft(v)
                }}
                width={280}
                testId="setting-terminal-font-family"
              />
            </div>
            <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans, marginBottom: 12 }}>
              {TEXTS.terminalFontFamilyHint}
            </text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
              <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans }}>
                {TEXTS.terminalFontCustomLabel}
              </text>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <Input
                    value={fontDraft}
                    onChange={setFontDraft}
                    placeholder={TEXTS.terminalFontCustomHint}
                    mono
                    testId="setting-terminal-font-custom"
                  />
                </div>
                <Button variant="primary" icon="save" onClick={handleSaveFontFamily} width={96} testId="setting-save-terminal-font">
                  {TEXTS.save}
                </Button>
              </div>
              <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
                {TEXTS.terminalFontCustomDesc}
              </text>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <text style={{ fontSize: 13, color: t.text.primary, fontFamily: t.font.sans }}>
                {TEXTS.terminalPreviewLabel}
              </text>
              <text
                testId="setting-terminal-font-preview"
                style={{
                  fontSize: settings.terminalFontSize,
                  fontFamily: settings.terminalFontFamily || t.font.mono,
                  color: t.text.secondary,
                }}>
                {TERMINAL_FONT_PREVIEW_TEXT}
              </text>
            </div>
          </Card>
        </div>
      )}
      </div>
    </div>
  )
}

function envCheckLabel(useSysEnv: boolean): string {
  return useSysEnv ? '检查系统环境' : TEXTS.checkEnv
}
