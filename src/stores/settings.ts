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
  // 终端字体（config.json terminal.*，立即生效）
  terminalFontSize: number
  terminalFontFamily: string
  // SillyTavern config.yaml（stcfg 托管）
  listen: boolean
  stPort: number
  proxyUrl: string
  hostWhitelistEnabled: boolean
  unifiedWhitelist: boolean
  privateAddressWhitelistEnabled: boolean
}

// —— 终端字体设置域 ——

/** 字号下拉预设（px）；UI 只出预设值，杜绝非法字号态 */
export const TERMINAL_FONT_SIZE_PRESETS = [10, 11, 12, 13, 14, 16, 18] as const

/** config.json 手改/损坏时的字号兜底窗口 */
const TERMINAL_FONT_SIZE_MIN = 8
const TERMINAL_FONT_SIZE_MAX = 32

/** 自定义字体名长度上限（系统字体族名远短于此） */
const TERMINAL_FONT_FAMILY_MAX = 64

/** 脏值（NaN/越界/类型错）回退默认 12，防 minHeight NaN 打爆布局 */
export function sanitizeTerminalFontSize(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < TERMINAL_FONT_SIZE_MIN || n > TERMINAL_FONT_SIZE_MAX) return 12
  return Math.round(n)
}

/** 终端行高 = 字号 × 1.5 四舍五入（契约同默认 12→18）；LogRow 实际行高与 virtual-list 估算高度的唯一来源 */
export function terminalRowHeight(fontSize: number): number {
  return Math.round(fontSize * 1.5)
}

/** 自定义终端字体名校验：去首尾空白，非空且 ≤64 字符（允许空格/括号/中日文名） */
export function validateTerminalFontFamily(
  name: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = name.trim()
  if (trimmed.length === 0) return { ok: false, message: '字体名称不能为空' }
  if (trimmed.length > TERMINAL_FONT_FAMILY_MAX) {
    return { ok: false, message: `字体名称过长（最多 ${TERMINAL_FONT_FAMILY_MAX} 个字符）` }
  }
  return { ok: true, value: trimmed }
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
    terminalFontSize: sanitizeTerminalFontSize(S.get('terminal.font_size', 12)),
    terminalFontFamily: S.get<string>('terminal.font_family', ''),
    listen: st.listen,
    stPort: st.port,
    proxyUrl: st.proxyUrl,
    hostWhitelistEnabled: st.hostWhitelistEnabled,
    unifiedWhitelist: st.unifiedWhitelist,
    privateAddressWhitelistEnabled: st.privateAddressWhitelistEnabled,
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
      terminalFontSize: 'terminal.font_size',
      terminalFontFamily: 'terminal.font_family',
      listen: null,
      stPort: null,
      proxyUrl: null,
      hostWhitelistEnabled: null,
      unifiedWhitelist: null,
      privateAddressWhitelistEnabled: null,
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
