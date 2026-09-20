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
import { errMsg, logError } from './errorLog'
import { htmlToMarkdown, type FetchLike } from './updater'

export const AGREEMENT_URL = 'https://sillytavern.lingyesoul.top/agreement'
export const AGREEMENT_CACHE_FILE = 'agreement_cache.json'

/** 网络容错：失败自动重试次数与退避基数（1s→2s→4s 指数退避，总尝试 1+3 次） */
const AGREEMENT_RETRIES = 3
const AGREEMENT_RETRY_BASE_DELAY_MS = 1_000

export interface FetchAgreementOptions {
  fetchImpl?: FetchLike
  /** 失败后的自动重试次数，默认 3 */
  retries?: number
  /** 重试退避基数（毫秒），默认 1000；测试传 0 跳过等待 */
  baseDelayMs?: number
  /** 缓存写入目录，默认 process.cwd()（测试注入临时目录避免污染仓库） */
  cacheDir?: string
}

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

/** 单次抓取 + 解析 + 缓存（重试的最小单元） */
async function fetchAgreementOnce(
  fetchImpl: FetchLike,
  cacheDir: string,
): Promise<AgreementDocument> {
  const response = await fetchImpl(AGREEMENT_URL, {
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
      join(cacheDir, AGREEMENT_CACHE_FILE),
      JSON.stringify({ date, content: parsed.content }),
    )
  } catch (err) {
    logError(`[agreement] 缓存协议失败: ${errMsg(err)}`)
  }
  return { date, content: parsed.content }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 抓取并解析远端协议文档；失败自动重试（默认 3 次，指数退避），重试耗尽抛出
 * 最后一次错误（由调用方决定降级行为）。网络异常 / 非 200 / 解析失败均触发重试
 * ——网关错误页与截断响应同样表现为后两者。
 * 成功时同步刷新本地缓存（date 与缓存版本存同一值，避免两处取值不一致重弹）。
 */
export async function fetchAgreementDocument(
  options: FetchAgreementOptions = {},
): Promise<AgreementDocument | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const retries = options.retries ?? AGREEMENT_RETRIES
  const baseDelayMs = options.baseDelayMs ?? AGREEMENT_RETRY_BASE_DELAY_MS
  const cacheDir = options.cacheDir ?? process.cwd()

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchAgreementOnce(fetchImpl, cacheDir)
    } catch (err) {
      if (attempt >= retries) throw err
      const delayMs = baseDelayMs * 2 ** attempt
      console.warn(
        `[agreement] 获取协议失败（第 ${attempt + 1}/${retries + 1} 次尝试）：` +
          `${err instanceof Error ? err.message : String(err)}，${delayMs}ms 后自动重试`,
      )
      await sleep(delayMs)
    }
  }
}
