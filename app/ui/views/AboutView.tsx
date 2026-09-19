/**
 * 关于视图（设计 §4.6，单滚动型居中布局）：logo + 版本芯片（D5 规范化）+
 * 5 链接按钮（检查更新 = 唯一 primary）。打开链接 = cmd /c start（platform.openUrl）。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { normalizeVersion, checkForUpdates, fetchChangelog } from '../../services/updater'
import { openUrl } from '../../services/platform'
import { APP_VERSION } from '../../version'
import { uiStateActions } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'

const TEXTS = {
  title: '关于',
  subtitle: '关于本启动器',
  author: '作者: 泠夜Soul',
  github: '访问 GitHub 仓库',
  website: '访问启动器官网',
  bilibili: '访问作者 B 站',
  donate: '打赏作者',
  checkUpdate: '检查更新',
  platformLine: 'Windows · GPUIX',
  checking: '检查中...',
} as const

const URLS = {
  github: 'https://github.com/LingyeSoul/SillyTavernLauncher',
  website: 'https://sillytavern.lingyesoul.top',
  bilibili: 'https://space.bilibili.com/298721157',
  donate: 'https://ifdian.net/order/create?user_id=8a03ea64ebc211ebad0e52540025c377',
  releases: 'https://github.com/LingyeSoul/SillyTavernLauncher/releases/latest',
  changelog: 'https://sillytavern.lingyesoul.top/changelog',
} as const

export function AboutView() {
  const t = useTheme()
  const [checking, setChecking] = useState(false)

  /** ← version_checker.run_check：检查 + 可用则弹 updateAvailable（含 changelog） */
  const handleCheckUpdate = (): void => {
    setChecking(true)
    void (async () => {
      try {
        const current = normalizeVersion(APP_VERSION)
        const result = await checkForUpdates({ currentVersion: current })
        if (result.has_error || result.latest_version === null) {
          uiStateActions.pushToast('error', result.error_message ?? '检查更新失败')
          return
        }
        if (!result.has_update) {
          uiStateActions.pushToast('success', '当前已是最新版本')
          return
        }
        const changelog = await fetchChangelog({ currentVersion: current })
        uiStateActions.openDialog({
          kind: 'updateAvailable',
          currentVersion: current,
          latestVersion: result.latest_version,
          changelog,
          downloadUrl: URLS.releases,
        })
      } catch (err) {
        uiStateActions.pushToast('error', `检查更新失败: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setChecking(false)
      }
    })()
  }

  const linkButton = (key: string, label: string, url: string, icon: 'externalLink' | 'heart' | 'refresh', variant: 'default' | 'primary'): ReactElement => (
    <Button
      key={key}
      variant={variant}
      icon={icon}
      width={220}
      onClick={() => {
        void openUrl(url)
      }}
      testId={`about-${key}`}>
      {label}
    </Button>
  )

  return (
    <div
      style={{
        flexGrow: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: 24,
      }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 320, gap: 10 }}>
        {/* DEVIATION: 无 logo 位图资产，48×48 ember 圆角块 + "ST" 替位 */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 6,
            backgroundColor: t.ember,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <text style={{ fontSize: 18, fontWeight: 600, color: t.onPrimary, fontFamily: t.font.sans }}>
            ST
          </text>
        </div>
        <text style={{ fontSize: 20, fontWeight: 600, color: t.text.primary, fontFamily: t.font.sans }}>
          SillyTavernLauncher
        </text>
        {/* D5 规范化版本芯片 */}
        <div
          style={{
            display: 'flex',
            paddingLeft: 6,
            paddingRight: 6,
            paddingTop: 2,
            paddingBottom: 2,
            borderWidth: 1,
            borderColor: t.border.default,
            borderRadius: 3,
          }}>
          <text style={{ fontSize: 11, fontFamily: t.font.mono, color: t.text.secondary }}>
            {`v${normalizeVersion(APP_VERSION)}`}
          </text>
        </div>
        <text style={{ fontSize: 12, color: t.text.muted, fontFamily: t.font.sans }}>
          {TEXTS.author}
        </text>

        <div style={{ height: 24 }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {linkButton('github', TEXTS.github, URLS.github, 'externalLink', 'default')}
          {linkButton('website', TEXTS.website, URLS.website, 'externalLink', 'default')}
          {linkButton('bilibili', TEXTS.bilibili, URLS.bilibili, 'externalLink', 'default')}
          {linkButton('donate', TEXTS.donate, URLS.donate, 'heart', 'default')}
          <Button
            variant="primary"
            icon="refresh"
            width={220}
            disabled={checking}
            onClick={handleCheckUpdate}
            testId="about-check-update">
            {checking ? TEXTS.checking : TEXTS.checkUpdate}
          </Button>
        </div>

        <div style={{ height: 24 }} />
        <text style={{ fontSize: 11, color: t.text.muted, fontFamily: t.font.sans }}>
          {TEXTS.platformLine}
        </text>
      </div>
    </div>
  )
}
