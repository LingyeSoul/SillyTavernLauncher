/**
 * Bug#11 动态验证：Bun.spawn（无 detached 选项）启动 cmd 子进程后父进程立即退出，
 * 验证子进程是否存活。输出子进程 PID 供外部 tasklist 校验。
 *
 * 用法：bun scripts/verify-detached.ts <mode>
 *   mode = "plain"   → 复刻 launchCommandLine 的 Bun 分支（无 detached）
 *   mode = "detached" → node:child_process detached（对照组）
 *
 * 子进程用 ping -n 30 挂住（不依赖 stdin；cmd /k 在 stdin ignore 下会因 EOF 退出）。
 */
import { spawn as nodeSpawn } from 'node:child_process'

const mode = process.argv[2] ?? 'plain'
const cmdExecutable = process.env.COMSPEC ?? 'cmd.exe'
const keepAlive = ['/c', 'ping -n 30 127.0.0.1 >nul']

if (mode === 'plain') {
  const proc = Bun.spawn([cmdExecutable, ...keepAlive], {
    windowsHide: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  console.log(`PID=${proc.pid}`)
} else {
  const child = nodeSpawn(cmdExecutable, keepAlive, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  console.log(`PID=${child.pid}`)
}
process.exit(0)
