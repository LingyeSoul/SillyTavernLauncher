/**
 * 一次性 smoke 脚本（不属于正式用例）：验证 launch() 在 Windows 下可用。
 * 运行：bun tests/e2e/__smoke.ts
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from '@gpuix/react/automation'

const APP_ENTRY = resolve(import.meta.dir, '../..', 'app.tsx')

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), 'stl-e2e-smoke-'))
  console.log('[smoke] temp cwd:', tempDir)
  console.log('[smoke] app entry:', APP_ENTRY)

  const app = await launch({
    command: 'bun',
    args: [APP_ENTRY],
    cwd: tempDir,
    env: {
      GPUIX_BACKGROUND: '1',
      GPUIX_AUTOMATION: '1',
    },
  })
  console.log('[smoke] connected')

  const tree = await app.getByTestId('nav-terminal').waitFor({ timeoutMs: 15_000 })
  console.log('[smoke] nav-terminal found:', JSON.stringify(tree).slice(0, 200))

  const text = await app.getByTestId('welcome-question').textContent()
  console.log('[smoke] welcome question:', text)

  await app.screenshot({ path: join(import.meta.dir, '__shots__', 'smoke.png') })
  console.log('[smoke] screenshot ok')

  console.log('[smoke] temp dir contents:', readdirSync(tempDir))

  await app.close()
  console.log('[smoke] closed')
  rmSync(tempDir, { recursive: true, force: true })
  console.log('[smoke] PASS')
}

main().catch((err) => {
  console.error('[smoke] FAIL:', err)
  process.exit(1)
})
