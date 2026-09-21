/**
 * settings store：configStore 的 React 绑定（zustand 状态镜像 + 持久化）。
 *
 * - 每个 key 变更：configStore.set + save（← Flet 每个 *_changed handler 的语义）。
 * - ST 侧字段（listen/port/proxy/hostWhitelist/unified）走 stConfig 实例，
 *   保存后提示"重启酒馆后生效"（文案照搬 Flet 版）。
 */
import { create } from 'zustand'
import { getConfigStore } from '../services/configStore'
import type { EnvMode } from '../services/configStore'
import { errMsg, logError } from '../services/errorLog'
import {
  autoSelectMirror,
  createMirrorPingProbe,
  isValidMirrorHost,
  normalizeSpeedTest,
  OFFICIAL_MIRROR,
  readMirrorState,
  type MirrorSpeedTest,
} from '../services/mirrors'
import type { BoolMessage } from '../services/types'
import { getStConfig } from '../services/stConfig'
import { uiStateActions } from './uiState'

// 单例定义在服务层（stLifecycle 的 auto_proxy 也使用），此处转出口保持既有导入路径
export { getStConfig } from '../services/stConfig'

export interface SettingsSnapshot {
  // 启动器 config.json
  /** 运行环境模式（D1：use_sys_env 的三态化后继） */
  envMode: EnvMode
  patchgit: boolean
  autoProxy: boolean
  customArgs: string
  useOptimizeArgs: boolean
  checkupdate: boolean
  stcheckupdate: boolean
  autostart: boolean
  // —— GitHub 镜像（2026-09-21 镜像增强：官方源/加速镜像二选一 + 独立镜像源设置）——
  /** 是否使用加速镜像（false = 官方源） */
  mirrorEnabled: boolean
  /** 选中的镜像站 host（'' = 尚未选定，自动选优未完成时按官方源走） */
  mirrorHost: string
  /** 是否自动测速选优 + 故障自动切换（手动指定镜像后为 false） */
  mirrorAuto: boolean
  /** 测速结果快照（延迟 + 不可用名单） */
  mirrorSpeedtest: MirrorSpeedTest
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
    envMode: S.get<EnvMode>('env_mode', 'portable'),
    patchgit: S.get<boolean>('patchgit', false),
    autoProxy: S.get<boolean>('auto_proxy', false),
    customArgs: S.get<string>('custom_args', ''),
    useOptimizeArgs: S.get<boolean>('use_optimize_args', false),
    checkupdate: S.get<boolean>('checkupdate', true),
    stcheckupdate: S.get<boolean>('stcheckupdate', true),
    autostart: S.get<boolean>('autostart', false),
    mirrorEnabled: S.get<boolean>('github.enabled', false),
    mirrorHost: S.get<string>('github.mirror', ''),
    mirrorAuto: S.get<boolean>('github.auto', true),
    mirrorSpeedtest: normalizeSpeedTest(S.get('github.speedtest')),
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
    logError(`[settings] 保存配置失败: ${errMsg(err)}`)
    uiStateActions.pushToast('error', '配置保存失败，请检查文件写入权限')
    return false
  }
}

/** 镜像操作结果 → toast（失败一律透传服务层消息，不谎报成功） */
function toastMirrorResult(result: BoolMessage, successMessage: string): void {
  if (result.ok) {
    if (successMessage.length > 0) uiStateActions.pushToast('success', successMessage)
  } else {
    uiStateActions.pushToast('error', result.message)
  }
}

/**
 * 把已落盘的镜像同步进 gitconfig insteadOf / ST remote（spawn 路径的生效口径）。
 * 自动选优只写 config.json，而 portable/system 的 git 加速靠 gitconfig insteadOf
 * ——不同步就会出现"测速选好了却没生效"（embedded 走操作时内存前缀，不依赖它）。
 * 同步失败只记日志：镜像选择本身已落盘，下次切换/启动会再试。
 */
async function syncMirrorToGit(host: string, auto: boolean): Promise<void> {
  try {
    const { getStLifecycle } = await import('./stState')
    const result = await getStLifecycle().updateMirrorSetting(host, { auto })
    if (!result.ok) logError(`[settings] 镜像同步到 gitconfig 失败: ${result.message}`)
  } catch (err) {
    logError(`[settings] 镜像同步到 gitconfig 异常: ${errMsg(err)}`)
  }
}
interface SettingsState extends SettingsSnapshot {
  /** 更新启动器侧键并持久化（key 为 config.json 点号路径） */
  update: (patch: Partial<SettingsSnapshot>) => void
  /** 官方源 / 加速镜像 二选一（加速侧未选站且自动模式 → 后台立即测速选优） */
  setMirrorMode: (mode: MirrorMode) => Promise<void>
  /** 手动指定镜像站（auto=false 关掉自动选优与故障切换）/ 仅恢复自动选优（auto=true） */
  selectMirror: (host: string, auto: boolean) => Promise<void>
  /** 只翻自动选优开关（纯 config 键，不触碰 gitconfig/remote） */
  setMirrorAuto: (auto: boolean) => void
  /** 把指定镜像同步进 gitconfig insteadOf / ST remote（自动选优落盘后的生效步骤） */
  syncMirrorToGit: (host: string, auto: boolean) => Promise<void>
  /** 立即自动测速选优（与启动期自愈同一实现） */
  autoSelectMirrorNow: () => Promise<void>
  saveCustomArgs: (value: string) => void
  saveStPort: (port: number) => void
  saveProxyUrl: (url: string) => void
  reload: () => void
}

/** 顶层二选一：官方源 / 加速镜像 */
export type MirrorMode = 'official' | 'mirror'

/**
 * E2E/离线环境禁用启动期自动测速选优（对齐 STL_SKIP_AGREEMENT_RECHECK 惯例：
 * 批量探测 6+ 个镜像站会引入不可控网络等待与配置漂移）。
 */
export function mirrorAutoSelectDisabled(): boolean {
  return process.env.STL_SKIP_MIRROR_AUTOSELECT === '1'
}

export const useSettings = create<SettingsState>((set) => ({
  ...readSettings(),

  update: (patch) => {
    const keyMap: Record<keyof SettingsSnapshot, string | null> = {
      envMode: 'env_mode',
      patchgit: 'patchgit',
      autoProxy: 'auto_proxy',
      customArgs: 'custom_args',
      useOptimizeArgs: 'use_optimize_args',
      checkupdate: 'checkupdate',
      stcheckupdate: 'stcheckupdate',
      autostart: 'autostart',
      // 镜像四字段走专用动作（含 gitconfig/remote 联动），不经 update 直写
      mirrorEnabled: null,
      mirrorHost: null,
      mirrorAuto: null,
      mirrorSpeedtest: null,
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

  /**
   * ← update_mirror_setting：config + gitconfig 改写 + ST remote 同步。
   * 官方源：只关加速（保留已选 host，切回时可直接复用）；
   * 加速镜像：已选站直接生效；未选站且处于自动模式 → 后台测速选优（离线/E2E 可禁）。
   */
  setMirrorMode: async (mode) => {
    const { getStLifecycle } = await import('./stState')
    if (mode === 'official') {
      const result = await getStLifecycle().updateMirrorSetting(OFFICIAL_MIRROR)
      toastMirrorResult(result, '已切换到 GitHub 官方源')
      set(readSettings())
      return
    }
    const state = readMirrorState()
    if (isValidMirrorHost(state.host)) {
      const result = await getStLifecycle().updateMirrorSetting(state.host)
      toastMirrorResult(result, `已启用加速镜像：${state.host}`)
      set(readSettings())
      return
    }
    // 尚未选定镜像站：先落 enabled，再按自动模式后台选优
    const result = await getStLifecycle().updateMirrorSetting(OFFICIAL_MIRROR)
    if (!result.ok) {
      toastMirrorResult(result, '')
      set(readSettings())
      return
    }
    S.set('github.enabled', true)
    S.save()
    set(readSettings())
    if (state.auto && !mirrorAutoSelectDisabled()) {
      uiStateActions.pushToast('info', '未选定镜像站，正在自动测速选优…')
      await useSettings.getState().autoSelectMirrorNow()
    } else {
      uiStateActions.pushToast('warning', '尚未选定镜像站，请在「镜像源设置」中测速或手动选择')
    }
  },

  /** 手动选定镜像站 / 仅恢复自动选优（不触发网络；测速由镜像源设置对话框发起） */
  selectMirror: async (host, auto) => {
    const { getStLifecycle } = await import('./stState')
    if (host === OFFICIAL_MIRROR) {
      const result = await getStLifecycle().updateMirrorSetting(OFFICIAL_MIRROR)
      toastMirrorResult(result, '已切换到 GitHub 官方源')
      set(readSettings())
      return
    }
    if (!isValidMirrorHost(host)) {
      uiStateActions.pushToast('error', `无效的镜像源: ${host}`)
      return
    }
    const result = await getStLifecycle().updateMirrorSetting(host, { auto })
    toastMirrorResult(result, auto ? `已启用自动选优（当前 ${host}）` : `已手动指定镜像：${host}`)
    set(readSettings())
  },

  /** 立即测速选优（与启动期自愈同一实现；结果写回配置并 toast 汇报） */
  autoSelectMirrorNow: async () => {
    try {
      // 批量探测走 ping（零服务端应用层负载）；只有故障取证才发真实请求
      const outcome = await autoSelectMirror({ probe: createMirrorPingProbe() })
      if (!outcome.exhausted && outcome.host.length > 0) {
        // 选中镜像必须落到 gitconfig insteadOf——portable/system 的 git 加速靠它生效
        // （embedded 才是"操作时内存前缀"；只写 config 会"选了却没生效"）
        await syncMirrorToGit(outcome.host, true)
      }
      uiStateActions.pushToast(outcome.exhausted ? 'warning' : 'success', outcome.message)
    } catch (err) {
      logError(`[settings] 自动测速选优失败: ${errMsg(err)}`)
      uiStateActions.pushToast('error', '自动测速选优失败，请稍后重试或在「镜像源设置」中手动选择')
    }
    set(readSettings())
  },

  /** 自动选优开关：纯 config 键（不触碰 gitconfig/remote——那是 selectMirror 的职责） */
  setMirrorAuto: (auto) => {
    S.set('github.auto', auto)
    if (saveLauncherConfig()) {
      uiStateActions.pushToast('success', auto ? '已开启自动测速选优' : '已关闭自动测速选优')
    }
    set(readSettings())
  },

  /** 自动选优落盘后的生效步骤（app.tsx 启动自愈与界面动作共用同一实现） */
  syncMirrorToGit: async (host, auto) => {
    await syncMirrorToGit(host, auto)
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
