/**
 * services/agreement 纯函数测试（vp-doc 提取链 + 版本标识解析链）
 * + fetchAgreementDocument 重试行为（注入 fetchImpl / 临时 cacheDir，不污染仓库）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../services/updater'
import {
  AGREEMENT_CACHE_FILE,
  contentFingerprint,
  extractAgreementMarkdown,
  fetchAgreementDocument,
  resolveAgreementVersion,
} from '../services/agreement'

describe('agreement 解析（← fetcher 提取链）', () => {
  const page = (date: string) =>
    `<html><main><div class="vp-doc"><div><h1>使用协议 ${date}</h1><p>条款内容</p></div></div></main></html>`

  it('vp-doc 区块提取 + 标题日期识别', () => {
    const parsed = extractAgreementMarkdown(page('2026-09-01'))
    expect(parsed).not.toBeNull()
    expect(parsed?.date).toBe('2026-09-01')
    expect(parsed?.content).toContain('条款内容')
  })

  it('无 vp-doc 区块 → null', () => {
    expect(extractAgreementMarkdown('<html><body>no content</body></html>')).toBeNull()
  })

  it('版本解析链：标题日期优先，缺失时回退内容指纹（Bug#4 复用的判定基础）', () => {
    const parsed = extractAgreementMarkdown(page('2026-09-01'))
    expect(parsed).not.toBeNull()
    expect(resolveAgreementVersion(page('2026-09-01'), parsed as never)).toBe('2026-09-01')

    const noDate = extractAgreementMarkdown(
      '<html><main><div class="vp-doc"><div><h1>协议</h1><p>x</p></div></div></main></html>',
    )
    expect(noDate).not.toBeNull()
    expect(resolveAgreementVersion('', noDate as never)).toMatch(/^content-[0-9a-f]{8}$/)
  })

  it('内容指纹对内容敏感且稳定', () => {
    expect(contentFingerprint('a')).not.toBe(contentFingerprint('b'))
    expect(contentFingerprint('a')).toBe(contentFingerprint('a'))
  })
})

describe('fetchAgreementDocument 自动重试', () => {
  const dirs: string[] = []

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  const newCacheDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'stl-agreement-'))
    dirs.push(dir)
    return dir
  }

  const okHtml =
    '<html><main><div class="vp-doc"><div><h1>使用协议 2026-09-01</h1><p>条款内容</p></div></div></main></html>'

  const retryOpts = (fetchImpl: FetchLike) => ({
    fetchImpl,
    retries: 3,
    baseDelayMs: 0,
    cacheDir: newCacheDir(),
  })

  it('前两次网络异常，第 3 次成功 → 返回文档并写缓存', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response(okHtml, { status: 200 })) as unknown as FetchLike
    const doc = await fetchAgreementDocument(retryOpts(fetchImpl))
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(doc?.date).toBe('2026-09-01')
    const cache = JSON.parse(
      readFileSync(join(dirs[dirs.length - 1] ?? '', AGREEMENT_CACHE_FILE), 'utf8'),
    ) as { date: string; content: string }
    expect(cache.date).toBe('2026-09-01')
    expect(cache.content).toContain('条款内容')
  })

  it('重试耗尽（1+3 次）→ 抛最后一次错误', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down')) as unknown as FetchLike
    await expect(fetchAgreementDocument(retryOpts(fetchImpl))).rejects.toThrow('network down')
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('非 200 与解析失败同样触发重试', async () => {
    const badStatus = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 502 }))
      .mockResolvedValueOnce(new Response('<html><body>网关错误页</body></html>', { status: 200 }))
      .mockResolvedValueOnce(new Response(okHtml, { status: 200 })) as unknown as FetchLike
    const doc = await fetchAgreementDocument(retryOpts(badStatus))
    expect(badStatus).toHaveBeenCalledTimes(3)
    expect(doc?.date).toBe('2026-09-01')
  })
})
