/**
 * settings store：configStore 的 React 绑定（zustand 状态镜像 + 持久化）。
 *
 * - 每个 key 变更：configStore.set + save（← Flet 每个 *_changed handler 的语义）。
 * - ST 侧字段（listen/port/proxy/hostWhitelist/unified）走 stConfig 实例，
 *   保存后提示"重启酒馆后生效"（文案照搬 Flet 版）。
 */
import { create } from 'zustand'
import { getConfigStore } from '../services/configStore'
import { getStConfig } from '../services/stConfig'
import { uiStateActions } from './uiState'

// 单例定义在服务层（stLifecycle 的 auto_proxy 也使用），此处转出口保持既有导入路径
export { getStConfig } from '../services/stConfig'

export interface SettingsSnapshot {
  // 启动器 config.json
  useSysEnv: boolean
  patchgit: boolean
  autoProxy: boolean
  customArgs: string
  useOptimizeArgs: boolean
  checkupdate: boolean
  stcheckupdate: boolean
  autostart: boolean
  mirror: string
  // SillyTavern config.yaml（stcfg 托管）
  listen: boolean
  stPort: number
  proxyUrl: string
  hostWhitelistEnabled: boolean
  unifiedWhitelist: boolean
}

const S = getConfigStore()

export function readSettings(): SettingsSnapshot {
  const st = getStConfig()
  return {
    useSysEnv: S.get<boolean>('use_sys_env', false),
    patchgit: S.get<boolean>('patchgit', false),
    autoProxy: S.get<boolean>('auto_proxy', false),
    customArgs: S.get<string>('custom_args', ''),
    useOptimizeArgs: S.get<boolean>('use_optimize_args', false),
    checkupdate: S.get<boolean>('checkupdate', true),
    stcheckupdate: S.get<boolean>('stcheckupdate', true),
    autostart: S.get<boolean>('autostart', false),
    mirror: S.get<string>('github.mirror', 'github'),
    listen: st.listen,
    stPort: st.port,
    proxyUrl: st.proxyUrl,
    hostWhitelistEnabled: st.hostWhitelistEnabled,
    unifiedWhitelist: st.unifiedWhitelist,
  }
}

function saveLauncherConfig(): boolean {
  try {
    S.save()
    return true
  } catch (err) {
    console.error(`[settings] 保存配置失败: ${err instanceof Error ? err.message : String(err)}`)
    uiStateActions.pushToast('error', '配置保存失败，请检查文件写入权限')
    return false
  }
}

interface SettingsState extends SettingsSnapshot {
  /** 更新启动器侧键并持久化（key 为 config.json 点号路径） */
  update: (patch: Partial<SettingsSnapshot>) => void
  setMirror: (mirror: string) => Promise<void>
  saveCustomArgs: (value: string) => void
  saveStPort: (port: number) => void
  saveProxyUrl: (url: string) => void
  reload: () => void
}

export const useSettings = create<SettingsState>((set) => ({
  ...readSettings(),

  update: (patch) => {
    const keyMap: Record<keyof SettingsSnapshot, string | null> = {
      useSysEnv: 'use_sys_env',
      patchgit: 'patchgit',
      autoProxy: 'auto_proxy',
      customArgs: 'custom_args',
      useOptimizeArgs: 'use_optimize_args',
      checkupdate: 'checkupdate',
      stcheckupdate: 'stcheckupdate',
      autostart: 'autostart',
      mirror: 'github.mirror',
      listen: null,
      stPort: null,
      proxyUrl: null,
      hostWhitelistEnabled: null,
      unifiedWhitelist: null,
    }
    for (const [field, configKey] of Object.entries(keyMap)) {
      const value = patch[field as keyof SettingsSnapshot]
      if (value === undefined || configKey === null) continue
      S.set(configKey, value)
    }
    if (saveLauncherConfig()) uiStateActions.pushToast('success', '设置已保存')
    set(readSettings())
  },

  setMirror: async (mirror) => {
    // ← update_mirror_setting：config + gitconfig 改写 + ST remote 同步
    const { getStLifecycle } = await import('./stState')
    const result = await getStLifecycle().updateMirrorSetting(mirror)
    if (result.ok) uiStateActions.pushToast('success', '镜像配置已更新')
    else uiStateActions.pushToast('error', result.message)
    set(readSettings())
  },

  saveCustomArgs: (value) => {
    S.set('custom_args', value)
    if (saveLauncherConfig()) uiStateActions.pushToast('success', '自定义启动参数已保存')
    set(readSettings())
  },

  saveStPort: (port) => {
    const st = getStConfig()
    st.port = port
    // save 失败不得弹「已保存」（stConfig.save 现返回是否成功）
    if (st.save()) uiStateActions.pushToast('success', '端口已保存，重启酒馆后生效')
    else uiStateActions.pushToast('error', '端口保存失败，请检查 SillyTavern/config.yaml 写入权限')
    set(readSettings())
  },

  saveProxyUrl: (url) => {
    const st = getStConfig()
    st.proxyUrl = url
    if (st.save()) uiStateActions.pushToast('success', '代理URL已保存，重启酒馆后生效')
    else uiStateActions.pushToast('error', '代理URL保存失败，请检查 SillyTavern/config.yaml 写入权限')
    set(readSettings())
  },

  reload: () => set(readSettings()),
}))
