/**
 * 诊断脚本：关窗退出期 stderr 噪音采样（win32 + Bun 下运行，其他环境直接退出）。
 *
 * 用途：RCA"关闭窗口退出偶发报错但未捕获"。循环 N 次：
 *   隔离临时目录起真实 app（GPUIX_BACKGROUND=1 后台开窗不抢焦点）
 *   → FFI 按标题+PID 定位窗口 → 投递 WM_CLOSE 模拟用户点 X
 *   → 收集子进程完整 stderr/stdout 与退出码 → 聚合去重输出。
 *
 * 子进程环境不注入 RUST_LOG（保留 app.tsx 的生产默认静默值），
 * 采样结果即用户默认运行时真实可见的输出。
 *
 * DEVIATION: 子进程不走 services/runtime.ts——采样须持有子进程 pid/实时输出
 * 流/退出码（spawnAsync 只回缓冲结果，不满足），且为一次性诊断脚本不进产品
 * 路径（build-onefile.ts 同款偏离）；taskkill 兜底强杀显式检查 exitCode。
 *
 *   bun scripts/repro-close-noise.ts [--runs 10]
 */
import { dlopen, FFIType } from 'bun:ffi'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const WM_CLOSE = 0x0010
const WINDOW_TITLE = 'SillyTavernLauncher'
const APP_ENTRY = resolve(import.meta.dir, '..', 'app.tsx')

if (process.platform !== 'win32' || !process.versions.bun) {
  console.log('非 win32 + Bun 环境，跳过')
  process.exit(0)
}

interface ProbeUser32Symbols {
  GetTopWindow(hwnd: unknown): number
  GetWindow(hwnd: number, cmd: number): number
  GetWindowTextW(hwnd: number, buf: unknown, maxCount: number): number
  GetWindowThreadProcessId(hwnd: number, pidOut: unknown): number
  PostMessageW(hwnd: number, msg: number, wParam: bigint, lParam: bigint): number
}
const user32 = dlopen('user32.dll', {
  GetTopWindow: { args: [FFIType.pointer], returns: FFIType.pointer },
  GetWindow: { args: [FFIType.pointer, FFIType.u32], returns: FFIType.pointer },
  GetWindowTextW: { args: [FFIType.pointer, FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
  GetWindowThreadProcessId: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u32 },
  PostMessageW: { args: [FFIType.pointer, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
}).symbols as unknown as ProbeUser32Symbols

/** 与 services/windowIcon 同款的 标题+PID 双匹配枚举（跨进程读标题安全） */
function findWindowByTitleAndPid(title: string, pid: number): number {
  let hwnd = user32.GetTopWindow(0n)
  let guard = 0
  while (hwnd !== 0 && guard++ < 2000) {
    const pidOut = new Uint32Array(1)
    user32.GetWindowThreadProcessId(hwnd, pidOut)
    if (pidOut[0] === pid) {
      const buf = Buffer.alloc(512)
      const len = user32.GetWindowTextW(hwnd, buf, 256)
      if (buf.toString('utf16le', 0, Math.max(0, len) * 2) === title) return hwnd
    }
    hwnd = user32.GetWindow(hwnd, 2 /* GW_HWNDNEXT */)
  }
  return 0
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 兜底强杀：taskkill 失败只告警不中断采样（进程可能已自行退出） */
function forceKill(pid: number): void {
  const result = Bun.spawnSync(['taskkill', '/pid', String(pid), '/T', '/F'])
  if (result.exitCode !== 0) {
    console.warn(`taskkill /pid ${pid} 失败 exit=${result.exitCode}（进程可能已退出）`)
  }
}

interface RunResult {
  run: number
  outcome: 'closed' | 'no-window' | 'exit-timeout'
  exitCode: number | null
  stderr: string
  stdout: string
  /** 子进程 logs/Error_*.txt 内容（crashGuard 落盘验证；无则为空数组） */
  errorLogFiles: string[]
}

async function drainStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(decoder.decode(value, { stream: true }))
    }
  } catch {
    // 流随进程死亡关闭
  }
  return chunks.join('')
}

async function runOnce(run: number): Promise<RunResult> {
  // 与 E2E setupCompleted 种子同构：跳过首启弹窗、禁远端核对与更新检查
  const tempDir = mkdtempSync(join(tmpdir(), 'stlrepro'))
  writeFileSync(
    join(tempDir, 'agreement_cache.json'),
    JSON.stringify({ date: '2099-01-01', content: '# 采样种子' }),
  )
  writeFileSync(
    join(tempDir, 'config.json'),
    JSON.stringify(
      {
        patchgit: false,
        env_mode: 'system',
        theme: 'dark',
        first_run: false,
        agreement_accepted: true,
        agreement_version: '2099-01-01',
        downloads: [],
        has_started_st: false,
        github: { mirror: 'github', mirrors: { github: 'github.com', ghproxy: 'gh-proxy.org', ghllkk: 'gh.llkk.cc' } },
        log: false,
        checkupdate: false,
        stcheckupdate: false,
        tray: false,
        autostart: false,
        auto_proxy: false,
        custom_args: '',
        use_optimize_args: false,
        sync: { first_shown: true, enabled: false, port: 9999, host: '127.0.0.1' },
      },
      null,
      4,
    ),
  )

  const proc = Bun.spawn(['bun', APP_ENTRY], {
    cwd: tempDir,
    env: { ...process.env, GPUIX_BACKGROUND: '1', STL_SKIP_AGREEMENT_RECHECK: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdoutDone = drainStream(proc.stdout as ReadableStream<Uint8Array>)
  const stderrDone = drainStream(proc.stderr as ReadableStream<Uint8Array>)
  const pid = proc.pid

  // 等窗口创建（render 同步建窗，留启动裕量）
  let hwnd = 0
  for (let i = 0; i < 90 && hwnd === 0 && pidAlive(pid); i++) {
    hwnd = findWindowByTitleAndPid(WINDOW_TITLE, pid)
    if (hwnd === 0) await sleep(500)
  }

  let outcome: RunResult['outcome'] = 'closed'
  if (hwnd === 0) {
    outcome = 'no-window'
    forceKill(pid)
  } else {
    user32.PostMessageW(hwnd, WM_CLOSE, 0n, 0n)
    // 关窗后应数秒内退出
    for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(250)
    if (pidAlive(pid)) {
      outcome = 'exit-timeout'
      forceKill(pid)
    }
  }

  const [stdout, stderr] = await Promise.all([stdoutDone, stderrDone])
  const exitCode = outcome === 'closed' ? (await proc.exited) : null
  // 读取 crashGuard 落盘的错误文件后再清理临时目录
  const errorLogFiles: string[] = []
  const logsDir = join(tempDir, 'logs')
  if (existsSync(logsDir)) {
    for (const f of readdirSync(logsDir)) errorLogFiles.push(readFileSync(join(logsDir, f), 'utf8'))
  }
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
      break
    } catch {
      await sleep(200)
    }
  }
  return { run, outcome, exitCode, stderr, stdout, errorLogFiles }
}

const runsIdx = process.argv.indexOf('--runs')
const RUNS = runsIdx > 0 ? Math.max(1, Number(process.argv[runsIdx + 1]) || 10) : 10

console.log(`采样 ${RUNS} 次关窗退出（GPUIX_BACKGROUND 后台窗口）...`)
const results: RunResult[] = []
for (let i = 1; i <= RUNS; i++) {
  const r = await runOnce(i)
  results.push(r)
  const errLines = r.stderr.split('\n').filter((l) => l.trim()).length
  console.log(
    `  #${r.run} ${r.outcome} exit=${r.exitCode ?? '-'} stderrLines=${errLines}` +
      (r.outcome !== 'closed' ? '  <-- 异常结局' : ''),
  )
}

// 聚合去重：跨 run 相同输出行归并（去掉 run 间必然差异，如时间戳/PID）
const aggregate = new Map<string, { count: number; runs: number[] }>()
for (const r of results) {
  const lines = [...r.stderr.split('\n'), ...r.stdout.split('\n')].filter((l) => l.trim())
  const normalized = lines.map((l) => r.outcome + ' | ' + l.trim())
  const distinct = [...new Set(normalized)]
  for (const line of distinct) {
    const entry = aggregate.get(line) ?? { count: 0, runs: [] }
    entry.count += 1
    entry.runs.push(r.run)
    aggregate.set(line, entry)
  }
}

console.log('\n=== 聚合输出（行 -> 出现 run 数）===')
for (const [line, info] of [...aggregate.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`[${info.count}/${RUNS}] runs=${info.runs.join(',')}`)
  console.log(`  ${line}`)
}
const abnormal = results.filter((r) => r.outcome !== 'closed' || (r.exitCode !== null && r.exitCode !== 0))
console.log(`\n异常结局（非 closed 或非零退出码）：${abnormal.length}/${RUNS}`)

// crashGuard 落盘验证：stderr 有报错 ≠ Error_*.txt 有记录——已知退出期噪音
//（GPUI UI thread，见 services/crashGuard.ts isShutdownNoise）被过滤不落盘；
// 非噪音报错的 run 才应有对应记录
const withStderrNoise = results.filter((r) => r.stderr.includes('error') || r.stderr.includes('Error'))
const withLogFile = results.filter((r) => r.errorLogFiles.length > 0)
console.log(`stderr 含报错的 run：${withStderrNoise.map((r) => r.run).join(',') || '无'}`)
console.log(`logs/Error_*.txt 落盘的 run：${withLogFile.map((r) => r.run).join(',') || '无'}`)
for (const r of withLogFile) {
  console.log(`--- run #${r.run} Error_*.txt ---`)
  console.log(r.errorLogFiles.join('\n').trimEnd())
}
