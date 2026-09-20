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
import { Chip } from '../components/Chip'
import { LOGO_DATA_URL } from '../assets/logo'

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
        {/* 官方 logo（设计 §4.6：img 48×48 r6） */}
        <img
          src={LOGO_DATA_URL}
          alt="SillyTavernLauncher logo"
          style={{ width: 48, height: 48, borderRadius: 6 }}
        />
        <text style={{ fontSize: t.fs.h2, fontWeight: 600, color: t.text.primary, fontFamily: t.font.sans }}>
          SillyTavernLauncher
        </text>
        {/* D5 规范化版本芯片（Chip 收口） */}
        <Chip>{`v${normalizeVersion(APP_VERSION)}`}</Chip>
        <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
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
        <text style={{ fontSize: t.fs.micro, color: t.text.muted, fontFamily: t.font.sans }}>
          {TEXTS.platformLine}
        </text>
      </div>
    </div>
  )
}
