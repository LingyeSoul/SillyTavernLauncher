/**
 * ← src/features/agreement/fetcher.py 的精简版（原内置在 EulaDialog，
 * 提升为服务供 StartupFlow 的后台版本核对复用，语义对齐 main.py:42-78）。
 *
 * - fetch 协议页 + vp-doc 区块提取 + htmlToMarkdown（复用 updater 转换器）。
 * - agreement_cache.json 本地缓存（atomicFs 原子写）。
 * - 版本标识解析链：页面日期 → meta date → 内容指纹（FNV-1a）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomicFs'
import { htmlToMarkdown } from './updater'

export const AGREEMENT_URL = 'https://sillytavern.lingyesoul.top/agreement'
export const AGREEMENT_CACHE_FILE = 'agreement_cache.json'

export interface AgreementDocument {
  date: string
  content: string
}

export function loadAgreementCache(): AgreementDocument | null {
  const cachePath = join(process.cwd(), AGREEMENT_CACHE_FILE)
  if (!existsSync(cachePath)) return null
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<AgreementDocument>
    if (typeof data.date === 'string' && typeof data.content === 'string') {
      return { date: data.date, content: data.content }
    }
    return null
  } catch {
    return null
  }
}

/** 内容指纹（FNV-1a，8 位 hex）：页面无日期标记时的版本兜底——协议内容变化即触发重弹 */
export function contentFingerprint(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `content-${hash.toString(16).padStart(8, '0')}`
}

/** vp-doc 区块提取 + Markdown 转换（← fetcher 的提取链，复用 updater 的转换器） */
export function extractAgreementMarkdown(html: string): AgreementDocument | null {
  const vpDocStart = html.indexOf('class="vp-doc')
  if (vpDocStart === -1) return null
  const divStart = html.lastIndexOf('<div', vpDocStart)
  const mainEnd = html.indexOf('</main>', divStart)
  if (mainEnd === -1) return null
  const firstGt = html.indexOf('>', divStart) + 1
  const extracted = html.slice(firstGt, mainEnd)
  const markdown = htmlToMarkdown(extracted)
  if (!markdown) return null
  const h1 = /^#\s+(.+)$/m.exec(markdown)
  const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(h1?.[1] ?? markdown.slice(0, 200))
  return { date: dateMatch?.[1] ?? '', content: markdown }
}

function fetchDate(html: string): string {
  const meta = /<meta[^>]+name="date"[^>]+content="([^"]+)"/i.exec(html)
  return meta?.[1] ?? ''
}

/** 版本标识解析链：页面日期 → meta date → 内容指纹（保证非空且内容敏感） */
export function resolveAgreementVersion(html: string, parsed: AgreementDocument): string {
  return parsed.date || fetchDate(html) || contentFingerprint(parsed.content)
}

/**
 * 抓取并解析远端协议文档；失败抛错（由调用方决定降级行为）。
 * 成功时同步刷新本地缓存（date 与缓存版本存同一值，避免两处取值不一致重弹）。
 */
export async function fetchAgreementDocument(): Promise<AgreementDocument | null> {
  const response = await fetch(AGREEMENT_URL, {
    headers: { 'User-Agent': 'SillyTavernLauncher/2.0' },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
  const html = await response.text()
  const parsed = extractAgreementMarkdown(html)
  if (!parsed) throw new Error('未找到协议内容区块')
  const date = resolveAgreementVersion(html, parsed)
  try {
    atomicWriteFileSync(
      join(process.cwd(), AGREEMENT_CACHE_FILE),
      JSON.stringify({ date, content: parsed.content }),
    )
  } catch (err) {
    console.error(`[agreement] 缓存协议失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { date, content: parsed.content }
}
