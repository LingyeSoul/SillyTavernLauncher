/**
 * 校验脚本：自动启动静默模式（autostart_hidden）真窗取证（win32 + Bun，其他环境跳过）。
 *
 *   bun scripts/verify-silent-start.ts
 *
 * 为什么不用 E2E：静默启动的核心断言是"主窗口的 OS 级可见性"与"explorer →
 * 托盘隐藏窗的唤回消息路由"，@gpuix/react/automation 的进程内合成事件两边都
 * 覆盖不到；口径照 verify-tray：spawn 真实应用 + FFI 断言真窗口行为。
 *
 * 阶段 A（正向：静默生效）——种子 autostart + autostart_hidden + tray 三键齐：
 *   ① 托盘 helper 窗挂载；
 *   ② 主窗口在时限内隐藏（IsWindowVisible=0）——启动判定 + 托盘挂载成功门；
 *   ③ 隐藏期进程存活且无 bounds 查询/crashGuard 噪音（冻结门检回归）；
 *   ④ PostMessage 模拟托盘左键回调 → 主窗口唤回（IsWindowVisible≠0）；
 *   ⑤ WM_CLOSE 干净退出。
 *   注：STL_SKIP_AUTOSTART=1 禁用自动启动酒馆本身（防临时目录真跑安装链路），
 *   静默隐藏判定独立于 startSt，不受该门影响。
 *
 * 阶段 B（负向：fail-safe）——种子 autostart + autostart_hidden 但 tray:false：
 *   ⑥ 主窗口保持可见（托盘没挂上就藏窗 = 用户失去唯一唤回入口，宁可亮着）。
 */
import { dlopen, FFIType } from 'bun:ffi'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findWindowByTitleAndPid } from '../services/windowIcon'
import { TRAY_CALLBACK_MESSAGE, TRAY_WINDOW_CLASS } from '../services/tray'

if (process.platform !== 'win32' || !process.versions.bun) {
  console.log('非 win32 + Bun 环境，跳过')
  process.exit(0)
}

const APP_TITLE = 'SillyTavernLauncher'
const WM_CLOSE = 0x0010
const WM_LBUTTONUP = 0x0202

interface User32Symbols {
  FindWindowW(className: unknown, windowName: bigint): bigint
  GetWindowThreadProcessId(hwnd: bigint, pidOut: Uint32Array): number
  IsWindowVisible(hwnd: bigint): number
  PostMessageW(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): number
}

const user32 = dlopen('user32.dll', {
  FindWindowW: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u64 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.u32 },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
  PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
}).symbols as unknown as User32Symbols

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function utf16z(text: string): Buffer {
  const buf = Buffer.alloc((text.length + 1) * 2)
  for (let i = 0; i < text.length; i++) buf.writeUInt16LE(text.charCodeAt(i), i * 2)
  return buf
}

/** 托盘 helper 窗定位 + PID 归属校验（verify-tray 同款：撞别家实例直接报失败） */
function findHelperWindowByClass(expectPid: number): bigint {
  const hwnd = user32.FindWindowW(utf16z(TRAY_WINDOW_CLASS), 0n)
  if (hwnd === 0n) return 0n
  const pidOut = new Uint32Array(1)
  user32.GetWindowThreadProcessId(hwnd, pidOut)
  if (pidOut[0] !== expectPid) {
    throw new Error(`类名 ${TRAY_WINDOW_CLASS} 命中他进程窗口（pid=${pidOut[0]}，期望 ${expectPid}）——请先退出开启了托盘的其他启动器实例`)
  }
  return hwnd
}

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}：${detail}`)
  if (!ok) failures++
}

/** 隐藏期输出扫描：命中崩溃噪音返回首个片段，干净返回 null（verify-tray 同款） */
function scanFreezeNoise(): string | null {
  for (const marker of ['uncaughtException', 'Timed out after 2 seconds', 'getElementBounds', 'crashGuard']) {
    const at = appOutput.indexOf(marker)
    if (at >= 0) return `输出含「${marker}」：${appOutput.slice(Math.max(0, at - 40), at + 80).trim()}`
  }
  return null
}

interface RunningApp {
  proc: ReturnType<typeof spawn>
  pid: number
  dir: string
}

let appOutput = ''

/** 启动被测应用（种子：三键齐 + 跳过首启/协议弹窗；直接 spawn bun 拿真 pid） */
async function startApp(tray: boolean): Promise<RunningApp> {
  appOutput = ''
  const dir = mkdtempSync(join(tmpdir(), 'stl-silent-verify'))
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      {
        first_run: false,
        agreement_accepted: true,
        agreement_version: '2099-01-01',
        checkupdate: false,
        stcheckupdate: false,
        autostart: true,
        autostart_hidden: true,
        auto_proxy: false,
        tray,
        theme: 'dark',
        github: { enabled: false, mirror: '', auto: true, speedtest: { results: {}, failed: [], tested_at: '' } },
      },
      null,
      4,
    ),
  )
  writeFileSync(join(dir, 'agreement_cache.json'), JSON.stringify({ date: '2099-01-01', content: '# 离线种子' }))

  const proc = spawn('bun', [resolve(import.meta.dir, '..', 'app.tsx')], {
    cwd: dir,
    env: {
      ...process.env,
      STL_SKIP_AGREEMENT_RECHECK: '1',
      STL_SKIP_MIRROR_AUTOSELECT: '1',
      STL_SKIP_AUTOSTART: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = proc.pid ?? 0
  if (pid === 0) throw new Error('子进程启动失败（无 pid）')
  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    process.stdout.write(`  [app] ${text}\n`)
    appOutput += text + '\n'
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    process.stdout.write(`  [app:err] ${text}\n`)
    appOutput += text + '\n'
  })
  return { proc, pid, dir }
}

async function waitForWindow(pid: number, timeoutMs: number): Promise<bigint> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hwnd = await findWindowByTitleAndPid(APP_TITLE, pid)
    if (hwnd !== 0) return BigInt(hwnd)
    await sleep(200)
  }
  return 0n
}

async function disposeApp(instance: RunningApp): Promise<void> {
  if (instance.proc.exitCode === null && instance.proc.signalCode === null) {
    user32.PostMessageW(await waitForWindow(instance.pid, 1000), WM_CLOSE, 0n, 0n)
    for (let i = 0; i < 10; i++) {
      if (instance.proc.exitCode !== null || instance.proc.signalCode !== null) break
      await sleep(300)
    }
    if (instance.proc.exitCode === null && instance.proc.signalCode === null) {
      spawn('taskkill', ['/PID', String(instance.pid), '/T', '/F'], { stdio: 'ignore' })
    }
  }
  await sleep(800)
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(instance.dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(300)
    }
  }
}

let running: RunningApp | null = null

try {
  // =====================================================================
  // 阶段 A：正向（tray:true 种子 → 静默隐藏 + 托盘唤回）
  // =====================================================================
  console.log('— 阶段 A：静默启动（autostart + autostart_hidden + tray）—')
  running = await startApp(true)
  const hwnd = await waitForWindow(running.pid, 45_000)
  if (hwnd === 0n) throw new Error('未找到被测主窗口（45s 超时）')

  // 托盘初始化与应用 mount 并行：helper 窗是异步挂载的，轮询等待（一次性
  // FindWindowW 会撞上"窗口刚建、托盘未挂"的竞态——首跑实锤）
  let helper = 0n
  for (let i = 0; i < 50 && helper === 0n; i++) {
    await sleep(200)
    helper = findHelperWindowByClass(running.pid)
  }
  check('托盘 helper 窗已挂载', helper !== 0n, `hwnd=${helper}`)

  let hidden = false
  for (let i = 0; i < 75 && !hidden; i++) {
    await sleep(200)
    hidden = user32.IsWindowVisible(hwnd) === 0
  }
  check('主窗口静默隐藏（IsWindowVisible=0）', hidden, `IsWindowVisible=${user32.IsWindowVisible(hwnd)}`)

  await sleep(5000) // 隐藏期观察：存活 + 无 bounds 查询噪音（冻结门检回归）
  const alive = running.proc.exitCode === null && running.proc.signalCode === null
  const noise = scanFreezeNoise()
  check('隐藏期进程存活且无崩溃噪音', alive && noise === null, noise ?? `进程存活=${alive}，输出干净`)

  if (helper !== 0n) {
    user32.PostMessageW(helper, TRAY_CALLBACK_MESSAGE, 1n, BigInt(WM_LBUTTONUP))
    let restored = false
    for (let i = 0; i < 25 && !restored; i++) {
      await sleep(200)
      restored = user32.IsWindowVisible(hwnd) !== 0
    }
    check('托盘左键唤回主窗口', restored, `IsWindowVisible=${user32.IsWindowVisible(hwnd)}`)
  }

  user32.PostMessageW(hwnd, WM_CLOSE, 0n, 0n)
  let exited = false
  for (let i = 0; i < 40 && !exited; i++) {
    await sleep(250)
    exited = running.proc.exitCode !== null || running.proc.signalCode !== null
  }
  check('WM_CLOSE 干净退出进程', exited, `exitCode=${running.proc.exitCode}`)
  await disposeApp(running)
  running = null

  // =====================================================================
  // 阶段 B：负向 fail-safe（tray:false 种子 → 窗口不得隐藏）
  // =====================================================================
  console.log('\n— 阶段 B：fail-safe（autostart_hidden 开但 tray 关）—')
  running = await startApp(false)
  const hwndB = await waitForWindow(running.pid, 45_000)
  if (hwndB === 0n) throw new Error('未找到被测主窗口（45s 超时）')
  await sleep(4000) // 留足"若隐藏逻辑误触发"的时间窗
  const visible = user32.IsWindowVisible(hwndB) !== 0
  const noHelper = findHelperWindowByClass(running.pid) === 0n
  check('托盘未挂载（tray:false）', noHelper, 'helper 窗不存在')
  check('主窗口保持可见（藏死防护）', visible, `IsWindowVisible=${user32.IsWindowVisible(hwndB)}`)

  await disposeApp(running)
  running = null
} catch (err) {
  failures++
  console.error(`FAIL  脚本异常：${err instanceof Error ? err.message : String(err)}`)
} finally {
  const leftover: RunningApp | null = running
  if (leftover) await disposeApp(leftover)
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
