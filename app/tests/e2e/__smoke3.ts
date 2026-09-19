/**
 * 一次性 probe：确认「同意 EULA 后欢迎问答是否消失」。
 * 运行：bun tests/e2e/__smoke3.ts（约 40s，含 30s 倒计时）
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from '@gpuix/react/automation'

const HERE = import.meta.dir
const APP_ENTRY = resolve(HERE, '../..', 'app.tsx')

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), 'stl-e2e-probe3-'))
  writeFileSync(
    join(tempDir, 'agreement_cache.json'),
    JSON.stringify({ date: '2099-01-01', content: '# 使用协议（probe）\n\n离线缓存正文。' }),
  )
  // 不写 config.json → 走完整首启（welcome + eula 同时挂载）

  const app = await launch({
    command: 'bun',
    args: [APP_ENTRY],
    cwd: tempDir,
    env: { GPUIX_BACKGROUND: '1', GPUIX_AUTOMATION: '1' },
  })
  console.log('[probe3] connected')

  await app.getByTestId('welcome-question').waitFor({ timeoutMs: 10_000 })
  await app.getByTestId('eula-agree').waitFor({ timeoutMs: 5_000 })
  console.log('[probe3] both dialogs mounted')

  await app.getByText('您现在可以同意协议了').waitFor({ timeoutMs: 45_000 })
  console.log('[probe3] countdown done')

  await app.getByTestId('eula-agree').click()
  console.log('[probe3] agree clicked')

  for (let i = 0; i < 10; i++) {
    const welcome = await app.getByTestId('welcome-question').all()
    const eula = await app.getByTestId('eula-agree').all()
    const nav = await app.getByTestId('nav-terminal').all()
    const painted = await app.call('getPaintedText', {})
    console.log(
      `[probe3] t+${i * 500}ms welcome=${welcome.length} eula=${eula.length} nav=${nav.length} paintedHead=`,
      JSON.stringify(painted.text.slice(0, 6)),
    )
    if (welcome.length > 0) break
    await new Promise((r) => setTimeout(r, 500))
  }

  const cfg = existsSync(join(tempDir, 'config.json'))
    ? JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf8'))
    : null
  console.log('[probe3] config:', JSON.stringify(cfg))

  await app.screenshot({ path: join(HERE, '__shots__', 'probe3-after-agree.png') })
  console.log('[probe3] screenshot saved')

  await app.close()
}

main().catch((err) => {
  console.error('[probe3] FAIL:', err)
  process.exit(1)
})
