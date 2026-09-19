/**
 * ← checker.py 语义等价测试：normalizeVersion 全形态（D5）、isBetaVersion、
 * compareLauncherVersions 完整比较链（含中文测试版N/beta N）、镜像 URL、
 * 远端版本抓取（package.json → API 回退）、changelog vp-doc 提取与 HTML→Markdown、
 * checkNativeUpdate 延迟注入。
 */
import { describe, expect, it, vi } from 'vitest'
import { compareVersions } from '../services/env'
import {
  CHANGELOG_URL,
  checkForUpdates,
  checkNativeUpdate,
  compareLauncherVersions,
  fetchChangelog,
  fetchLatestVersionFromApi,
  fetchLatestVersionFromRaw,
  htmlToMarkdown,
  isBetaVersion,
  normalizeVersion,
  unescapeHtml,
  withMirrorPrefix,
  type FetchLike,
  type UpdateCheckResult,
} from '../services/updater'

describe('normalizeVersion（← D5 语义化 pre-release）', () => {
  it('中文测试版N', () => {
    expect(normalizeVersion('v1.3.11测试版3')).toBe('1.3.11-beta.3')
    expect(normalizeVersion('v1.3.11测试版')).toBe('1.3.11-beta')
    expect(normalizeVersion('1.3.11测试版12')).toBe('1.3.11-beta.12')
  })

  it('英文 beta 后缀（大小写/空格变体）', () => {
    expect(normalizeVersion('1.3.11-beta.2')).toBe('1.3.11-beta.2')
    expect(normalizeVersion('v1.3.11 beta 4')).toBe('1.3.11-beta.4')
    expect(normalizeVersion('1.3.11-Beta2')).toBe('1.3.11-beta.2')
    expect(normalizeVersion('v1.3.11beta')).toBe('1.3.11-beta')
  })

  it('无后缀只去 v 前缀；非版本串原样', () => {
    expect(normalizeVersion('v1.3.10')).toBe('1.3.10')
    expect(normalizeVersion('V2.0.0')).toBe('2.0.0')
    expect(normalizeVersion('1.2')).toBe('1.2')
    expect(normalizeVersion('unknown')).toBe('unknown')
  })

  it('RELEASES_VERSION 比较：本地测试版高于已发布版（semver 接入）', () => {
    const VERSION = 'v1.3.11测试版3'
    const RELEASES_VERSION = 'v1.3.10'
    expect(compareVersions(normalizeVersion(VERSION), normalizeVersion(RELEASES_VERSION))).toBeGreaterThan(0)
    // 同主干测试版编号有序
    expect(compareVersions(normalizeVersion('v1.3.11测试版3'), normalizeVersion('v1.3.11测试版5'))).toBeLessThan(0)
    // 无编号测试版低于有编号
    expect(compareVersions(normalizeVersion('v1.3.11测试版'), normalizeVersion('v1.3.11测试版2'))).toBeLessThan(0)
  })
})

describe('isBetaVersion（← 大小写敏感清单 1:1）', () => {
  it('识别各类测试版标识', () => {
    expect(isBetaVersion('v1.3.11测试版3')).toBe(true)
    expect(isBetaVersion('v1.3.11-beta.2')).toBe(true)
    expect(isBetaVersion('v1.3.11-Beta')).toBe(true)
    expect(isBetaVersion('v1.3.11-BETA')).toBe(true)
    expect(isBetaVersion('v1.3.11-rc1')).toBe(true)
    expect(isBetaVersion('v1.3.11-RC1')).toBe(true)
    expect(isBetaVersion('v1.3.11-alpha')).toBe(true)
    expect(isBetaVersion('v1.3.11-dev')).toBe(true)
    expect(isBetaVersion('v1.3.11-Preview')).toBe(true)
  })

  it('正式版与未列出的变体不识别（Python 清单无 PREVIEW/DEV 大写）', () => {
    expect(isBetaVersion('v1.3.10')).toBe(false)
    expect(isBetaVersion('1.2.3')).toBe(false)
    expect(isBetaVersion('v1.3.11-PREVIEW')).toBe(false)
    expect(isBetaVersion('v1.3.11-DEV')).toBe(false)
  })
})

describe('compareLauncherVersions（← compare_versions 1:1）', () => {
  it('远端是测试版 → 恒 0（不提示更新）', () => {
    expect(compareLauncherVersions('v1.3.10', 'v1.3.11测试版3')).toBe(0)
    expect(compareLauncherVersions('v1.3.9', 'v1.3.10-beta')).toBe(0)
  })

  it('主版本号比较', () => {
    expect(compareLauncherVersions('v1.3.9', 'v1.3.10')).toBe(-1)
    expect(compareLauncherVersions('v1.3.11', 'v1.3.10')).toBe(1)
    expect(compareLauncherVersions('v1.3.10', 'v1.3.10')).toBe(0)
    expect(compareLauncherVersions('v1.3', 'v1.3.0')).toBe(0)
  })

  it('本地测试版主干更新 → 不提示（本地 > 远端）', () => {
    expect(compareLauncherVersions('v1.3.11测试版3', 'v1.3.10')).toBe(1)
  })

  it('同主干：本地测试版 < 远端正式版', () => {
    expect(compareLauncherVersions('v1.3.11测试版2', 'v1.3.11')).toBe(-1)
  })

  it('双测试版比较 → 顶层守卫先命中恒 0（1:1：Python 注明后缀比较分支不再执行）', () => {
    expect(compareLauncherVersions('v1.3.11测试版3', 'v1.3.11测试版5')).toBe(0)
    expect(compareLauncherVersions('v1.3.11beta2', 'v1.3.11测试版5')).toBe(0)
    expect(compareLauncherVersions('v1.3.11测试版3', 'v1.3.11测试版')).toBe(0)
  })

  it('后缀不对称：本地有后缀 → 远端更新；远端有后缀（非测试版）→ 本地更新', () => {
    expect(compareLauncherVersions('v1.3.11-x', 'v1.3.11')).toBe(-1)
    expect(compareLauncherVersions('v1.3.11', 'v1.3.11-x')).toBe(1)
  })

  it('非测试版后缀按字符串比较', () => {
    expect(compareLauncherVersions('v1.3.11-a', 'v1.3.11-b')).toBe(-1)
    expect(compareLauncherVersions('v1.3.11-b', 'v1.3.11-a')).toBe(1)
  })
})

describe('镜像 URL（← get_github_mirror + URL 构造）', () => {
  const RAW = 'https://raw.githubusercontent.com/LingyeSoul/SillyTavernLauncher/refs/heads/main/package.json'

  it('github 原样，镜像站前置', () => {
    expect(withMirrorPrefix('github', RAW)).toBe(RAW)
    expect(withMirrorPrefix('gh-proxy.org', RAW)).toBe(`https://gh-proxy.org/${RAW}`)
    expect(withMirrorPrefix('gh.llkk.cc', RAW)).toBe(`https://gh.llkk.cc/${RAW}`)
  })

  it('远端抓取走镜像前缀（fetch URL 断言）', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      new Response(JSON.stringify({ version: 'v1.3.12' }), { status: 200 }),
    ) as unknown as FetchLike
    const version = await fetchLatestVersionFromRaw({
      currentVersion: 'v1.3.10',
      getMirror: () => 'gh-proxy.org',
      fetchImpl,
    })
    expect(version).toBe('v1.3.12')
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://gh-proxy.org/${RAW}`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'SillyTavernLauncher/1.0' }),
      }),
    )
  })
})

describe('远端版本抓取（← raw → API 回退）', () => {
  it('package.json version 解析', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ name: 'stl', version: 'v1.3.12' }), { status: 200 })
    expect(await fetchLatestVersionFromRaw({ currentVersion: 'x', fetchImpl })).toBe('v1.3.12')
  })

  it('非 200 / 缺 version / JSON 损坏 → null', async () => {
    const status500: FetchLike = async () => new Response('err', { status: 500 })
    expect(await fetchLatestVersionFromRaw({ currentVersion: 'x', fetchImpl: status500 })).toBeNull()
    const noVersion: FetchLike = async () => new Response('{"name":"x"}', { status: 200 })
    expect(await fetchLatestVersionFromRaw({ currentVersion: 'x', fetchImpl: noVersion })).toBeNull()
    const broken: FetchLike = async () => new Response('not json', { status: 200 })
    expect(await fetchLatestVersionFromRaw({ currentVersion: 'x', fetchImpl: broken })).toBeNull()
  })

  it('网络异常 → null', async () => {
    const throwing: FetchLike = async () => {
      throw new Error('network down')
    }
    expect(await fetchLatestVersionFromRaw({ currentVersion: 'x', fetchImpl: throwing })).toBeNull()
  })

  it('API 回退：tag_name 优先、name 次之', async () => {
    const withTag: FetchLike = async () =>
      new Response(JSON.stringify({ tag_name: 'v1.3.12', name: 'Release 1.3.12' }), { status: 200 })
    expect(await fetchLatestVersionFromApi({ currentVersion: 'x', fetchImpl: withTag })).toBe('v1.3.12')
    const withName: FetchLike = async () =>
      new Response(JSON.stringify({ name: 'v1.3.12' }), { status: 200 })
    expect(await fetchLatestVersionFromApi({ currentVersion: 'x', fetchImpl: withName })).toBe('v1.3.12')
  })
})

describe('checkForUpdates（← run_check 的结果对象版）', () => {
  it('两条链路均失败 → has_error', async () => {
    const failing: FetchLike = async () => new Response('', { status: 404 })
    const result = await checkForUpdates({ currentVersion: 'v1.3.10', fetchImpl: failing })
    expect(result.has_error).toBe(true)
    expect(result.error_message).toContain('无法获取最新版本信息')
    expect(result.has_update).toBe(false)
  })

  it('发现更新 / 已是最新 / 远端测试版不提示', async () => {
    const latest: FetchLike = async () =>
      new Response(JSON.stringify({ version: 'v1.3.12' }), { status: 200 })
    const update = await checkForUpdates({ currentVersion: 'v1.3.10', fetchImpl: latest })
    expect(update.has_error).toBe(false)
    expect(update.has_update).toBe(true)
    expect(update.latest_version).toBe('v1.3.12')

    const same = await checkForUpdates({ currentVersion: 'v1.3.12', fetchImpl: latest })
    expect(same.has_update).toBe(false)

    const beta: FetchLike = async () =>
      new Response(JSON.stringify({ version: 'v1.3.12测试版1' }), { status: 200 })
    const noBeta = await checkForUpdates({ currentVersion: 'v1.3.10', fetchImpl: beta })
    expect(noBeta.has_update).toBe(false)
  })

  it('raw 失败回退 API', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      if (calls === 1) return new Response('fail', { status: 500 })
      return new Response(JSON.stringify({ tag_name: 'v1.4.0' }), { status: 200 })
    }
    const result: UpdateCheckResult = await checkForUpdates({
      currentVersion: 'v1.3.10',
      fetchImpl,
    })
    expect(result.has_error).toBe(false)
    expect(result.latest_version).toBe('v1.4.0')
    expect(result.has_update).toBe(true)
  })
})

describe('HTML → Markdown（← _html_to_markdown）', () => {
  it('unescapeHtml：命名与数字实体', () => {
    expect(unescapeHtml('a&amp;b')).toBe('a&b')
    expect(unescapeHtml('&lt;div&gt;')).toBe('<div>')
    expect(unescapeHtml('&#39;x&#39;')).toBe("'x'")
    expect(unescapeHtml('&#x41;')).toBe('A')
    expect(unescapeHtml('a&nbsp;b')).toBe('a\u00a0b')
    expect(unescapeHtml('unknown&fake;')).toBe('unknown&fake;')
  })

  it('标题/段落/列表/分隔线转换（strong/code 收集分支与 Python 同为不可达死代码，1:1）', () => {
    const html = [
      '<main><div class="vp-doc"><h1>更新日志 <a class="header-anchor" href="#x">#</a></h1>',
      '<h2>v1.3.11 (2026-09-01)</h2>',
      '<h3>✨ 新增功能</h3>',
      '<p>本次更新包含<strong>重要修复</strong></p>',
      '<ul><li>新增扩展管理 <code>extension</code> <code>manager</code></li>',
      '<li>修复同步问题</li></ul>',
      '<hr>',
      '<p>普通段落 &amp; 转义</p>',
      '</div></main>',
    ].join('')
    const markdown = htmlToMarkdown(html)
    expect(markdown).toContain('# 更新日志')
    expect(markdown).toContain('## v1.3.11 (2026-09-01)')
    expect(markdown).toContain('### ✨ 新增功能')
    // 说明：开标签前插换行 + 闭合标签移除的预处理，使 <p> 行不再包含 <strong>、
    // <code> 行不再有闭合标签——Python 同款管线里这两个收集分支实际不可达，
    // 输出为纯文本（1:1 保留该行为）。
    expect(markdown).toContain('本次更新包含')
    expect(markdown).not.toContain('**重要修复**')
    expect(markdown).toContain('- 新增扩展管理')
    expect(markdown).toContain('- 修复同步问题')
    expect(markdown).toContain('---')
    expect(markdown).toContain('普通段落 & 转义')
    // script/style 移除
    const cleaned = htmlToMarkdown(
      '<div><script>alert(1)</script><style>a{}</style><p>ok</p></div>',
    )
    expect(cleaned).toContain('ok')
    expect(cleaned).not.toContain('alert')
  })

  it('空内容 → 空字符串', () => {
    expect(htmlToMarkdown('')).toBe('')
  })
})

describe('fetchChangelog（← vp-doc 区块提取）', () => {
  const PAGE = `<!DOCTYPE html><html><body><main><div class="vp-doc"><h2>v1.3.11</h2><ul><li>新增功能 A</li></ul></div></main><footer>other</footer></body></html>`

  it('提取 vp-doc 并转 markdown', async () => {
    const fetchImpl: FetchLike = async (url: string) => {
      expect(url).toBe(CHANGELOG_URL)
      return new Response(PAGE, { status: 200 })
    }
    const markdown = await fetchChangelog({ currentVersion: 'x', fetchImpl })
    expect(markdown).toContain('## v1.3.11')
    expect(markdown).toContain('- 新增功能 A')
    expect(markdown).not.toContain('other')
  })

  it('无 vp-doc / 非 200 / 网络异常 → null', async () => {
    const noVpDoc: FetchLike = async () =>
      new Response('<main><div>nothing</div></main>', { status: 200 })
    expect(await fetchChangelog({ currentVersion: 'x', fetchImpl: noVpDoc })).toBeNull()
    const status500: FetchLike = async () => new Response('', { status: 500 })
    expect(await fetchChangelog({ currentVersion: 'x', fetchImpl: status500 })).toBeNull()
    const throwing: FetchLike = async () => {
      throw new Error('down')
    }
    expect(await fetchChangelog({ currentVersion: 'x', fetchImpl: throwing })).toBeNull()
  })

  it('User-Agent 与超时信号带上', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response(PAGE, { status: 200 })) as unknown as FetchLike
    await fetchChangelog({ currentVersion: 'x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      CHANGELOG_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'SillyTavernLauncher/1.0' }),
        signal: expect.any(AbortSignal),
      }),
    )
  })
})

describe('checkNativeUpdate（@gpuix/native 延迟注入）', () => {
  it('经注入 loader 调用，版本号先 normalizeVersion', async () => {
    const checkUpdate = vi.fn(async () => ({
      currentVersion: '1.3.10',
      version: '1.3.12',
      notes: 'notes',
      date: '2026-09-01T00:00:00Z',
      downloadUrl: 'https://example.com/dl',
      format: 'nsis',
    }))
    const loader = vi.fn(async () => ({ checkUpdate }))
    const options = { endpoints: ['https://example.com/{{target}}'], pubkey: 'pk' }

    const update = await checkNativeUpdate('v1.3.10', options, loader)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(checkUpdate).toHaveBeenCalledWith('1.3.10', options)
    expect(update?.version).toBe('1.3.12')

    await checkNativeUpdate('v1.3.11测试版3', options, loader)
    expect(checkUpdate).toHaveBeenLastCalledWith('1.3.11-beta.3', options)
  })

  it('loader 抛错时向上传播（UI 层决定呈现）', async () => {
    const loader = async () => {
      throw new Error('native module unavailable in Node')
    }
    await expect(
      checkNativeUpdate('v1.3.10', { endpoints: [], pubkey: '' }, loader),
    ).rejects.toThrow('native module unavailable')
  })
})
