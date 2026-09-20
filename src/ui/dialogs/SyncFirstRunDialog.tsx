/**
 * 首启同步服务器警告对话框（← Flet sync_ui._show_first_server_dialog）：
 * 30s 倒计时强制阅读 + 红字安全要点 + 「不再显示此提醒」切换。
 *
 * - 触发：开启同步服务器且 sync.first_shown=false（门控纯函数见下方导出）
 * - 模态不可关闭：strong + 不传 onClose（da09d6c「Modal close guards」模式，
 *   同 EulaDialog）——Escape 无效、无遮罩点击关闭，唯一出口是倒计时归零后
 *   的「关闭」按钮；卸载即放弃，onConfirmed 只在该按钮点击路径触发
 * - 关闭时若勾选「不再显示」→ sync.first_shown=true 落盘；对话框关闭后才经
 *   onConfirmed 真正启动服务器（← 旧版 on_close 的顺序：先持久化/关窗、后启动）
 *
 * DEVIATION: 旧版「不再显示」按钮蓝底→绿底+打勾的切换，在本设计系统内映射为
 * default（中性）→ primary（ember 激活态）+ check 图标——token 契约内无蓝/绿
 * 按钮变体，激活语义走主强调色（与全 UI 激活态语言一致），文案照搬。
 */
import { useEffect, useState } from 'react'
import { getConfigStore } from '../../services/configStore'
import { errMsg, logError } from '../../services/errorLog'
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'

const TEXTS = {
  title: '启动同步服务器提醒',
  countdown: (n: number) => `请仔细阅读以下内容（${n}秒后可关闭）`,
  countdownDone: '您可以关闭此窗口了',
  warnTitle: '⚠️ 安全提醒',
  intro: '您正在启动 SillyTavern 数据同步服务器，请务必注意以下几点：',
  point1: '• 请仅在信任的局域网内使用本功能',
  point2: '• 确保您的网络环境安全可靠',
  point3: '• 同步数据包含您的聊天记录和各种设置以及密钥！！！',
  point4: '• 建议定期备份重要数据',
  tokenHint1: '服务器启动后，请使用日志中带访问令牌的完整地址连接同步服务。',
  tokenHint2: '完整地址中的访问令牌属于敏感信息，请仅分享给可信设备。',
  dontShow: '不再显示此提醒',
  dontShowSet: '已设置不再显示',
  close: '关闭',
} as const

/** 倒计时秒数（E2E 测试可用 SYNC_FIRST_RUN_COUNTDOWN_SECONDS 环境变量缩短等待）。
 *  非法值（非数字/非正数）兜底 30：NaN 会让 countdown<=0 永假、关闭按钮永久禁用 */
const RAW_COUNTDOWN_SECONDS = Number(process.env.SYNC_FIRST_RUN_COUNTDOWN_SECONDS ?? 30)
const COUNTDOWN_SECONDS =
  Number.isFinite(RAW_COUNTDOWN_SECONDS) && RAW_COUNTDOWN_SECONDS > 0 ? Math.floor(RAW_COUNTDOWN_SECONDS) : 30

/**
 * 门控/持久化所需的最小 config 形状（ConfigStore 满足之；测试可注入任意实现）。
 * 与组件同文件导出：文件分区约定下不新建 services 文件，且 import 链可被
 * vitest unit 项目在 Node 下直接加载（无 GPU 副作用）。
 */
export interface SyncFirstRunConfigLike {
  get<T = unknown>(key: string, defaultValue?: T): T
  set(key: string, value: unknown): void
  save(): void
}

/** ← _should_show_first_server_dialog：未显示过（含读取出错兜底）→ true */
export function shouldShowFirstRunDialog(config: SyncFirstRunConfigLike): boolean {
  try {
    return !config.get<boolean>('sync.first_shown', false)
  } catch {
    // 旧版 except: return True——门控失败宁可多提醒一次
    return true
  }
}

/** ← _mark_first_server_dialog_shown：勾选「不再显示」后持久化；失败记日志不抛 */
export function persistFirstRunShown(config: SyncFirstRunConfigLike): void {
  try {
    config.set('sync.first_shown', true)
    config.save()
  } catch (err) {
    logError(`[sync] 保存首次同步提示状态失败: ${errMsg(err)}`)
  }
}

export interface SyncFirstRunDialogProps {
  /** 倒计时归零后用户点「关闭」时触发——真正启动服务器放这里 */
  onConfirm: () => void
}

export function SyncFirstRunDialog({ onConfirm }: SyncFirstRunDialogProps) {
  const t = useTheme()
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS)
  const [dontShow, setDontShow] = useState(false)

  // 30s 倒计时（EulaDialog 同款：归零后不再建定时器；卸载清理防泄漏）
  useEffect(() => {
    if (countdown <= 0) return
    const id = setInterval(() => setCountdown((n) => Math.max(0, n - 1)), 1000)
    return () => clearInterval(id)
  }, [countdown])

  // ← 旧版 on_close：先按勾选持久化，再关窗，最后才启动服务器
  const handleClose = (): void => {
    if (dontShow) persistFirstRunShown(getConfigStore())
    useUiState.getState().closeTopDialog()
    onConfirm()
  }

  const divider = (
    <div style={{ height: 1, backgroundColor: t.border.subtle, marginTop: 10, marginBottom: 10 }} />
  )
  const pointStyle = {
    fontSize: t.fs.field,
    color: t.status.error,
    fontFamily: t.font.sans,
    lineHeight: 22,
  }

  return (
    // title 传纯字符串：Modal 将 title 渲染进 <text>，元素子节点无法内联排版
    // （GPUIX 无 inline run，div/svg 会纵向堆叠）——警示图标由正文红字 ⚠️ 承担
    <Modal
      open
      strong
      width={500}
      title={TEXTS.title}
      actions={
        <>
          <Button
            variant={dontShow ? 'primary' : 'default'}
            icon={dontShow ? 'check' : undefined}
            onClick={() => setDontShow((v) => !v)}
            testId="sync-first-dont-show">
            {dontShow ? TEXTS.dontShowSet : TEXTS.dontShow}
          </Button>
          <Button
            variant="quietDanger"
            icon="x"
            disabled={countdown > 0}
            onClick={handleClose}
            testId="sync-first-close">
            {TEXTS.close}
          </Button>
        </>
      }>
      {/* 倒计时状态行：旧版 16px 粗体红，归零变绿（error→success 语义） */}
      <text
        style={{
          fontSize: t.fs.h3,
          fontWeight: 600,
          color: countdown > 0 ? t.status.error : t.status.success,
          fontFamily: t.font.sans,
        }}>
        {countdown > 0 ? TEXTS.countdown(countdown) : TEXTS.countdownDone}
      </text>

      {divider}

      <text style={{ fontSize: t.fs.h2, fontWeight: 600, color: t.status.error, fontFamily: t.font.sans }}>
        {TEXTS.warnTitle}
      </text>
      <div style={{ height: 10 }} />
      <text style={{ fontSize: t.fs.body, color: t.text.primary, fontFamily: t.font.sans, lineHeight: 20 }}>
        {TEXTS.intro}
      </text>
      <text style={pointStyle}>{TEXTS.point1}</text>
      <text style={pointStyle}>{TEXTS.point2}</text>
      <text style={pointStyle}>{TEXTS.point3}</text>
      <text style={pointStyle}>{TEXTS.point4}</text>

      {divider}

      <text style={{ fontSize: t.fs.field, color: t.text.primary, fontFamily: t.font.sans, lineHeight: 20 }}>
        {TEXTS.tokenHint1}
      </text>
      <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans, lineHeight: 18 }}>
        {TEXTS.tokenHint2}
      </text>
    </Modal>
  )
}
