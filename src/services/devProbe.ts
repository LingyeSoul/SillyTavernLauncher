/**
 * 滚动链路探针（仅测试取证，env 门控 STL_SCROLL_PROBE=1）：
 * 追加写 cwd/scroll-probe.log（E2E 临时目录），绝不走 console——自动化会话的
 * stdout 是 stdio 协议通道，混入自由文本会破坏协议帧。
 * 探针自身失败静默（DEVIATION：诊断通道不应影响被测进程稳定性，与
 * errorLog 的"严禁吞噬"口径区分——它不是业务错误处理路径）。
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const ENABLED = process.env.STL_SCROLL_PROBE === '1'

export function probeScroll(line: string): void {
  if (!ENABLED) return
  try {
    appendFileSync(
      join(process.cwd(), 'scroll-probe.log'),
      `${Date.now()} ${line}\n`,
      'utf8',
    )
  } catch {
    // 见文件头：诊断通道失败静默
  }
}
