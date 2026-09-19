/**
 * services/agreement 纯函数测试（vp-doc 提取链 + 版本标识解析链）。
 * fetchAgreementDocument 会写 process.cwd() 缓存，不在单测覆盖（E2E 覆盖弹窗链路）。
 */
import { describe, expect, it } from 'vitest'
import {
  contentFingerprint,
  extractAgreementMarkdown,
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
