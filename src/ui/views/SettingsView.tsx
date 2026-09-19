/**
 * 设置视图（设计 §4.5，单滚动型长表单）：
 * section 15px 标题切分 + 单滚动（D4 对策；折叠面板在 6 section 规模下负收益，已声明）。
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
import { getStConfig, useSettings } from '../../stores/settings'
import { useTerminalLogs } from '../../stores/terminalLogs'
import { uiStateActions } from '../../stores/uiState'
import { useThemeContext } from '../theme'
import { layout } from '../../theme'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { SectionTitle } from '../components/Card'
import { Select } from '../components/Select'
import { Switch } from '../components/Switch'

const TEXTS = {
  title: '设置',
  subtitle: '启动器与 SillyTavern 配置',
  // 更新源
  sectionMirror: '更新源',
  mirrorLabel: 'GitHub 镜像',
  mirrorHint: '当不使用官方源时，将使用镜像源加速下载',
  // 启动
  sectionLaunch: '启动',
  useSysEnv: '使用系统环境',
  useSysEnvDesc: '懒人包请勿修改，修改后重启生效 | 使用系统已安装的 Git 与 Node.js',
  patchgit: '启用修改Git配置文件',
  patchgitDesc: '开启后修改系统环境的Git配置文件（镜像源改写）',
  useOptimizeArgs: '使用优化参数',
  useOptimizeArgsDesc: '开启后将在启动命令中添加 --max-old-space-size=4096 参数（在自定义启动参数前）',
  customArgsLabel: '自定义启动参数',
  customArgsHint: '在此输入自定义启动参数，将添加到启动命令中，如果你不清楚，请留空！',
  customArgsDesc: '自定义启动参数将添加到启动命令末尾',
  save: '保存',
  // 网络
  sectionNetwork: '网络',
  listen: '启用局域网访问',
  listenDesc: '开启后允许局域网设备访问，并自动启用私有地址请求保护',
  editIpWhitelist: '编辑网络白名单',
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
  // 更新
  sectionUpdate: '更新',
  checkupdate: '自动检查启动器更新',
  checkupdateDesc: '开启后在每次启动启动器时会自动检查更新并提示(启动器并不会自动安装更新，请手动下载并更新)',
  stcheckupdate: '自动检查酒馆更新',
  stcheckupdateDesc: '开启后在每次启动酒馆时先进行更新操作再启动酒馆',
  // 启动器
  sectionLauncher: '启动器',
  autostart: '启用自动启动',
  autostartDesc: '启动启动器后自动启动酒馆（主窗口正常显示）',
  reduceMotion: '减少动效',
  reduceMotionDesc: '关闭界面过渡动画与状态动效（性能受限设备建议开启）',
  // 环境工具
  sectionTools: '环境工具',
  checkEnv: '检查内置环境',
  startCmd: '启动命令行',
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

const MIRROR_ITEMS = [
  { value: 'github', label: '官方源 (github.com)' },
  { value: 'gh-proxy.org', label: '镜像站点 (gh-proxy.org)' },
  { value: 'gh.llkk.cc', label: '镜像站点 (gh.llkk.cc)' },
]

export function SettingsView() {
  const t = useThemeContext().t
  const settings = useSettings()
  const { setMotionEnabled, motionEnabled } = useThemeContext()
  const [portDraft, setPortDraft] = useState(String(settings.stPort))
  const [proxyDraft, setProxyDraft] = useState(settings.proxyUrl)
  const [argsDraft, setArgsDraft] = useState(settings.customArgs)

  const st = getStConfig()

  /** 开关行：高 40（无描述）/48（有描述），标签左 Switch 右 */
  const switchRow = (
    key: string,
    label: string,
    desc: string | undefined,
    on: boolean,
    onChange: (v: boolean) => void,
  ): ReactElement => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: desc ? 48 : 40,
        gap: 12,
      }}
      key={key}>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, gap: 2 }}>
        <text style={{ fontSize: 13, fontWeight: 500, color: t.text.primary, fontFamily: t.font.sans }}>
          {label}
        </text>
        {desc && (
          <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>{desc}</text>
        )}
      </div>
      <Switch on={on} onChange={onChange} testId={`setting-${key}`} />
    </div>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
        <text style={{ fontSize: 26, fontWeight: 600, color: t.text.primary, fontFamily: t.font.sans }}>
          {TEXTS.title}
        </text>
        <text style={{ fontSize: 13, color: t.text.muted, fontFamily: t.font.sans }}>
          {TEXTS.subtitle}
        </text>
      </div>

      {/* 更新源 */}
      <SectionTitle title={TEXTS.sectionMirror} />
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 }}>
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
      <text style={{ fontSize: 12, color: t.status.info, fontFamily: t.font.sans, marginBottom: 16 }}>
        {TEXTS.mirrorHint}
      </text>

      {/* 启动 */}
      <SectionTitle title={TEXTS.sectionLaunch} />
      {switchRow('use_sys_env', TEXTS.useSysEnv, TEXTS.useSysEnvDesc, settings.useSysEnv, (v) => settings.update({ useSysEnv: v }))}
      {switchRow('patchgit', TEXTS.patchgit, TEXTS.patchgitDesc, settings.patchgit, (v) => settings.update({ patchgit: v }))}
      {switchRow('use_optimize_args', TEXTS.useOptimizeArgs, TEXTS.useOptimizeArgsDesc, settings.useOptimizeArgs, (v) => settings.update({ useOptimizeArgs: v }))}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
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
        <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
          {TEXTS.customArgsDesc}
        </text>
      </div>

      {/* 网络 */}
      <SectionTitle title={TEXTS.sectionNetwork} />
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 12 }}>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          {switchRow('listen', TEXTS.listen, TEXTS.listenDesc, settings.listen, handleListen)}
        </div>
        <Button variant="quiet" icon="edit" onClick={() => uiStateActions.openDialog({ kind: 'ipWhitelist' })} testId="setting-edit-ip-whitelist">
          {TEXTS.editIpWhitelist}
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
        <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
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

      {/* 更新 */}
      <SectionTitle title={TEXTS.sectionUpdate} />
      {switchRow('checkupdate', TEXTS.checkupdate, TEXTS.checkupdateDesc, settings.checkupdate, (v) => settings.update({ checkupdate: v }))}
      {switchRow('stcheckupdate', TEXTS.stcheckupdate, TEXTS.stcheckupdateDesc, settings.stcheckupdate, (v) => settings.update({ stcheckupdate: v }))}

      {/* 启动器（tray 已按 D1 移除） */}
      <SectionTitle title={TEXTS.sectionLauncher} />
      {switchRow('autostart', TEXTS.autostart, TEXTS.autostartDesc, settings.autostart, (v) => settings.update({ autostart: v }))}
      {switchRow('reduce_motion', TEXTS.reduceMotion, TEXTS.reduceMotionDesc, !motionEnabled, (v) => setMotionEnabled(!v))}

      {/* 环境工具（DEVIATION: 设计 §4.5 两按钮契约；Flet 版的"检查系统环境"未迁移，
          use_sys_env 开启时"检查内置环境"自动改走系统探测） */}
      <SectionTitle title={TEXTS.sectionTools} />
      <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
        <Button variant="default" icon="settings" onClick={handleCheckEnv} testId="setting-check-env">
          {envCheckLabel(getConfigStore().get<boolean>('use_sys_env', false))}
        </Button>
        <Button variant="default" icon="terminal" onClick={handleStartCmd} testId="setting-start-cmd">
          {TEXTS.startCmd}
        </Button>
      </div>
    </div>
  )
}

function envCheckLabel(useSysEnv: boolean): string {
  return useSysEnv ? '检查系统环境' : TEXTS.checkEnv
}
