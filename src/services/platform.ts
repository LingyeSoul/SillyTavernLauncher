/**
 * Windows 平台 hack（迁移计划 §5 / §6 平台缺口缓解）：
 * - openUrl：cmd /c start（UrlLauncher 无对应）。
 * - copyToClipboard：clip.exe（putty 式结尾回车，保证最后一行被 flush）。
 * - pickZipFile：spawn PowerShell System.Windows.Forms OpenFileDialog，返回路径或 null。
 *
 * 命令一律参数数组，不经 shell 字符串拼接（安全纪律）。
 * DEVIATION: 只读 spawn 已并轨 runtime.spawnAsync（windowsHide / 数组参数统一
 *   在 runtime.ts 实现）；仅 clip.exe 需要可写 stdin，而 spawnAsync 固定
 *   stdin:'ignore'（进程管理场景），故 stdin 场景单独实现双宿主
 *   spawn-with-stdin（Bun / node:child_process）。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { errMsg, logError } from './errorLog'
import { spawnAsync } from './runtime'

const hasBun = typeof Bun !== 'undefined'

interface StdinSpawnResult {
  exited: Promise<number>
  write(input: string): Promise<void>
}

/** 带 stdin 管道的 spawn（仅 clip.exe 使用；windowsHide 防控制台闪烁） */
function spawnWithStdin(cmd: string[]): StdinSpawnResult {
  if (hasBun) {
    const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', windowsHide: true })
    return {
      exited: proc.exited,
      write: async (input) => {
        // Bun 的 stdin 是 FileSink（无 getWriter）：write + end 冲刷
        proc.stdin.write(new TextEncoder().encode(input))
        await proc.stdin.end()
      },
    }
  }
  const child = nodeSpawn(cmd[0] ?? '', cmd.slice(1), {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? -1))
  })
  exited.catch(() => undefined)
  return {
    exited,
    write: async (input) => {
      await new Promise<void>((resolve, reject) => {
        child.stdin.on('error', reject)
        child.stdin.end(input, () => resolve())
      })
    },
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text()
  } catch {
    return ''
  }
}

/**
 * 用默认浏览器打开 URL：explorer.exe <url>。
 * 不走 cmd /c start——cmd 会把 URL 中的 & 当命令分隔符切分（downloadUrl 含查询参数时真实触发）；
 * explorer 的参数解析不切分 &，http(s) URL 自动转默认浏览器。
 * explorer.exe 启动成功也可能返回非零退出码，故只要 spawn 不抛错即视为成功。
 */
export async function openUrl(url: string): Promise<boolean> {
  try {
    const proc = spawnAsync({ cmd: ['explorer.exe', url] })
    await proc.exited.catch(() => undefined)
    return true
  } catch (err) {
    logError(`[platform] 打开 URL 失败: ${url}: ${errMsg(err)}`)
    return false
  }
}

/** 写入剪贴板：clip.exe；末尾追加换行（clip.exe 的 putty 式行为，最后一个块缺换行会丢） */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const proc = spawnWithStdin(['clip'])
    await proc.write(text.endsWith('\n') ? text : `${text}\n`)
    const code = await proc.exited
    return code === 0
  } catch (err) {
    logError(`[platform] 写剪贴板失败: ${errMsg(err)}`)
    return false
  }
}

/**
 * ZIP 文件选择（PowerShell OpenFileDialog）。
 * 返回选中文件的绝对路径；用户取消/失败返回 null。
 */export async function pickZipFile(): Promise<string | null> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    '$dlg.Filter = "ZIP 文件 (*.zip)|*.zip|所有文件 (*.*)|*.*"',
    '$dlg.Title = "选择 ZIP 文件"',
    'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  Write-Output $dlg.FileName',
    '}',
  ].join('\n')
  try {
    const proc = spawnAsync({ cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command', script] })
    const [code, stdout] = await Promise.all([proc.exited, readStream(proc.stdout)])
    if (code !== 0) return null
    const path = stdout.trim()
    return path.length > 0 ? path : null
  } catch (err) {
    logError(`[platform] 选择文件失败: ${errMsg(err)}`)
    return null
  }
}

/**
 * 启动命令行窗口（← event.py start_cmd）：cmd.exe /k + PATH 前置便携 env +
 * chcp 65001。需要新控制台窗口（detached），不收集输出。
 *
 * DEVIATION: 此处绕过 runtime.ts 直用 nodeSpawn detached——Bug#11：Bun.spawn 无
 * detached 语义（选项被静默忽略，实测 scripts/verify-detached.ts——父进程退出连带
 * 杀掉 cmd 窗口）；node:child_process 的 detached 在 Bun 运行时下同样有效，
 * 故两个运行时统一走 nodeSpawn detached。
 */
export function launchCommandLine(prependDirs: string[]): boolean {
  const newEnv: Record<string, string | undefined> = { ...process.env }
  if (prependDirs.length > 0) {
    newEnv.PATH = `${prependDirs.join(';')};${process.env.PATH ?? ''}`
  }
  const cmdExecutable =
    process.env.COMSPEC ?? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`
  try {
    const command = 'chcp 65001 >nul && echo 环境变量已设置，欢迎使用！ && cmd /k'
    nodeSpawn(
      cmdExecutable,
      ['/k', command],
      { env: newEnv, detached: true, stdio: 'ignore', windowsHide: false },
    ).unref()
    return true
  } catch (err) {
    logError(`[platform] 启动命令行失败: ${errMsg(err)}`)
    return false
  }
}
