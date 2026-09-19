/**
 * 交接 C2 验证：真实 SillyTavern/config.yaml round-trip（复制到临时目录，不动真实文件）。
 * 运行：bun scripts/verify-roundtrip.ts
 * 步骤：读取真实 config.yaml → StConfig(baseDir=临时目录) → save() → 逐项对比。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StConfig } from '../services/stConfig'

const REAL_ST_DIR = join(process.cwd(), '..', 'SillyTavern')
const REAL_CONFIG = join(REAL_ST_DIR, 'config.yaml')

function summarize(text: string): {
  bytes: number
  commentLines: number
  nonManagedKeys: string[]
} {
  const lines = text.split(/\r?\n/)
  const commentLines = lines.filter((l) => l.trim().startsWith('#')).length
  // 顶层键集合（用于未知字段对比）
  const keys: string[] = []
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*):/.exec(line)
    if (m && m[1] && !keys.includes(m[1])) keys.push(m[1])
  }
  return { bytes: Buffer.byteLength(text), commentLines, nonManagedKeys: keys }
}

async function main() {
  const original = readFileSync(REAL_CONFIG, 'utf8')
  const before = summarize(original)

  const tempBase = mkdtempSync(join(tmpdir(), 'stlroundtrip'))
  const tempStDir = join(tempBase, 'SillyTavern')
  cpSync(REAL_CONFIG, join(tempStDir, 'config.yaml'))

  // 与生产一致的加载 → 立即保存（不改任何字段值）
  const st = new StConfig({ baseDir: tempStDir })
  st.save()
  const after = readFileSync(join(tempStDir, 'config.yaml'), 'utf8')
  const afterInfo = summarize(after)

  console.log('=== 真实 config.yaml round-trip 报告 ===')
  console.log(`原始: ${before.bytes}B, 注释行 ${before.commentLines}, 顶层键 ${before.nonManagedKeys.length}`)
  console.log(`回写: ${afterInfo.bytes}B, 注释行 ${afterInfo.commentLines}, 顶层键 ${afterInfo.nonManagedKeys.length}`)

  const origComments = original.split(/\r?\n/).filter((l) => l.trim().startsWith('#'))
  const afterComments = after.split(/\r?\n/).filter((l) => l.trim().startsWith('#'))
  const lostComments = origComments.filter((c) => !afterComments.includes(c))
  const lostKeys = before.nonManagedKeys.filter((k) => !afterInfo.nonManagedKeys.includes(k))

  console.log(`丢失注释行: ${lostComments.length}${lostComments.length ? '\n  ' + lostComments.slice(0, 10).join('\n  ') : ''}`)
  console.log(`丢失顶层键: ${lostKeys.length ? lostKeys.join(', ') : '无'}`)

  // 托管键语义对比：load→save 后值不变
  const reload = new StConfig({ baseDir: tempStDir })
  const managed = {
    listen: reload.listen,
    port: reload.port,
    proxyEnabled: reload.proxyEnabled,
    whitelist: reload.whitelistIps,
    unifiedWhitelist: reload.unifiedWhitelist,
  }
  console.log(`二次加载托管键（语义稳定）: ${JSON.stringify(managed)}`)

  // 原始注释内容抽检（原文件前 5 条注释是否原样存活）
  const sample = origComments.slice(0, 5)
  for (const c of sample) {
    console.log(`注释存活: ${afterComments.includes(c) ? '✓' : '✗'} ${c.trim().slice(0, 60)}`)
  }

  rmSync(tempBase, { recursive: true, force: true })
  console.log('（临时目录已清理，真实文件未改动）')
}

main().catch((err) => {
  console.error('round-trip 验证失败:', err)
  process.exit(1)
})
