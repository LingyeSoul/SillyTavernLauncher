/**
 * 自绘标题栏的窗口控制服务：拖动 / 最小化 / 关闭。
 *
 * 为什么自己搬窗口（← gpuix skill patterns.md「拖动整个窗口」+ pitfalls-production.md）：
 * GPUIX 0.9.0 没有 window move API——vendored `gpui_windows` 的
 * `WindowControlArea::Drag`（WM_NCHITTEST → HTCAPTION）钩子没接到 React 层
 * （FFI 层 renderer.rs 全仓无 hit_test_window_control 使用），合成
 * `WM_NCLBUTTONDOWN`/`HTCAPTION` 与 `WM_SYSCOMMAND`/`SC_MOVE` 实测也都启动不了
 * 系统移动循环（消息通道本身是好的：跨进程 SC_MINIMIZE / WM_SETTEXT 均生效）。
 * 可行路径是自己搬：
 *   按下：抓取偏移 = GetCursorPos − GetWindowRect（两者都是屏幕坐标）
 *   移动：SetWindowPos(hwnd, null, 光标 − 偏移, 0, 0, SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE)
 *   抬起：清空抓取
 * 坐标必须用 GetCursorPos 的屏幕坐标：窗口在光标底下移动，事件 payload 的窗口
 * 坐标每帧都在变，拿它算会漂移。指针捕获不需要自己做——同一节点同时挂
 * onMouseDown + onMouseMove 时 gpui 自动捕获（拖出窗口仍收 move/up）。
 *
 * 代价（已知并接受，写进设计文档）：没有 Aero Snap、没有"从最大化拖出还原"。
 * 窗口是 resizable:false 固定窗（D4），本服务也不提供最大化——标题栏只有
 * 最小化与关闭两个按钮，不自造无法成立的交互。
 *
 * 关闭按钮：ST 未运行时由 AppShell.requestClose 调 `closeWindow()` 投递 WM_CLOSE，
 * 走 gpui 自身拆除路径（进程退出，`process.on('exit')` 钩子同步硬杀子进程）——与系统
 * X 同链路；ST 运行中调用方先经 exitConfirm 确认（D1/§4.7）再 quitLauncher 停进程
 * 退出。确认策略不落在本模块：这里只提供窗口原语。
 *
 * 纯函数部分（抓取偏移/拖动位置换算）在 Node/vitest 下可测；FFI 部分仅
 * win32 + Bun 运行时执行，其余环境全部静默降级（不抛错、不改行为）。
 */
import { errMsg, logError } from './errorLog'
import { findWindowByTitleAndPid } from './windowIcon'

// ---------------------------------------------------------------------------
// 纯函数：抓取偏移与拖动位置换算（Node & Bun 皆可运行，供单测）
// ---------------------------------------------------------------------------

export interface ScreenPoint {
  x: number
  y: number
}

export interface WindowRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface GrabOffset {
  dx: number
  dy: number
}

/** 按下时的抓取偏移 = 光标（屏幕坐标）− 窗口左上角（屏幕坐标） */
export function computeGrabOffset(cursor: ScreenPoint, rect: WindowRect): GrabOffset {
  return { dx: cursor.x - rect.left, dy: cursor.y - rect.top }
}

/** 拖动帧的窗口位置 = 光标 − 抓取偏移（保持按下点始终落在光标的同一窗口位置） */
export function computeDragPosition(cursor: ScreenPoint, grab: GrabOffset): ScreenPoint {
  return { x: cursor.x - grab.dx, y: cursor.y - grab.dy }
}

// ---------------------------------------------------------------------------
// Win32 FFI：仅 win32 + Bun 运行时执行
// ---------------------------------------------------------------------------

const SWP_NOSIZE = 0x0001
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FLAGS = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE // 0x0015

const WM_SYSCOMMAND = 0x0112
const SC_MINIMIZE = 0xf020
const WM_CLOSE = 0x0010

/**
 * 句柄一律用 u64 往来（出参 bigint、入参 number|bigint 皆收）：
 * FFIType.pointer 出参是 Pointer 对象，`!== 0` 恒真、无法判空——u64 才能可靠
 * 区分"未定位到窗口"与真实句柄（与 services/windowIcon.ts 的 pointer 收窄
 * 是同类取舍，那里不判空所以能用 pointer）。
 */
interface User32Symbols {
  GetCursorPos(pointOut: Int32Array): number
  GetWindowRect(hwnd: bigint, rectOut: Int32Array): number
  SetWindowPos(hwnd: bigint, insertAfter: bigint, x: number, y: number, cx: number, cy: number, flags: number): number
  PostMessageW(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): number
  ShowWindow(hwnd: bigint, cmd: number): number
  SetForegroundWindow(hwnd: bigint): number
  IsWindowVisible(hwnd: bigint): number
  IsIconic(hwnd: bigint): number
}

let user32: User32Symbols | null = null
/** 本进程窗口句柄；0n = 尚未定位（未初始化 / 定位失败 / 非 win32） */
let hwnd = 0n
/** 模块级抓取态：放 React state 会让每次 move 重渲染整棵标题栏 */
let grab: GrabOffset | null = null

/** user32 符号懒加载缓存（与 windowIcon 各自 dlopen：符号集不同，互不干扰） */
async function loadUser32(): Promise<User32Symbols> {
  if (user32) return user32
  const { dlopen, FFIType } = await import('bun:ffi')
  user32 = dlopen('user32.dll', {
    GetCursorPos: { args: [FFIType.pointer], returns: FFIType.i32 },
    GetWindowRect: { args: [FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
    SetWindowPos: {
      args: [FFIType.u64, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32],
      returns: FFIType.i32,
    },
    PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
    ShowWindow: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
    IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
    IsIconic: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols as unknown as User32Symbols
  return user32
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 启动期定位本进程窗口并缓存句柄（标题 + PID 双匹配，见 windowIcon 模块头：
 * FindWindowW 单命中在 dev 与 E2E 并存时会拿到别家实例）。
 * 失败仅记日志降级：标题栏仍可点击（最小化/关闭走同一句柄，未定位则整体空操作），
 * 不影响应用运行。
 */
export async function initWindowControl(title: string): Promise<void> {
  if (process.platform !== 'win32' || !process.versions.bun) return
  try {
    // render() 同步建窗，但标题写入与窗口链入 Z 序有极短窗口期，留重试兜底
    let found = 0
    for (let attempt = 0; attempt < 10 && found === 0; attempt++) {
      found = await findWindowByTitleAndPid(title, process.pid)
      if (found === 0) await sleep(100)
    }
    if (found === 0) throw new Error('未找到本进程窗口（枚举 10 次重试后放弃）')
    user32 ??= await loadUser32()
    hwnd = BigInt(found)
  } catch (err) {
    logError(`[windowControl] 定位本进程窗口失败: ${errMsg(err)}`)
  }
}

/** 读屏幕光标位置；失败返回 null（不抛） */
function readCursorPos(): ScreenPoint | null {
  if (!user32) return null
  const point = new Int32Array(2)
  if (user32.GetCursorPos(point) === 0) return null
  return { x: point[0], y: point[1] }
}

/** 读窗口屏幕矩形；失败返回 null（不抛） */
function readWindowRect(): WindowRect | null {
  if (!user32) return null
  const rect = new Int32Array(4)
  if (user32.GetWindowRect(hwnd, rect) === 0) return null
  return { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }
}

/** 窗口控制可用（win32 + Bun 且已定位到本进程窗口） */
function available(): boolean {
  return hwnd !== 0n && user32 !== null
}

/** 投递窗口消息（PostMessage 异步，跨线程不阻塞 gpui 消息泵） */
function postMessage(msg: number, wParam: bigint, lParam: bigint): boolean {
  if (!available() || !user32) return false
  return user32.PostMessageW(hwnd, msg, wParam, lParam) !== 0
}

/**
 * 标题栏按下：武装拖动并返回是否已武装。
 * 返回 false 时调用方应退化为"激活窗口"（非 win32 / 句柄未定位）。
 */
export function beginWindowMove(): boolean {
  if (!available()) return false
  const cursor = readCursorPos()
  const rect = cursor === null ? null : readWindowRect()
  if (cursor === null || rect === null) return false
  grab = computeGrabOffset(cursor, rect)
  return true
}

/** 拖动帧：把窗口搬到"光标 − 抓取偏移"（未武装时静默返回） */
export function continueWindowMove(): void {
  if (grab === null || !available() || !user32) return
  const cursor = readCursorPos()
  if (cursor === null) return
  const { x, y } = computeDragPosition(cursor, grab)
  // SetWindowPos 的 hWndInsertAfter 传 0（NULL）+ SWP_NOZORDER：不参与 Z 序调整
  user32.SetWindowPos(hwnd, 0n, Math.round(x), Math.round(y), 0, 0, SWP_FLAGS)
}

/** 标题栏抬起：清空抓取态 */
export function endWindowMove(): void {
  grab = null
}

/** 最小化窗口（SC_MINIMIZE 走系统命令，与原生标题栏按钮同路径） */
export function minimizeWindow(): void {
  postMessage(WM_SYSCOMMAND, BigInt(SC_MINIMIZE), 0n)
}

/**
 * 关闭窗口 = 退出启动器：投递 WM_CLOSE 让 gpui 走原生拆除路径
 * （与点击系统 X 同一条链路，含拆除期噪音与进程退出语义）。
 * ST 运行中先确认的策略在调用方（AppShell.requestClose），此处只投递。
 *
 * @returns 是否成功投递。false = 非 win32/Bun 或窗口句柄未定位（启动初期/定位失败）
 *   ——关闭按钮已是唯一可见退出入口，调用方必须据此退化为 `quitLauncher()`，
 *   否则会出现"点了关闭没反应"的死入口。
 */
export function closeWindow(): boolean {
  return postMessage(WM_CLOSE, 0n, 0n)
}

const SW_HIDE = 0
const SW_SHOW = 5

/**
 * 隐藏主窗口（托盘驻留，2026-09-22 托盘恢复）。ShowWindow 返回的是**隐藏前**的
 * 可见性（非 0 = 原本可见，即本次真实执行了隐藏）——非 0 当作成功。
 * false = 非 win32/Bun/句柄未定位，或窗口本就不可见；调用方（requestClose）
 * 必须回落到原退出路径，不留"点了没反应"的死入口。
 */
export function hideMainWindow(): boolean {
  if (!available() || !user32) return false
  return user32.ShowWindow(hwnd, SW_HIDE) !== 0
}

/** 显示并前台化主窗口（托盘唤回 / 托盘菜单「打开主窗口」） */
export function showMainWindow(): boolean {
  if (!available() || !user32) return false
  user32.ShowWindow(hwnd, SW_SHOW)
  user32.SetForegroundWindow(hwnd)
  return true
}

/**
 * 主窗口是否处于"布局冻结"态（隐藏到托盘 / 最小化）：此态下 gpui 原生侧
 * 不回应 renderer 的元素 bounds 查询——实测同步阻塞整 2s 后抛
 * "Timed out after 2 seconds waiting for the element bounds query"
 * （GenericFailure）。close-to-tray 落地后 SmartScroll 的 500ms 看门狗在
 * 隐藏期间连环炸的根因（2026-09-22 RCA）。冻结态布局不会变化，测量方
 * （SmartScroll / ProgressBar）应跳过本轮，恢复可见后下个周期自愈。
 * 'unknown' = 非 win32/Bun 或句柄未定位（按可测量处理，保住旧行为）。
 */
export function mainWindowQueryState(): 'live' | 'frozen' | 'unknown' {
  if (!available() || !user32) return 'unknown'
  if (user32.IsWindowVisible(hwnd) === 0 || user32.IsIconic(hwnd) !== 0) return 'frozen'
  return 'live'
}
