/**
 * EULA 对话框（设计 §4.7）：30s 倒计时 + <markdown> 正文（远端文本，maxHeight 300
 * 内部滚动——模态在 FloatingLayer，与主视图滚动不构成嵌套）。
 * 同意 → agreement_accepted/agreement_version 落盘；不同意 → 退出进程。
 *
 * DEVIATION: 协议抓取（features/agreement/fetcher.py）的精简版在 services/agreement
 * （缓存先行展示 + 后台刷新 + 原子缓存写），StartupFlow 的后台版本核对共用该模块。
 */
import { useEffect, useState } from 'react'
import {
  contentFingerprint,
  fetchAgreementDocument,
  loadAgreementCache,
} from '../../services/agreement'
import { getConfigStore } from '../../services/configStore'
import { errMsg, logError } from '../../services/errorLog'
import { useUiState } from '../../stores/uiState'
import { editorTheme, useTheme, useThemeContext } from '../theme'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'

const TEXTS = {
  title: '使用协议',
  important: '重要提示',
  importantBody: '在继续使用前，请仔细阅读并同意本免责声明与合规使用协议',
  countdown: (n: number) => `请仔细阅读协议内容（${n}秒后可同意）`,
  countdownDone: '您现在可以同意协议了',
  agree: '我已阅读并同意',
  disagree: '不同意并退出',
  loading: '正在获取协议内容...',
  fetchFailTitle: '协议获取失败',
  fetchFailBody: '无法获取使用协议内容，应用程序无法继续运行。',
  fetchFailHint: '请检查网络连接后重新启动程序。',
  exit: '退出程序',
} as const

/** 倒计时秒数（E2E 测试可用 EULA_COUNTDOWN_SECONDS 环境变量缩短等待） */
const COUNTDOWN_SECONDS = Number(process.env.EULA_COUNTDOWN_SECONDS ?? 30)

export function EulaDialog() {
  const t = useTheme()
  const { mode } = useThemeContext()
  const [content, setContent] = useState<string | null>(() => loadAgreementCache()?.content ?? null)
  const [version, setVersion] = useState<string>(() => loadAgreementCache()?.date ?? '')
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS)

  // 远端抓取（缓存先行展示，后台刷新）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const doc = await fetchAgreementDocument()
        if (cancelled || !doc) return
        setContent(doc.content)
        setVersion(doc.date)
      } catch (err) {
        if (cancelled) return
        if (content === null) {
          setFetchError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 30s 倒计时
  useEffect(() => {
    if (countdown <= 0) return
    const id = setInterval(() => setCountdown((n) => Math.max(0, n - 1)), 1000)
    return () => clearInterval(id)
  }, [countdown])

  const handleAgree = (): void => {
    const config = getConfigStore()
    config.set('agreement_accepted', true)
    // 缓存路径下 version 可能仍为空（缓存无 date）——同样以内容指纹兜底
    config.set('agreement_version', version || (content ? contentFingerprint(content) : 'unknown'))
    try {
      config.save()
    } catch (err) {
      logError(`[eula] 保存协议同意状态失败: ${errMsg(err)}`)
    }
    useUiState.getState().closeTopDialog()
  }

  // 获取失败且无缓存：不可关闭，仅可退出（← show_network_error_dialog）
  if (fetchError !== null && content === null) {
    return (
      <Modal
        open
        strong
        width={500}
        title={TEXTS.fetchFailTitle}
        actions={
          <Button variant="primary" onClick={() => process.exit(1)} testId="eula-exit-on-error">
            {TEXTS.exit}
          </Button>
        }>
        <text style={{ fontSize: 14, color: t.text.primary, fontFamily: t.font.sans }}>
          {TEXTS.fetchFailBody}
        </text>
        <div style={{ height: 6 }} />
        <text style={{ fontSize: 13, color: t.text.muted, fontFamily: t.font.sans }}>
          {TEXTS.fetchFailHint}
        </text>
      </Modal>
    )
  }

  return (
    <Modal
      open
      strong
      width={520}
      title={TEXTS.title}
      actions={
        <>
          <Button
            variant="quietDanger"
            onClick={() => process.exit(0)}
            testId="eula-disagree">
            {TEXTS.disagree}
          </Button>
          <Button
            variant="primary"
            disabled={countdown > 0}
            onClick={handleAgree}
            testId="eula-agree">
            {TEXTS.agree}
          </Button>
        </>
      }>
      {/* 倒计时状态行 */}
      <text
        style={{
          fontSize: 12,
          color: countdown > 0 ? t.status.warning : t.status.success,
          fontFamily: t.font.sans,
          marginBottom: 8,
        }}>
        {countdown > 0 ? TEXTS.countdown(countdown) : TEXTS.countdownDone}
      </text>

      {/* 正文：markdown + 内部滚动（模态浮层内合法） */}
      <div
        style={{
          marginTop: 8,
          maxHeight: 300,
          overflow: 'scroll',
          backgroundColor: t.bg.deep,
          borderWidth: 1,
          borderColor: t.border.subtle,
          borderRadius: t.radius.md,
          padding: 12,
        }}>
        {content === null ? (
          <text style={{ fontSize: 13, color: t.text.muted, fontFamily: t.font.sans }}>
            {TEXTS.loading}
          </text>
        ) : (
          <markdown source={content} theme={editorTheme(t, mode)} />
        )}
      </div>
    </Modal>
  )
}
