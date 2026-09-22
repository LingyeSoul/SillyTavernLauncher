/**
 * 真窗取证脚本共用台架（verify-titlebar-drag / verify-tray / verify-silent-start）。
 *
 * 收敛原因（2026-09-23 代码审查 S1）：三脚本曾各持一份同型台架（约 150-200 行 ×3），
 * 且已出现漂移——mouseInput 一处写全字段、一处只写 flags（Buffer.alloc 全零起步
 * 恰好兜住，属侥幸而非契约）。共用的是台架，不是断言：拖动几何、菜单内容、静默
 * 判定等脚本专属逻辑留在各自脚本。
 *
 * 内容：
 * - 平台门：非 win32 + Bun 直接退出。**必须**位于本模块顶层 dlopen 之前——
 *   脚本 import 本模块即受保护（脚本自身的门去掉后，这里是唯一防线）；
 * - user32 符号集：三脚本所需符号的并集，单次 dlopen；
 * - 真实输入台架：mouseInput（全字段）/ sendMouse / clickAt（SendInput）；
 * - 被测应用生命周期：startApp（种子 config）/ waitForWindow / bringUp /
 *   disposeApp（WM_CLOSE 优先、taskkill 兜底）；
 * - 断言收集：check / reportScriptError / verifyFailureCount；
 * - 输出汇聚与冻结期噪音扫描：resetAppOutput / scanFreezeNoise。
 */
import { dlopen, FFIType } from 'bun:ffi'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findWindowByTitleAndPid } from '../services/windowIcon'
import { TRAY_WINDOW_CLASS } from '../services/tray'

if (process.platform !== 'win32' || !process.versions.bun) {
  console.log('非 win32 + Bun 环境，跳过')
  process.exit(0)
}

/** app.tsx WINDOW_OPTIONS.title（窗口定位的标题匹配键） */
export const APP_TITLE = 'SillyTavernLauncher'

// —— Win32 常量（脚本侧消费的子集；其余为台架内部使用）——
export const WM_NULL = 0x0000
export const WM_CLOSE = 0x0010
export const WM_SYSCOMMAND = 0x0112
export const SC_MINIMIZE = 0xf020
export const WM_LBUTTONUP = 0x0202
export const SW_SHOW = 5
export const SW_RESTORE = 9
export const SWP_NOSIZE = 0x0001
export const SWP_NOMOVE = 0x0002
export const SWP_NOACTIVATE = 0x0010
export const HWND_TOP = 0n
export const INPUT_MOUSE = 0
export const MOUSEEVENTF_LEFTDOWN = 0x0002
export const MOUSEEVENTF_LEFTUP = 0x0004
export const MF_BYPOSITION = 0x400

export interface VerifyUser32 {
  FindWindowW(className: unknown, windowName: bigint): bigint
  GetWindowThreadProcessId(hwnd: bigint, pidOut: Uint32Array): number
  GetWindowRect(hwnd: bigint, rectOut: Int32Array): number
  GetClientRect(hwnd: bigint, rectOut: Int32Array): number
  ClientToScreen(hwnd: bigint, pointOut: Int32Array): number
  SetCursorPos(x: number, y: number): number
  SendInput(count: number, inputs: Buffer, size: number): number
  IsWindow(hwnd: bigint): number
  IsWindowVisible(hwnd: bigint): number
  IsIconic(hwnd: bigint): number
  ShowWindow(hwnd: bigint, cmd: number): number
  SetWindowPos(hwnd: bigint, insertAfter: bigint, x: number, y: number, cx: number, cy: number, flags: number): number
  GetForegroundWindow(): bigint
  SetForegroundWindow(hwnd: bigint): number
  PostMessageW(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): number
  GetMenuItemCount(menu: bigint): number
  GetMenuItemID(menu: bigint, pos: number): number
  GetMenuState(menu: bigint, pos: number, flags: number): number
  GetMenuStringW(menu: bigint, pos: number, buf: unknown, max: number, flags: number): number
  DestroyMenu(menu: bigint): number
}

/** 三脚本所需 user32 符号的并集（单次 dlopen，脚本不再各自开） */
export const user32: VerifyUser32 = dlopen('user32.dll', {
  FindWindowW: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u64 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.u32 },
  GetWindowRect: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
  GetClientRect: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
  ClientToScreen: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
  SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  SendInput: { args: [FFIType.u32, FFIType.pointer, FFIType.i32], returns: FFIType.u32 },
  IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
  IsIconic: { args: [FFIType.u64], returns: FFIType.i32 },
  ShowWindow: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
  SetWindowPos: { args: [FFIType.u64, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
  GetMenuItemCount: { args: [FFIType.u64], returns: FFIType.i32 },
  GetMenuItemID: { args: [FFIType.u64, FFIType.i32], returns: FFIType.u32 },
  GetMenuState: { args: [FFIType.u64, FFIType.i32, FFIType.u32], returns: FFIType.u32 },
  GetMenuStringW: { args: [FFIType.u64, FFIType.i32, FFIType.pointer, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  DestroyMenu: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols as unknown as VerifyUser32

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function utf16z(text: string): Buffer {
  const buf = Buffer.alloc((text.length + 1) * 2)
  for (let i = 0; i < text.length; i++) buf.writeUInt16LE(text.charCodeAt(i), i * 2)
  return buf
}

/** 按类名找托盘 helper 窗并校验归属进程（防止抓到别家实例——托盘默认关，仅用户
 *  手动开启的常驻启动器可能撞名；撞上直接报失败而非误判） */
export function findHelperWindowByClass(expectPid: number): bigint {
  const hwnd = user32.FindWindowW(utf16z(TRAY_WINDOW_CLASS), 0n)
  if (hwnd === 0n) return 0n
  const pidOut = new Uint32Array(1)
  user32.GetWindowThreadProcessId(hwnd, pidOut)
  if (pidOut[0] !== expectPid) {
    throw new Error(`类名 ${TRAY_WINDOW_CLASS} 命中他进程窗口（pid=${pidOut[0]}，期望 ${expectPid}）——请先退出开启了托盘的其他启动器实例`)
  }
  return hwnd
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export function readWindowRect(hwnd: bigint): Rect {
  const rect = new Int32Array(4)
  if (user32.GetWindowRect(hwnd, rect) === 0) throw new Error('GetWindowRect 失败')
  return { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }
}

/** 客户区原点（0,0）在屏幕坐标下的位置：窗口外框含 DWM 隐形边，按钮落点必须由它换算 */
export function readClientOrigin(hwnd: bigint): { x: number; y: number } {
  const pt = new Int32Array([0, 0])
  if (user32.ClientToScreen(hwnd, pt) === 0) throw new Error('ClientToScreen 失败')
  return { x: pt[0], y: pt[1] }
}

export function readClientRect(hwnd: bigint): Rect {
  const rect = new Int32Array(4)
  if (user32.GetClientRect(hwnd, rect) === 0) throw new Error('GetClientRect 失败')
  return { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }
}

/** x64 INPUT 结构（40 字节）：type 在 0，MOUSEINPUT 从 8 开始，dwFlags 在 20。
 *  全字段显式写零（勿只写 flags——Buffer.alloc 兜住是侥幸，契约在此）。 */
export function mouseInput(flags: number): Buffer {
  const buf = Buffer.alloc(40)
  buf.writeUInt32LE(INPUT_MOUSE, 0)
  buf.writeInt32LE(0, 8) // dx
  buf.writeInt32LE(0, 12) // dy
  buf.writeUInt32LE(0, 16) // mouseData
  buf.writeUInt32LE(flags, 20)
  buf.writeUInt32LE(0, 24) // time
  buf.writeBigUInt64LE(0n, 32) // dwExtraInfo
  return buf
}

export function sendMouse(flags: number): void {
  const sent = user32.SendInput(1, mouseInput(flags), 40)
  if (sent !== 1) throw new Error(`SendInput 失败（flags=0x${flags.toString(16)}）`)
}

/** 真实左键点击（按下 + 抬起，同点） */
export async function clickAt(x: number, y: number): Promise<void> {
  user32.SetCursorPos(x, y)
  await sleep(60)
  sendMouse(MOUSEEVENTF_LEFTDOWN)
  await sleep(60)
  sendMouse(MOUSEEVENTF_LEFTUP)
  await sleep(120)
}

// —— 断言收集 ——
let failures = 0
export function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}：${detail}`)
  if (!ok) failures++
}

export function reportScriptError(err: unknown): void {
  failures++
  console.error(`FAIL  脚本异常：${err instanceof Error ? err.message : String(err)}`)
}

export function verifyFailureCount(): number {
  return failures
}

// —— 被测应用输出汇聚（冻结期噪音扫描的数据源）——
let appOutput = ''

export function resetAppOutput(): void {
  appOutput = ''
}

/** 冻结期（隐藏/最小化）输出扫描：命中崩溃噪音返回首个片段，干净返回 null */
export function scanFreezeNoise(): string | null {
  for (const marker of ['uncaughtException', 'Timed out after 2 seconds', 'getElementBounds', 'crashGuard']) {
    const at = appOutput.indexOf(marker)
    if (at >= 0) return `输出含「${marker}」：${appOutput.slice(Math.max(0, at - 40), at + 80).trim()}`
  }
  return null
}

// —— 被测应用生命周期 ——

export interface RunningApp {
  proc: ReturnType<typeof spawn>
  pid: number
  dir: string
}

export interface StartAppOptions {
  /** 临时目录前缀（%TEMP% 下，脚本各异便于辨认残留） */
  dirPrefix: string
  /** config.json 种子（覆盖 BASE_SEED：如 tray:true / autostart_hidden:true /
   *  agreement_accepted:false 弹 EULA 模态） */
  seed?: Record<string, unknown>
  /** 追加注入的环境变量（如静默取证防真跑安装链路的 STL_SKIP_AUTOSTART=1） */
  env?: Record<string, string>
}

/** 种子 config 公共底座：跳过首启/更新弹窗，静默主题 */
const BASE_SEED = {
  first_run: false,
  agreement_accepted: true,
  agreement_version: '2099-01-01',
  checkupdate: false,
  stcheckupdate: false,
  autostart: false,
  auto_proxy: false,
  theme: 'dark',
} as const

/**
 * 启动被测应用（临时 cwd 种子 config + 离线协议缓存）。直接 spawn bun 而非
 * `cmd /c bun ...`：窗口归属的进程必须是拿到 pid 的那个（cmd 中转时 proc.pid
 * 是 cmd 的 pid，按 PID 匹配窗口永远找不到，实测踩过）。不经 `bun run`/
 * `npm run`：那两者的 windowsHide 语义会让窗口只创建不显示。
 * stdout/stderr 即时回显并汇聚到 appOutput（供 scanFreezeNoise 扫描）。
 */
export async function startApp(options: StartAppOptions): Promise<RunningApp> {
  appOutput = ''
  const dir = mkdtempSync(join(tmpdir(), options.dirPrefix))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...BASE_SEED, ...options.seed }, null, 4))
  writeFileSync(join(dir, 'agreement_cache.json'), JSON.stringify({ date: '2099-01-01', content: '# 离线种子' }))

  const appEntry = resolve(import.meta.dir, '..', 'app.tsx')
  const proc = spawn('bun', [appEntry], {
    cwd: dir,
    env: {
      ...process.env,
      STL_SKIP_AGREEMENT_RECHECK: '1',
      STL_SKIP_MIRROR_AUTOSELECT: '1',
      ...options.env,
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

export async function waitForWindow(pid: number, timeoutMs: number): Promise<bigint> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hwnd = await findWindowByTitleAndPid(APP_TITLE, pid)
    if (hwnd !== 0) return BigInt(hwnd)
    await sleep(200)
  }
  return 0n
}

/** 等窗口出现并置顶 + 前台化（注入的真实输入必须落在被测窗口上）；settleMs 为
 *  窗口出现后的静置等待（等图标/窗口控制初始化落定）。45s 未出现抛错。 */
export async function bringUp(pid: number, settleMs: number): Promise<bigint> {
  const hwnd = await waitForWindow(pid, 45_000)
  if (hwnd === 0n) throw new Error('未找到被测窗口（45s 超时）')
  await sleep(settleMs)
  if (user32.IsWindowVisible(hwnd) === 0) user32.ShowWindow(hwnd, SW_SHOW)
  user32.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
  // 前台确认：SetForegroundWindow 会被前台锁拒绝（调用方不是前台进程时），真实输入的
  // 落点依赖前台状态——重试几次并留读数，避免"输入打到别家窗口"被误判成功能缺陷
  for (let i = 0; i < 3 && user32.GetForegroundWindow() !== hwnd; i++) {
    user32.SetForegroundWindow(hwnd)
    await sleep(300)
  }
  console.log(`  窗口 hwnd=${hwnd}｜前台窗口=${user32.GetForegroundWindow()}`)
  await sleep(200)
  return hwnd
}

function killTree(pid: number): void {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 已退出
  }
}

/**
 * 结束一个被测实例：先 WM_CLOSE 给干净退出机会（exit 钩子跑 NIM_DELETE 等收尾；
 * 托盘开启时应用隐藏到托盘不退出 → 超时强杀兜底），再删临时目录（Windows 下
 * cwd 被占用，删除要重试）。
 */
export async function disposeApp(instance: RunningApp): Promise<void> {
  if (instance.proc.exitCode === null && instance.proc.signalCode === null) {
    const hwnd = await waitForWindow(instance.pid, 1000)
    if (hwnd !== 0n) user32.PostMessageW(hwnd, WM_CLOSE, 0n, 0n)
    for (let i = 0; i < 10; i++) {
      if (instance.proc.exitCode !== null || instance.proc.signalCode !== null) break
      await sleep(300)
    }
    if (instance.proc.exitCode === null && instance.proc.signalCode === null) killTree(instance.pid)
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
  // 删不掉只意味着 %TEMP% 残留一个目录，不影响校验结论
}
