/**
 * 校验脚本：自绘标题栏的真实窗口取证（win32 + Bun 下运行，其他环境直接退出）。
 *
 *   bun scripts/verify-titlebar-drag.ts
 *
 * 它启一个真实启动器进程（临时 cwd，种子 config 跳过首启弹窗），然后：
 *   ① 铬层隐藏证据：GetWindowRect vs GetClientRect 相等 ⇒ 原生标题栏已被
 *      titlebarTransparent 隐藏（客户区覆盖整窗），不相等则说明系统标题栏仍在，
 *      自绘标题栏会与原生标题栏叠成双层铬层；
 *   ② 拖动证据：SetCursorPos + SendInput 左键真按下 → 分步移动光标 → 抬起，
 *      窗口矩形必须跟着位移（按抓取偏移换算的期望值比对）；同时验证"只按不移
 *      不搬窗口"（防止轻点就漂移）；
 *   ③ 最小化证据：点击最小化按钮落点 → IsIconic(hwnd) 置位；
 *   ④ 关闭证据：点击关闭按钮落点 → 进程在数秒内退出（WM_CLOSE 走 gpui 原生
 *      拆除路径，与系统 X 同链路）。
 *
 * 为什么不用 E2E（@gpuix/react/automation）：它的鼠标事件注入的是窗口内事件，
 * 不制造真实光标位移——而拖动实现读的是 GetCursorPos 的屏幕坐标，注入事件下
 * 光标原地不动，窗口必然"拖不动"，测不出真伪。真实输入台架（SendInput +
 * SetCursorPos）才能复现用户操作，这也是 gpuix skill pitfalls-production.md
 * 给这类问题定的取证口径。
 *
 * 与 services/windowControl 里的拖动实现共用同一套坐标语义：
 *   抓取偏移 = 光标 − 窗口左上角；拖动帧窗口 = 光标 − 抓取偏移
 * 这里的期望位移因此是"光标位移量本身"（拖动前后光标位移 = 窗口位移）。
 */
import { dlopen, FFIType } from 'bun:ffi'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findWindowByTitleAndPid } from '../services/windowIcon'

if (process.platform !== 'win32' || !process.versions.bun) {
  console.log('非 win32 + Bun 环境，跳过')
  process.exit(0)
}

// —— 常量（与 app.tsx / services/windowControl.ts 对齐）——
const APP_TITLE = 'SillyTavernLauncher' // WINDOW_OPTIONS.title
const WINDOW_W = 800
const WINDOW_H = 644 + 36 // 内容区 + 自绘标题栏
const TITLEBAR_MID_Y = 18 // 标题栏内拖动落点（栏体 35px 的中部）
const DRAG_START_X = 300 // 拖动落点：品牌区右侧、按钮组左侧的拖动区
const BTN_W = 46
const DRAG_STEPS = 8
const DRAG_STEP_X = 8
const DRAG_STEP_Y = 4
const RECT_TOLERANCE = 6 // 每步 SetCursorPos → SetWindowPos 有一帧延迟，允许偏差

const SW_RESTORE = 9
const SW_SHOW = 5
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const HWND_TOP = 0n
const INPUT_MOUSE = 0
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004

interface User32Symbols {
  GetWindowRect(hwnd: bigint, rectOut: Int32Array): number
  GetClientRect(hwnd: bigint, rectOut: Int32Array): number
  ClientToScreen(hwnd: bigint, pointOut: Int32Array): number
  SetCursorPos(x: number, y: number): number
  SendInput(count: number, inputs: Buffer, size: number): number
  IsIconic(hwnd: bigint): number
  IsWindow(hwnd: bigint): number
  IsWindowVisible(hwnd: bigint): number
  ShowWindow(hwnd: bigint, cmd: number): number
  SetWindowPos(hwnd: bigint, insertAfter: bigint, x: number, y: number, cx: number, cy: number, flags: number): number
  GetForegroundWindow(): bigint
  SetForegroundWindow(hwnd: bigint): number
}

const user32 = dlopen('user32.dll', {
  GetWindowRect: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
  GetClientRect: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
  ClientToScreen: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
  SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  SendInput: { args: [FFIType.u32, FFIType.pointer, FFIType.i32], returns: FFIType.u32 },
  IsIconic: { args: [FFIType.u64], returns: FFIType.i32 },
  IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
  ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  SetWindowPos: {
    args: [FFIType.u64, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
    returns: FFIType.i32,
  },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols as unknown as User32Symbols

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

function readWindowRect(hwnd: bigint): Rect {
  const buf = new Int32Array(4)
  if (user32.GetWindowRect(hwnd, buf) === 0) throw new Error('GetWindowRect 失败')
  return { left: buf[0], top: buf[1], right: buf[2], bottom: buf[3] }
}

function readClientRect(hwnd: bigint): Rect {
  const buf = new Int32Array(4)
  if (user32.GetClientRect(hwnd, buf) === 0) throw new Error('GetClientRect 失败')
  return { left: buf[0], top: buf[1], right: buf[2], bottom: buf[3] }
}

/** 客户区原点（0,0）在屏幕坐标下的位置：窗口外框含 DWM 隐形边，按钮落点必须由它换算 */
function readClientOrigin(hwnd: bigint): { x: number; y: number } {
  const point = new Int32Array([0, 0])
  if (user32.ClientToScreen(hwnd, point) === 0) throw new Error('ClientToScreen 失败')
  return { x: point[0], y: point[1] }
}

/**
 * 真实拖动一小段并报告两件事：窗口是否被搬动、是否被最小化（按钮点击在抬起时结算）。
 * 最小化态下 GetWindowRect 返回 -32000 级别的"图标位"矩形，不能当位移判据——
 * 故 minimized 时直接不判位移。
 */
interface DragProbeResult {
  moved: [number, number] | null
  minimized: boolean
}

async function dragFromPoint(hwnd: bigint, x: number, y: number, dx: number, dy: number): Promise<DragProbeResult> {
  const before = readWindowRect(hwnd)
  user32.SetCursorPos(x, y)
  await sleep(80)
  sendMouse(MOUSEEVENTF_LEFTDOWN)
  await sleep(80)
  for (let i = 1; i <= 6; i++) {
    user32.SetCursorPos(x + (dx / 6) * i, y + (dy / 6) * i)
    await sleep(60)
  }
  sendMouse(MOUSEEVENTF_LEFTUP)
  await sleep(250)
  const minimized = user32.IsIconic(hwnd) !== 0
  const after = readWindowRect(hwnd)
  const moved: [number, number] | null =
    minimized || (after.left === before.left && after.top === before.top) ? null : [after.left - before.left, after.top - before.top]
  return { moved, minimized }
}

/** 等窗口出现并置顶（各阶段共用的落地动作）；45s 未出现直接抛错 */
async function bringUp(pid: number, settleMs: number): Promise<bigint> {
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

/**
 * 真实拖动搬窗（标题栏拖动区那一套注入动作）；返回实测位移。
 * 零位移时重试至多 3 次：UI 线程忙（首帧布局/GC）会把整段输入压在队列里，
 * 表现为"拖不动"的假阴性——只对**完全没动**重试，部分位移按实测值判定，不放水。
 */
async function dragWindow(hwnd: bigint, x: number, y: number): Promise<[number, number]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = readWindowRect(hwnd)
    user32.SetCursorPos(x, y)
    await sleep(150)
    sendMouse(MOUSEEVENTF_LEFTDOWN)
    await sleep(120)
    for (let i = 1; i <= DRAG_STEPS; i++) {
      user32.SetCursorPos(x + i * DRAG_STEP_X, y + i * DRAG_STEP_Y)
      await sleep(90)
    }
    sendMouse(MOUSEEVENTF_LEFTUP)
    await sleep(300)
    const after = readWindowRect(hwnd)
    const moved: [number, number] = [after.left - before.left, after.top - before.top]
    if (moved[0] !== 0 || moved[1] !== 0) return moved
    if (attempt < 3) {
      console.log(`  第 ${attempt} 次拖动零位移（UI 未就绪？），重试`)
      await sleep(500)
    }
  }
  return [0, 0]
}

/** x64 INPUT 结构（40 字节）：type 在 0，MOUSEINPUT 从 8 开始，dwFlags 在 20 */
function mouseInput(flags: number): Buffer {
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

function sendMouse(flags: number): void {
  const sent = user32.SendInput(1, mouseInput(flags), 40)
  if (sent !== 1) throw new Error(`SendInput 失败（flags=0x${flags.toString(16)}）`)
}

/** 真实左键点击（按下 + 抬起，同点） */
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

/** 被测应用实例（spawn 句柄 + pid + 临时 cwd） */
interface RunningApp {
  proc: ReturnType<typeof spawn>
  pid: number
  dir: string
}

/**
 * 启动被测应用（临时 cwd 种子 config：跳过首启弹窗，绝不让模态遮住标题栏）。
 * 直接 spawn bun 而非 `cmd /c bun ...`：窗口归属的进程必须是拿到 pid 的那个，
 * cmd 中转时 proc.pid 是 cmd 的 pid，按 PID 匹配窗口永远找不到（实测踩过）。
 * 不经 `bun run`/`npm run`：那两者的 windowsHide 语义会让窗口只创建不显示。
 *
 * seedEula=true 时不写"已同意"种子：应用启动即弹 EULA 模态（用于验证遮罩
 * 确实盖住标题栏——模态打开时拖动/按钮必须无效）。
 */
async function startApp(appEntry: string, seedEula = false): Promise<RunningApp> {
  const dir = mkdtempSync(join(tmpdir(), 'stl-titlebar-verify'))
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      {
        first_run: false,
        agreement_accepted: !seedEula,
        agreement_version: '2099-01-01',
        checkupdate: false,
        stcheckupdate: false,
        autostart: false,
        auto_proxy: false,
        theme: 'dark',
      },
      null,
      4,
    ),
  )
  writeFileSync(join(dir, 'agreement_cache.json'), JSON.stringify({ date: '2099-01-01', content: '# 离线种子' }))

  const proc = spawn('bun', [appEntry], {
    cwd: dir,
    env: {
      ...process.env,
      STL_SKIP_AGREEMENT_RECHECK: '1',
      STL_SKIP_MIRROR_AUTOSELECT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = proc.pid ?? 0
  if (pid === 0) throw new Error('子进程启动失败（无 pid）')
  proc.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`  [app] ${chunk.toString().trim()}\n`))
  proc.stderr?.on('data', (chunk: Buffer) => process.stdout.write(`  [app:err] ${chunk.toString().trim()}\n`))
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

function killTree(pid: number): void {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 已退出
  }
}

/** 结束一个被测实例：杀进程树 + 删临时目录（Windows 下 cwd 被占用，删除要重试） */
async function disposeApp(instance: RunningApp): Promise<void> {
  if (instance.proc.exitCode === null && instance.proc.signalCode === null) killTree(instance.pid)
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

const appEntry = resolve(import.meta.dir, '..', 'app.tsx')
let running: RunningApp | null = null

try {
  // =====================================================================
  // 阶段一：铬层隐藏 + 拖动 + 最小化
  // =====================================================================
  console.log('— 阶段一：启动被测应用（真实窗口，非后台）—')
  running = await startApp(appEntry)
  const hwnd = await bringUp(running.pid, 1500)

  // ① 铬层隐藏：客户区尺寸 = 请求的内容尺寸，且客户区**贴窗口上沿**（无标题栏带宽）。
  //    实测数据（titlebarTransparent: true）：窗口 816×688 / 客户区 800×680，
  //    偏移 left:8 top:0 right:8 bottom:8——左右下各 8px 是 DWM 隐形缩放边框/阴影，
  //    top=0 才是"没有系统标题栏"的硬证据（有标题栏时 top ≈ 31px）。
  const winRect = readWindowRect(hwnd)
  const clientRect = readClientRect(hwnd)
  const clientOrigin = readClientOrigin(hwnd)
  const winW = winRect.right - winRect.left
  const winH = winRect.bottom - winRect.top
  const cliW = clientRect.right - clientRect.left
  const cliH = clientRect.bottom - clientRect.top
  const frameLeft = clientOrigin.x - winRect.left
  const frameTop = clientOrigin.y - winRect.top
  console.log(
    `  窗口 ${winW}×${winH} @ (${winRect.left},${winRect.top})｜客户区 ${cliW}×${cliH}｜客户区原点偏移 (${frameLeft},${frameTop})`,
  )
  check(
    '原生标题栏已隐藏（客户区贴窗口上沿）',
    frameTop === 0,
    `客户区上沿偏移 ${frameTop}px（>0 = 系统标题栏仍占位，会出现双层标题栏）`,
  )
  check(
    '客户区尺寸 = 800×(644+36)',
    cliW === WINDOW_W && cliH === WINDOW_H,
    `${cliW}×${cliH}（期望 ${WINDOW_W}×${WINDOW_H}）`,
  )
  check(
    '窗口外框仅为 DWM 隐形边（无标题栏带宽）',
    winH - cliH <= 16 && winW - cliW <= 32,
    `外框 - 客户区 = ${winW - cliW}×${winH - cliH}`,
  )

  // 置顶 + 前台已由 bringUp 完成 —— 注入的真实点击必须落在被测窗口上
  const startRect = readWindowRect(hwnd)
  const startOrigin = readClientOrigin(hwnd)
  // 拖动落点：客户区内 300px（品牌区右侧、按钮组左侧）
  const dragX = startOrigin.x + DRAG_START_X
  const dragY = startOrigin.y + TITLEBAR_MID_Y

  // ②a 只按不移：不得搬窗口（防轻点即漂移）
  await clickAt(dragX, dragY)
  const afterClick = readWindowRect(hwnd)
  check(
    '轻点标题栏不移动窗口',
    Math.abs(afterClick.left - startRect.left) <= 1 && Math.abs(afterClick.top - startRect.top) <= 1,
    `点击前 (${startRect.left},${startRect.top}) → 点击后 (${afterClick.left},${afterClick.top})`,
  )

  // ②b 真实拖动：光标分步移动，窗口应同步位移
  const dragFrom = readWindowRect(hwnd)
  const [actualDx, actualDy] = await dragWindow(hwnd, dragX, dragY)
  const dragTo = readWindowRect(hwnd)
  const expectedDx = DRAG_STEPS * DRAG_STEP_X
  const expectedDy = DRAG_STEPS * DRAG_STEP_Y
  check(
    '真实拖动搬动窗口',
    Math.abs(actualDx - expectedDx) <= RECT_TOLERANCE && Math.abs(actualDy - expectedDy) <= RECT_TOLERANCE,
    `期望位移 (+${expectedDx},+${expectedDy})，实测 (+${actualDx},+${actualDy})`,
  )
  check(
    '拖动不改窗口尺寸',
    dragTo.right - dragTo.left === dragFrom.right - dragFrom.left &&
      dragTo.bottom - dragTo.top === dragFrom.bottom - dragFrom.top,
    `${dragTo.right - dragTo.left}×${dragTo.bottom - dragTo.top}`,
  )

  // ②c 窗口按钮落点不是拖动区（结构回归：监听器若挂到栏体/按钮祖先上，这里会被搬动，
  //     且按钮点击必然失效——见 ui/shell/TitleBar.tsx 命中模型①）。
  //     位移必须留在按钮盒子内：GPUIX 的 click 在**抬起时**由光标所在元素结算
  //     （vendored renderer 把 click 接在 on_mouse_up 上），释放点落到相邻按钮上
  //     会触发那个按钮——拖到关闭按钮上会把应用关了（实测：脚本曾把释放点落在
  //     关闭按钮，窗口当场消失）。
  const afterDrag = readWindowRect(hwnd)
  const afterDragOrigin = readClientOrigin(hwnd)
  const minPoint = { x: afterDragOrigin.x + WINDOW_W - BTN_W * 1.5, y: afterDragOrigin.y + TITLEBAR_MID_Y }
  const buttonProbe = await dragFromPoint(hwnd, minPoint.x, minPoint.y, 12, 6)
  check(
    '最小化按钮落点按下拖动不搬窗口',
    buttonProbe.moved === null,
    buttonProbe.moved === null
      ? '窗口纹丝不动（按钮不在拖动区内）'
      : `窗口被搬动 ${JSON.stringify(buttonProbe.moved)}（按钮落在拖动区内）`,
  )
  if (buttonProbe.moved !== null) {
    user32.SetWindowPos(hwnd, HWND_TOP, afterDrag.left, afterDrag.top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)
    await sleep(200)
  }

  // ③ 最小化按钮生效：上面那次"在按钮内按下-抬起"本身就是一次点击
  let iconic = 0
  for (let i = 0; i < 20 && iconic === 0; i++) {
    await sleep(150)
    iconic = user32.IsIconic(hwnd)
  }
  console.log(`  （点击落点 (${minPoint.x},${minPoint.y})）`)
  check('最小化按钮生效', iconic !== 0, `IsIconic=${iconic}`)
  user32.ShowWindow(hwnd, SW_RESTORE)
  await sleep(600)

  // =====================================================================
  // 阶段二：关闭按钮（进程退出是本阶段唯一判据，故放最后）
  // =====================================================================
  const closeOrigin = readClientOrigin(hwnd)
  const closeX = closeOrigin.x + WINDOW_W - BTN_W / 2
  const closeY = closeOrigin.y + TITLEBAR_MID_Y
  await clickAt(closeX, closeY)
  let exited = false
  for (let i = 0; i < 40 && !exited; i++) {
    await sleep(250)
    exited = running.proc.exitCode !== null || running.proc.signalCode !== null
  }
  check('关闭按钮退出进程', exited, `点击落点 (${closeX},${closeY}) → exitCode=${running.proc.exitCode}`)

  // =====================================================================
  // 阶段三：模态打开时标题栏必须被遮罩挡住（另一种"标题栏失效"风险：对话框弹出
  // 期间还能拖窗/关窗 = 遮罩没盖住铬层）
  // =====================================================================
  await disposeApp(running)
  running = null
  console.log('\n— 阶段三：模态（EULA）打开时标题栏连通性（种子未同意协议）—')
  running = await startApp(appEntry, true)
  const eulaHwnd = await bringUp(running.pid, 2500)
  const eulaOrigin = readClientOrigin(eulaHwnd)
  const eulaDrag = await dragFromPoint(eulaHwnd, eulaOrigin.x + DRAG_START_X, eulaOrigin.y + TITLEBAR_MID_Y, 60, 0)
  check(
    '模态打开时拖动标题栏无效（遮罩覆盖铬层）',
    eulaDrag.moved === null && !eulaDrag.minimized,
    `moved=${JSON.stringify(eulaDrag.moved)} minimized=${eulaDrag.minimized}`,
  )
  const eulaClose = { x: eulaOrigin.x + WINDOW_W - BTN_W / 2, y: eulaOrigin.y + TITLEBAR_MID_Y }
  await clickAt(eulaClose.x, eulaClose.y)
  await sleep(800)
  const aliveAfterClick = running.proc.exitCode === null && running.proc.signalCode === null
  check('模态打开时点击关闭按钮不退出（遮罩拦截）', aliveAfterClick, `进程存活=${aliveAfterClick}`)
} catch (err) {
  failures++
  console.error(`FAIL  脚本异常：${err instanceof Error ? err.message : String(err)}`)
} finally {
  const leftover: RunningApp | null = running
  if (leftover) await disposeApp(leftover)
}

console.log(failures === 0 ? '\n全部校验通过' : `\n${failures} 项校验失败`)
process.exit(failures === 0 ? 0 : 1)
