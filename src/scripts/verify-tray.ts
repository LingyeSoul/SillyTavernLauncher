/**
 * 校验脚本：系统托盘全链路取证（win32 + Bun 下运行，其他环境直接退出）。
 *
 *   bun scripts/verify-tray.ts
 *
 * 为什么不用 E2E：托盘回调是 explorer → 隐藏窗 PostMessage 的 OS 级消息路由，
 * @gpuix/react/automation 的进程内合成事件根本到不了这条链路；托盘图标本体
 * 在溢出区也无法可靠注入点击。取证口径照 verify-titlebar-drag：程序化断言
 * FFI 链路 + 真实窗口行为，可注入的输入（关闭按钮）用 SendInput 真打。
 *
 * 阶段一（本进程 FFI 链路——证明结构体布局/回调注册/消息泵全对）：
 *   ① initTray 返回 true，FindWindowW(类名) 定位到 helper 窗且 PID 是本进程；
 *   ② PostMessage(WM_APP+1, WM_LBUTTONUP) 模拟 explorer 投递 → 50ms 泵周期内
 *      onOpenMain handler 被调（消息路由 + JSCallback 同线程分发的硬证据）；
 *   ③ destroyTray 后 helper 窗不复存在（NIM_DELETE/DestroyWindow/UnregisterClass
 *      生命周期闭环，重开开关不会撞"类已注册"）。
 *
 * 阶段二（真实应用进程——证明关闭到托盘语义落地）：
 *   ④ 种子 config tray:true 启动应用，helper 窗存在于应用进程；
 *   ⑤ SendInput 点击自绘标题栏关闭按钮 → 窗口隐藏（IsWindowVisible=0）且进程
 *      存活（不退出、ST 不被杀——这是 close-to-tray 的核心语义断言）；
 *   ⑥ PostMessage(WM_CLOSE)（Alt+F4 同链路）→ 进程干净退出（exit 钩子跑 NIM_DELETE）。
 */
import { dlopen, FFIType } from 'bun:ffi'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findWindowByTitleAndPid } from '../services/windowIcon'
import { TRAY_CALLBACK_MESSAGE, TRAY_WINDOW_CLASS, TRAY_CMD, createTrayPopupMenu, destroyTray, initTray } from '../services/tray'
import { LOGO_DATA_URL } from '../ui/assets/logo'

if (process.platform !== 'win32' || !process.versions.bun) {
  console.log('非 win32 + Bun 环境，跳过')
  process.exit(0)
}

// —— 常量（与 app.tsx / ui/shell/TitleBar.tsx 对齐，照 verify-titlebar-drag）——
const APP_TITLE = 'SillyTavernLauncher'
const WINDOW_W = 800
const TITLEBAR_MID_Y = 18
const BTN_W = 46

const WM_NULL = 0x0000
const WM_CLOSE = 0x0010
const WM_SYSCOMMAND = 0x0112
const SC_MINIMIZE = 0xf020
const WM_LBUTTONUP = 0x0202

const SW_SHOW = 5
const SW_RESTORE = 9

const MF_BYPOSITION = 0x400
/** GetMenuState 的置灰/禁用位（MF_GRAYED|MF_DISABLED） */
const MF_GRAYDISABLED = 0x3

/** 侧栏「设置」nav 落点：theme.layout.sidebarW=168、导航 paddingTop 14 + gap 3、
 *  navItemH=38，设置是第 5 项 → y = 14 + 4*(38+3) + 19（与 ui 侧 token 对齐） */
const NAV_SETTINGS_X = 84
const NAV_SETTINGS_Y = 197
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const HWND_TOP = 0n
const INPUT_MOUSE = 0
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004

interface User32Symbols {
  FindWindowW(className: unknown, windowName: bigint): bigint
  GetWindowThreadProcessId(hwnd: bigint, pidOut: Uint32Array): number
  GetWindowRect(hwnd: bigint, rectOut: Int32Array): number
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

const user32 = dlopen('user32.dll', {
  FindWindowW: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u64 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.u32 },
  GetWindowRect: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
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
}).symbols as unknown as User32Symbols

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function utf16z(text: string): Buffer {
  const buf = Buffer.alloc((text.length + 1) * 2)
  for (let i = 0; i < text.length; i++) buf.writeUInt16LE(text.charCodeAt(i), i * 2)
  return buf
}

/** 按类名找窗口并校验归属进程（防止抓到别家实例——托盘默认关，仅用户手动开启的
 *  常驻启动器可能撞名；撞上直接报失败而非误判） */
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

function readWindowRect(hwnd: bigint): { left: number; top: number; right: number; bottom: number } {
  const rect = new Int32Array(4)
  user32.GetWindowRect(hwnd, rect)
  return { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }
}

function readClientOrigin(hwnd: bigint): { x: number; y: number } {
  const pt = new Int32Array([0, 0])
  user32.ClientToScreen(hwnd, pt)
  return { x: pt[0], y: pt[1] }
}

function mouseInput(flags: number): Buffer {
  const buf = Buffer.alloc(40)
  buf.writeUInt32LE(INPUT_MOUSE, 0)
  buf.writeUInt32LE(flags, 20)
  return buf
}

function sendMouse(flags: number): void {
  const sent = user32.SendInput(1, mouseInput(flags), 40)
  if (sent !== 1) throw new Error(`SendInput 失败（flags=0x${flags.toString(16)}）`)
}

async function clickAt(x: number, y: number): Promise<void> {
  user32.SetCursorPos(x, y)
  await sleep(60)
  sendMouse(MOUSEEVENTF_LEFTDOWN)
  await sleep(60)
  sendMouse(MOUSEEVENTF_LEFTUP)
  await sleep(120)
}

// —— 断言收集 ——
let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}：${detail}`)
  if (!ok) failures++
}

/** 冻结期（隐藏/最小化）输出扫描：命中崩溃噪音返回首个片段，干净返回 null */
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

/** 当前被测实例的输出汇聚（startApp 重置并写入；阶段断言扫描 crashGuard 噪音） */
let appOutput = ''

/** 启动被测应用（种子 config：tray:true + 跳过首启/协议弹窗）。直接 spawn bun
 *  而非 cmd /c 中转：proc.pid 必须是拿窗口的进程（titlebar-drag 实测教训）。 */
async function startApp(appEntry: string): Promise<RunningApp> {
  appOutput = ''
  const dir = mkdtempSync(join(tmpdir(), 'stl-tray-verify'))
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      {
        first_run: false,
        agreement_accepted: true,
        agreement_version: '2099-01-01',
        checkupdate: false,
        stcheckupdate: false,
        autostart: false,
        auto_proxy: false,
        tray: true,
        theme: 'dark',
      },
      null,
      4,
    ),
  )
  writeFileSync(join(dir, 'agreement_cache.json'), JSON.stringify({ date: '2099-01-01', content: '# 离线种子' }))

  const proc = spawn('bun', [appEntry], {
    cwd: dir,
    env: { ...process.env, STL_SKIP_AGREEMENT_RECHECK: '1', STL_SKIP_MIRROR_AUTOSELECT: '1' },
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
    // 先给干净退出机会（exit 钩子跑 NIM_DELETE），超时才强杀
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

const appEntry = resolve(import.meta.dir, '..', 'app.tsx')
let running: RunningApp | null = null

try {
  // =====================================================================
  // 阶段一：本进程 FFI 链路（结构体布局 / 回调注册 / 消息泵 / 生命周期）
  // =====================================================================
  console.log('— 阶段一：本进程托盘 FFI 链路 —')
  let opened = false
  const ok = await initTray({
    iconDataUrl: LOGO_DATA_URL,
    handlers: {
      onOpenMain: () => {
        opened = true
      },
      onStartSt: () => {},
      onStopSt: () => {},
      onRestartSt: () => {},
      onQuit: () => {},
      isStRunning: () => false,
    },
  })
  check('initTray 成功', ok, ok ? '返回 true' : '返回 false（见日志）')

  let helper = findHelperWindowByClass(process.pid)
  check('helper 隐藏顶层窗已创建', helper !== 0n, `hwnd=${helper}`)

  // 模拟 explorer 投递左键回调：泵（50ms 周期）应把消息送进 wndproc → handler
  if (helper !== 0n) {
    user32.PostMessageW(helper, TRAY_CALLBACK_MESSAGE, 1n, BigInt(WM_LBUTTONUP))
    for (let i = 0; i < 20 && !opened; i++) await sleep(50)
    check('托盘回调消息路由到 handler（左键 → onOpenMain）', opened, opened ? '泵周期内收到' : '1s 内未收到')
  }

  // 菜单内容断言（model → AppendMenuW 翻译层）：2026-09-22 "托盘缺失退出启动器"
  // 的根因是分隔线吞掉 quit 项——此断言对真实 HMENU 逐项检查，翻译层缺陷不再漏网
  const menu = await createTrayPopupMenu()
  if (menu === 0n) {
    check('右键菜单内容（翻译层）', false, 'createTrayPopupMenu 返回 0（构建失败）')
  } else {
    const count = user32.GetMenuItemCount(menu)
    const ids: number[] = []
    const labels: string[] = []
    for (let i = 0; i < count; i++) {
      ids.push(user32.GetMenuItemID(menu, i))
      const buf = Buffer.alloc(256)
      const len = user32.GetMenuStringW(menu, i, buf, 128, MF_BYPOSITION)
      labels.push(len > 0 ? buf.toString('utf16le', 0, len * 2) : '')
    }
    const quitAt = ids.indexOf(TRAY_CMD.quit)
    const quitState = quitAt >= 0 ? user32.GetMenuState(menu, quitAt, MF_BYPOSITION) : -1
    check(
      '右键菜单含「退出启动器」（分隔线独立、quit 末位可用）',
      count === 6 &&
        ids.indexOf(0) === 4 &&
        quitAt === 5 &&
        labels[quitAt] === '退出启动器' &&
        (quitState & MF_GRAYDISABLED) === 0,
      `count=${count} ids=[${ids}] labels=[${labels.join('/')}] quitState=0x${(quitState >>> 0).toString(16)}`,
    )
    user32.DestroyMenu(menu)
  }

  destroyTray()
  await sleep(100)
  const afterDestroy = user32.FindWindowW(utf16z(TRAY_WINDOW_CLASS), 0n)
  check('destroyTray 拆除 helper 窗', afterDestroy === 0n, `FindWindowW=${afterDestroy}`)

  // 重开一次：不撞"类已注册"（UnregisterClass 生命周期闭环）
  const reOk = await initTray({
    iconDataUrl: LOGO_DATA_URL,
    handlers: {
      onOpenMain: () => {},
      onStartSt: () => {},
      onStopSt: () => {},
      onRestartSt: () => {},
      onQuit: () => {},
      isStRunning: () => false,
    },
  })
  check('停用后可重开（UnregisterClass 不留死类）', reOk, reOk ? '重挂成功' : '重挂失败')
  destroyTray()

  // =====================================================================
  // 阶段二：真实应用进程（关闭到托盘语义 + 干净退出）
  // =====================================================================
  console.log('\n— 阶段二：真实应用（tray:true 种子）—')
  running = await startApp(appEntry)
  const hwnd = await waitForWindow(running.pid, 45_000)
  if (hwnd === 0n) throw new Error('未找到被测主窗口（45s 超时）')
  await sleep(2000) // 等图标/窗口控制初始化落定
  if (user32.IsWindowVisible(hwnd) === 0) user32.ShowWindow(hwnd, SW_SHOW)
  user32.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
  for (let i = 0; i < 3 && user32.GetForegroundWindow() !== hwnd; i++) {
    user32.SetForegroundWindow(hwnd)
    await sleep(300)
  }

  const appHelper = findHelperWindowByClass(running.pid)
  check('应用进程内 helper 窗已创建（托盘随 tray:true 启动）', appHelper !== 0n, `hwnd=${appHelper}`)

  // ④b 冻结期静默回归（2026-09-22 close-to-tray 崩溃 RCA）：切到设置页挂载
  //     SmartScroll（500ms 看门狗常驻），最小化 3s + 隐藏 7s 内看门狗不得向
  //     冻结窗口发 bounds 查询——旧行为每 tick 同步阻塞 2s 后抛 GenericFailure，
  //     crashGuard 刷屏 + JS 线程冻死
  const navOrigin = readClientOrigin(hwnd)
  await clickAt(navOrigin.x + NAV_SETTINGS_X, navOrigin.y + NAV_SETTINGS_Y)
  await sleep(1200) // 等视图切换 + 看门狗运转
  appOutput = '' // 只扫描冻结期的输出

  user32.PostMessageW(hwnd, WM_SYSCOMMAND, BigInt(SC_MINIMIZE), 0n)
  await sleep(3000)
  const iconicNoise = scanFreezeNoise()
  check('最小化期无 bounds 查询噪音（iconic 同属冻结态）', iconicNoise === null, iconicNoise ?? '输出干净')
  user32.ShowWindow(hwnd, SW_RESTORE)
  await sleep(600)

  // ⑤ 关闭到托盘：点击关闭按钮 → 隐藏而非退出
  const origin = readClientOrigin(hwnd)
  const closeX = origin.x + WINDOW_W - BTN_W / 2
  const closeY = origin.y + TITLEBAR_MID_Y
  await clickAt(closeX, closeY)
  let hidden = false
  for (let i = 0; i < 10 && !hidden; i++) {
    await sleep(200)
    hidden = user32.IsWindowVisible(hwnd) === 0
  }
  await sleep(1500) // 再观察一段时间：不得延迟退出（close-to-tray 不杀进程）
  const alive = running.proc.exitCode === null && running.proc.signalCode === null
  check('关闭按钮 → 窗口隐藏到托盘', hidden, `IsWindowVisible=${user32.IsWindowVisible(hwnd)}（点击落点 ${closeX},${closeY}）`)
  check('隐藏后进程存活（ST 不被杀）', alive, `exitCode=${running.proc.exitCode} signalCode=${running.proc.signalCode}`)

  // ⑤b 隐藏期静默回归：7s 内存活且无 crashGuard/bounds 超时噪音
  //     （SmartScroll/ProgressBar 冻结门检生效的硬证据）
  if (alive) {
    await sleep(7000)
    const quiet = running.proc.exitCode === null && running.proc.signalCode === null
    const noise = scanFreezeNoise()
    check('隐藏 7s 无 bounds 查询崩溃噪音（冻结门检回归）', quiet && noise === null, noise ?? `进程存活=${quiet}，输出干净`)
  }

  // 唤回一次：SW_SHOW 后窗口仍在且可再隐藏（往返证明 gpui 容忍 SW_HIDE）
  if (alive) {
    user32.ShowWindow(hwnd, SW_SHOW)
    user32.SetForegroundWindow(hwnd)
    await sleep(600)
    const visibleAgain = user32.IsWindowVisible(hwnd) !== 0
    check('SW_SHOW 唤回主窗口（gpui 容忍隐藏/复显）', visibleAgain, `IsWindowVisible=${user32.IsWindowVisible(hwnd)}`)
  }

  // ⑥ 原生退出链路（Alt+F4 同款）：WM_CLOSE → 干净退出（exit 钩子跑 NIM_DELETE）
  user32.PostMessageW(hwnd, WM_CLOSE, 0n, 0n)
  let exited = false
  for (let i = 0; i < 40 && !exited; i++) {
    await sleep(250)
    exited = running.proc.exitCode !== null || running.proc.signalCode !== null
  }
  check('WM_CLOSE 干净退出进程', exited, `exitCode=${running.proc.exitCode}`)

  await disposeApp(running)
  running = null
} catch (err) {
  failures++
  console.error(`FAIL  脚本异常：${err instanceof Error ? err.message : String(err)}`)
} finally {
  destroyTray() // 脚本自身兜底：阶段一异常路径不留残留托盘
  const leftover: RunningApp | null = running
  if (leftover) await disposeApp(leftover)
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
