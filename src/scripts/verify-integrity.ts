/**
 * 取证：输出当前进程的 Windows 完整性级别（TokenIntegrityLevel）。
 *
 * 用法：bun scripts/verify-integrity.ts [expected]
 * - 正常宿主（Medium/High 终端）→ medium/high
 * - 低标签复现（2026-11 报障链路检测端）：把 bun.exe 复制到临时目录，
 *   `icacls <copy> /setintegritylevel Low`，用该副本运行本脚本 → low。
 * 传 expected 时不一致以 exit 1 失败（自动化断言用）。
 */
import { currentProcessIntegrityLevel } from '../services/integrityLevel'

async function main(): Promise<void> {
  const expected = process.argv[2]
  const level = await currentProcessIntegrityLevel()
  console.log(`当前进程完整性级别：${level}`)
  if (expected !== undefined && level !== expected) {
    console.error(`✘ 期望 ${expected}，实际 ${level}`)
    process.exit(1)
  }
  if (expected !== undefined) console.log(`✔ 完整性级别符合期望：${expected}`)
}

main().catch((err) => {
  console.error(`✘ 完整性级别探测失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})