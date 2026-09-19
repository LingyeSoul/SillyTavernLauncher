/**
 * 一次性 probe（不属于正式用例）：
 * 1) 二次 initialize 拿 pid 是否可行
 * 2) 首启时 welcome 与 EULA 谁压在上面（点击是否被遮挡）
 * 运行：bun tests/e2e/__smoke2.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from '@gpuix/react/automation'

const APP_ENTRY = resolve(import.meta.dir, '../..', 'app.tsx')

const AGREEMENT_DATE = '2099-01-01'

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), 'stl-e2e-probe-'))
  // 只种 agreement 缓存（离线可显示 EULA 正文），不种 config → 走首启
  writeFileSync(
    join(tempDir, 'agreement_cache.json'),
    JSON.stringify({ date: AGREEMENT_DATE, content: '# 使用协议 (probe)\n\n离线缓存正文。' }),
  )

  const app = await launch({
    command: 'bun',
    args: [APP_ENTRY],
    cwd: tempDir,
    env: { GPUIX_BACKGROUND: '1', GPUIX_AUTOMATION: '1' },
  })
  console.log('[probe] connected')

  const init = await app.call('initialize', { protocolVersion: 1, client: 'stl-e2e-probe' })
  console.log('[probe] pid:', init.pid, 'window:', JSON.stringify(init.window), 'caps:', init.capabilities)

  const q1 = await app.getByTestId('welcome-question').waitFor({ timeoutMs: 10_000 })
  console.log('[probe] welcome q1:', q1.text)

  const eulaAgree = await app.getByTestId('eula-agree').waitFor({ timeoutMs: 5_000 })
  console.log('[probe] eula-agree node exists; customProps:', JSON.stringify(eulaAgree.customProps))

  // 尝试直接点 welcome 的选项 + 下一题（若 EULA 压顶则被遮挡，题号不动）
  try {
    await app.getByTestId('welcome-answer-true').click()
    await app.getByTestId('welcome-next').click()
  } catch (e) {
    console.log('[probe] click welcome blocked/err:', e instanceof Error ? e.message : e)
  }
  await new Promise((r) => setTimeout(r, 800))
  const qAfter = await app.getByTestId('welcome-question').textContent()
  console.log('[probe] question after clicks:', qAfter, '=>', qAfter === q1.text ? 'BLOCKED (EULA on top)' : 'ADVANCED (welcome on top)')

  // 倒计时文本（EULA 的 setInterval）
  const countdown = await app.getByText('请仔细阅读协议内容').all()
  console.log('[probe] countdown text nodes:', countdown.length, countdown[0]?.text)

  await app.screenshot({ path: join(import.meta.dir, '__shots__', 'probe-stack.png') })
  console.log('[probe] screenshot ok')

  await app.close()
  console.log('[probe] DONE')
}

main().catch((err) => {
  console.error('[probe] FAIL:', err)
  process.exit(1)
})
