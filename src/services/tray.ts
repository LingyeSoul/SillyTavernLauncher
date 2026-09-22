/**
 * 系统托盘服务：托盘图标 + 右键菜单 + 左键唤回主窗口（← features/tray/tray.py）。
 *
 * 为什么自力更生走 Win32（2026-09-22 托盘恢复，D1 恢复条件部分达成）：
 * @gpuix/native 0.9.0 导出面没有任何托盘/窗口显隐 API（已核实 index.d.ts 与
 * 二进制符号表）；但 O12 自绘标题栏把可见关闭入口变成了自家 click handler，
 * "close-to-tray"不再被框架挡死——托盘本体经 Shell_NotifyIconW 自建，关闭分流
 * 在 AppShell.requestClose（isTrayActive && hideMainWindow）。
 *
 * 关键架构决策（均与 bun:ffi 的边界对齐，勿"优化"掉）：
 * - **隐藏顶层窗而非 message-only 窗**：① TaskbarCreated（explorer 重启后重挂
 *   图标）是 HWND_BROADCAST 广播，message-only 窗收不到；② 右键菜单的"点外
 *   失焦消失"依赖本进程持有前台窗口，message-only 无法前台化。窗口永不显示
 *   （WS_POPUP、标题 NULL），不会撞 windowIcon 的 标题+PID 双匹配枚举。
 * - **消息泵在 JS 线程（setInterval + PeekMessage 轮询）**：Bun 事件循环不是
 *   Windows 消息循环，自己泵才能把 explorer 投递的托盘回调送进 wndproc；
 *   wndproc（JSCallback）经 DispatchMessage 永远同步地在 JS 线程被调——
 *   bun:ffi 的 threadsafe JSCallback 对"非 Worker 原生线程回调"仍是实验性
 *   （官方文档明确 + 已知堆损坏 issue），绝不把泵挪去原生线程。
 * - **菜单每次右键现建现毁**：菜单项从 handlers.isStRunning() 现读，免掉
 *   NIM_MODIFY/菜单状态同步记账（← pystray Menu 静态声明的教训：状态漂移）。
 * - **类名缓冲放 HeapAlloc 不可移动内存**：WNDCLASSW.lpszClassName 是内嵌指针
 *   字段，需要持久地址——bun:ffi 传参时对 Buffer 的取址只在调用瞬间有效，
 *   JS Buffer 在堆上可能被移动；HeapAlloc + memcpy 全程经 FFI，地址稳定。
 *   （窗口类在 destroyTray 时 UnregisterClass，否则关→开重注册会因"类已存在"
 *   返回 0 原子而失败。）
 *
 * DEVIATION: TrackPopupMenu 是模态循环，菜单打开期间 JS 事件循环阻塞（gpui
 * 渲染在独立原生线程不受影响，窗口不停绘）。菜单是短生命周期模态，接受；同因
 * 菜单打开时不再受理第二次右键（menuActive 守卫）。
 *
 * 纯函数部分（NOTIFYICONDATAW 布局 / UTF-16 写入 / 菜单模型）在 Node/vitest
 * 下可测；FFI 部分仅 win32 + Bun 运行时执行，其余环境静默降级（initTray 返回
 * false，不抛错）。--hot 模块重求值经 globalThis 状态恢复（同 windowIcon 的
 * __stlWindowIconApplied 模式；热更后 handlers 闭包属旧模块实例，下次 initTray
 * 或重开托盘开关即自愈——dev 期已知并接受的降级）。
 */
import { errMsg, logError } from './errorLog'
import { createHiconFromDataUrl } from './windowIcon'

// ---------------------------------------------------------------------------
// 纯函数：结构体布局 / 字符串编码 / 菜单模型（Node & Bun 皆可运行，供单测）
// ---------------------------------------------------------------------------

/** NOTIFYICONDATAW 在 x64 的总尺寸（含 guidItem/hBalloonIcon 的 Win7+ 全量布局） */
export const NOTIFY_ICON_DATA_SIZE = 976

// x64 字段偏移（cbSize 后到 8 字节对齐的 hWnd 之间、uCallbackMessage 后到
// hIcon 之间各有一段 padding，Buffer.alloc 全零起步即可）
const OFF_HWND = 8
const OFF_UID = 16
const OFF_UFLAGS = 20
const OFF_CALLBACK = 24
const OFF_HICON = 32
const OFF_TIP = 40
/** szTip 容量：128 个 wchar（含结尾 NUL，即可写 127 字符） */
const TIP_WCHARS = 128

const NIF_MESSAGE = 0x1
const NIF_ICON = 0x2
const NIF_TIP = 0x4

/**
 * 向目标缓冲写入 UTF-16LE 字符串 + 结尾 NUL（maxChars 含 NUL，超出截断）。
 * 截断不劈代理对：若截断处落在高代理（0xD800–0xDBFF）上，连它一起丢弃，
 * 避免给 Win32 留下一个孤立代理（渲染成豆腐块）。
 *
 * @returns 实际写入的字符数（不含结尾 NUL）
 */
export function writeUtf16z(target: Uint8Array, offset: number, maxChars: number, text: string): number {
  const cap = maxChars - 1 // 留 1 个 wchar 给 NUL
  let count = 0
  for (let i = 0; i < text.length && count < cap; i++) {
    const code = text.charCodeAt(i)
    // 容量只够再写 1 个 wchar，而当前字符是代理对的前半：整对放弃
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && count === cap - 1) break
    const at = offset + count * 2
    target[at] = code & 0xff
    target[at + 1] = code >> 8
    count++
  }
  const nul = offset + count * 2
  target[nul] = 0
  target[nul + 1] = 0
  return count
}

export interface TrayIconDataInput {
  /** 承接回调的窗口句柄 */
  hwnd: bigint
  /** 图标句柄 */
  iconHandle: bigint
  /** explorer 投递鼠标事件的回调消息号（WM_APP 族） */
  callbackMessage: number
  /** 图标 ID（单图标固定 1） */
  id: number
  /** 悬停提示（超 127 字符截断，不劈代理对） */
  tooltip: string
}

/** 构造 Shell_NotifyIconW 的 NOTIFYICONDATAW（NIM_ADD/NIM_DELETE 共用） */
export function buildNotifyIconData(input: TrayIconDataInput): Buffer {
  const buf = Buffer.alloc(NOTIFY_ICON_DATA_SIZE) // 全零起步：未用字段/padding 干净
  buf.writeUInt32LE(NOTIFY_ICON_DATA_SIZE, 0)
  buf.writeBigUInt64LE(BigInt.asUintN(64, input.hwnd), OFF_HWND)
  buf.writeUInt32LE(input.id >>> 0, OFF_UID)
  buf.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP, OFF_UFLAGS)
  buf.writeUInt32LE(input.callbackMessage >>> 0, OFF_CALLBACK)
  buf.writeBigUInt64LE(BigInt.asUintN(64, input.iconHandle), OFF_HICON)
  writeUtf16z(buf, OFF_TIP, TIP_WCHARS, input.tooltip)
  return buf
}

/** 菜单命令 ID（TrackPopupMenu 的返回值；0 = 用户取消） */
export const TRAY_CMD = {
  openMain: 1,
  startSt: 2,
  stopSt: 3,
  restartSt: 4,
  quit: 5,
} as const

export interface TrayMenuEntry {
  /** 菜单命令 ID；0 = 分隔线占位项（不可选中，渲染层走 AppendMenuW(MF_SEPARATOR)） */
  id: number
  label: string
  separator: boolean
  /** false = 置灰（状态不适用，如未运行时的"关闭酒馆"） */
  enabled: boolean
}

/**
 * 菜单模型（← pystray Menu 五项对齐 + 增加重启）：按 ST 运行态置灰不适用的项。
 * 每次右键从 isStRunning() 现读重建，模型即状态、无同步记账。
 * ⚠ 分隔线是**独立占位项**（id=0）而非"某项自带前置分隔线"——2026-09-22 实锤
 * 教训：早期把 quit 标成 separator:true，append 循环据此只画了分隔线、quit 项
 * 从未入菜单（"托盘缺失退出启动器"缺陷根因）。翻译层由 createTrayPopupMenu
 * 统一承载，verify-tray 对真实 HMENU 内容做断言。
 */
export function buildTrayMenuModel(running: boolean): TrayMenuEntry[] {
  return [
    { id: TRAY_CMD.openMain, label: '打开主窗口', separator: false, enabled: true },
    { id: TRAY_CMD.startSt, label: '启动酒馆', separator: false, enabled: !running },
    { id: TRAY_CMD.stopSt, label: '关闭酒馆', separator: false, enabled: running },
    { id: TRAY_CMD.restartSt, label: '重启酒馆', separator: false, enabled: running },
    { id: 0, label: '', separator: true, enabled: false },
    { id: TRAY_CMD.quit, label: '退出启动器', separator: false, enabled: true },
  ]
}

/** UTF-16LE + NUL 的 FFI 字符串缓冲（仅 FFI 调用期需要存活——Win32 侧即刻拷贝） */
function utf16zBuf(text: string): Buffer {
  const buf = Buffer.alloc((text.length + 1) * 2)
  writeUtf16z(buf, 0, text.length + 1, text)
  return buf
}

// ---------------------------------------------------------------------------
// Win32 FFI：仅 win32 + Bun 运行时执行
// ---------------------------------------------------------------------------

/** 承接托盘回调的隐藏窗口类名（scripts/verify-tray 按 FindWindowW(类名) 定位取证） */
export const TRAY_WINDOW_CLASS = 'STLTrayHost'
/** 托盘回调消息（WM_APP + 1；经典语义：lParam = 鼠标消息，wParam = 图标 ID） */
export const TRAY_CALLBACK_MESSAGE = 0x8001

const WM_NULL = 0x0000
const WM_CONTEXTMENU = 0x007b
const WM_LBUTTONUP = 0x0202
const WM_LBUTTONDBLCLK = 0x0203
const WM_RBUTTONUP = 0x0205

const NIM_ADD = 0
const NIM_DELETE = 2

const WS_POPUP = 0x80000000

const PM_REMOVE = 0x1

const MF_STRING = 0x0
const MF_GRAYED = 0x1
const MF_SEPARATOR = 0x800

const TPM_BOTTOMALIGN = 0x0020
const TPM_RIGHTALIGN = 0x0008
const TPM_RETURNCMD = 0x0100

const SM_CXSMICON = 49
const SM_CYSMICON = 50

/** MSG 结构（x64，48 字节）——泵的出参容器，内容由 DispatchMessage 内部消费 */
const MSG_SIZE = 48

/** WNDCLASSW（x64，72 字节）字段偏移 */
const WNDCLASS_SIZE = 72
const WC_WNDPROC = 8
const WC_HINSTANCE = 24
const WC_CLASSNAME = 64

const HEAP_ZERO_MEMORY = 0x8

interface TrayUser32 {
  RegisterClassW(wc: unknown): number
  UnregisterClassW(className: unknown, instance: bigint): number
  CreateWindowExW(
    exStyle: number,
    className: unknown,
    windowName: bigint,
    style: number,
    x: number,
    y: number,
    w: number,
    h: number,
    parent: bigint,
    menu: bigint,
    instance: bigint,
    param: bigint,
  ): bigint
  DefWindowProcW(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint
  DestroyWindow(hwnd: bigint): number
  RegisterWindowMessageW(name: unknown): number
  PeekMessageW(msg: unknown, hwnd: bigint, min: number, max: number, remove: number): number
  TranslateMessage(msg: unknown): number
  DispatchMessageW(msg: unknown): bigint
  PostMessageW(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): number
  GetCursorPos(out: Int32Array): number
  SetForegroundWindow(hwnd: bigint): number
  GetSystemMetrics(index: number): number
  CreatePopupMenu(): bigint
  AppendMenuW(menu: bigint, flags: number, id: bigint, text: unknown): number
  TrackPopupMenu(menu: bigint, flags: number, x: number, y: number, reserved: number, hwnd: bigint, rect: bigint): number
  DestroyMenu(menu: bigint): number
  DestroyIcon(icon: bigint): number
}

/** 托盘动作束（UI 层注入——services 不反向依赖 stores/UI 的分层约束） */
export interface TrayHandlers {
  onOpenMain: () => void
  onStartSt: () => void
  onStopSt: () => void
  onRestartSt: () => void
  onQuit: () => void
  isStRunning: () => boolean
}

export interface TrayInitOptions {
  /** 图标源（PNG dataURL，复用 ui/assets/logo 常量） */
  iconDataUrl: string
  /** 悬停提示（默认启动器名） */
  tooltip?: string
  handlers: TrayHandlers
}

/** 托盘运行态（globalThis 持有：--hot 重求值后 FFI 资源仍存活，模块状态需跟着走） */
interface TrayRuntime {
  user32: TrayUser32
  shellNotifyIcon(msg: number, data: unknown): number
  helperHwnd: bigint
  notifyData: Buffer
  /** JSCallback 保活引用：被 GC 回收 = wndproc 调用即崩，绝不置 null */
  wndProc: { ptr: bigint | number }
  /** 泵/退出钩子的反注册句柄 */
  pumpTimer: ReturnType<typeof setInterval>
  exitHook: () => void
  /** UnregisterClass 需要（类名地址 + 模块句柄） */
  classNameAddr: bigint
  hInstance: bigint
  /** HICON：Shell_NotifyIcon 不接管所有权，destroyTray 必须 DestroyIcon（否则开关循环泄漏） */
  iconHandle: bigint
  /** 类名缓冲的 HeapFree 闭包（捕获 processHeap：--hot 重求值后 runtime 仍能自拆） */
  freeClassNameMem(): number
}

interface TrayGlobal {
  __stlTray?: TrayRuntime
}

// 模块级状态从 globalThis 恢复（--hot 安全），无则 null
let runtime: TrayRuntime | null = (globalThis as TrayGlobal).__stlTray ?? null
/** 当前 handlers；热更后属旧模块实例（见模块头），下次 initTray 自愈 */
let handlers: TrayHandlers | null = null
/** 菜单模态守卫：TrackPopupMenu 期间忽略新右键（模态循环内 wndproc 可重入） */
let menuActive = false

let user32Cache: TrayUser32 | null = null
let shellNotifyIconFn: ((msg: number, data: unknown) => number) | null = null
/** TaskbarCreated 广播消息号（RegisterWindowMessageW；0 = 未注册——wndproc 据此跳过） */
let taskbarCreatedMsg = 0

async function loadFfi(): Promise<void> {
  if (user32Cache && shellNotifyIconFn) return
  const { dlopen, FFIType } = await import('bun:ffi')
  user32Cache = dlopen('user32.dll', {
    RegisterClassW: { args: [FFIType.pointer], returns: FFIType.u16 },
    UnregisterClassW: { args: [FFIType.pointer, FFIType.u64], returns: FFIType.i32 },
    CreateWindowExW: {
      args: [
        FFIType.u32, FFIType.pointer, FFIType.pointer, FFIType.u32,
        FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32,
        FFIType.pointer, FFIType.pointer, FFIType.pointer, FFIType.pointer,
      ],
      // 句柄出参走 u64 才能可靠判 0（FFIType.pointer 出参是 Pointer 对象，!== 0 恒真）
      returns: FFIType.u64,
    },
    DefWindowProcW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
    DestroyWindow: { args: [FFIType.u64], returns: FFIType.i32 },
    RegisterWindowMessageW: { args: [FFIType.pointer], returns: FFIType.u32 },
    PeekMessageW: { args: [FFIType.pointer, FFIType.pointer, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    TranslateMessage: { args: [FFIType.pointer], returns: FFIType.i32 },
    DispatchMessageW: { args: [FFIType.pointer], returns: FFIType.i64 },
    PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
    GetCursorPos: { args: [FFIType.pointer], returns: FFIType.i32 },
    SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
    GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    CreatePopupMenu: { args: [], returns: FFIType.u64 },
    AppendMenuW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
    TrackPopupMenu: { args: [FFIType.u64, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64, FFIType.pointer], returns: FFIType.i32 },
    DestroyMenu: { args: [FFIType.u64], returns: FFIType.i32 },
    DestroyIcon: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols as unknown as TrayUser32
  shellNotifyIconFn = dlopen('shell32.dll', {
    Shell_NotifyIconW: { args: [FFIType.u32, FFIType.pointer], returns: FFIType.i32 },
  }).symbols.Shell_NotifyIconW as (msg: number, data: unknown) => number
}

/**
 * 按当前运行态现建弹出菜单（model → AppendMenuW 翻译层的唯一实现）。
 * 右键菜单与 verify-tray 的进程外内容断言共用——翻译缺陷（漏项/丢标签）在此
 * 被硬断言把守，不再只有肉眼覆盖。返回 0n = 构建失败；调用方负责 DestroyMenu。
 */
function appendMenuEntries(u: TrayUser32, running: boolean): bigint {
  const menu = u.CreatePopupMenu()
  if (menu === 0n) return 0n
  for (const item of buildTrayMenuModel(running)) {
    const ok = item.separator
      ? u.AppendMenuW(menu, MF_SEPARATOR, 0n, 0n)
      : u.AppendMenuW(menu, item.enabled ? MF_STRING : MF_STRING | MF_GRAYED, BigInt(item.id), utf16zBuf(item.label))
    if (ok === 0) {
      u.DestroyMenu(menu)
      return 0n
    }
  }
  return menu
}

/**
 * 构建托盘右键菜单（当前 handlers 的运行态）。仅 win32 + Bun；返回 HMENU，
 * 调用方用完必须 DestroyMenu。供 verify-tray 对真实 HMENU 做内容断言。
 */
export async function createTrayPopupMenu(): Promise<bigint> {
  await loadFfi()
  const u = user32Cache
  if (u === null || handlers === null) return 0n
  return appendMenuEntries(u, handlers.isStRunning())
}

/**
 * 右键菜单：现建 → 前台化 → TrackPopupMenu(TPM_RETURNCMD) → 现毁。
 * SetForegroundWindow + 菜单后 WM_NULL 是 KB135788 套路：漏掉会"点菜单外不消失"。
 */
function showTrayMenu(): void {
  const rt = runtime
  if (rt === null || handlers === null) return
  menuActive = true
  try {
    const menu = appendMenuEntries(rt.user32, handlers.isStRunning())
    if (menu === 0n) throw new Error('CreatePopupMenu/AppendMenuW 失败')
    try {
      const u = rt.user32
      const pt = new Int32Array(2)
      u.GetCursorPos(pt)
      const cmd = u.TrackPopupMenu(
        menu,
        TPM_RETURNCMD | TPM_RIGHTALIGN | TPM_BOTTOMALIGN,
        pt[0],
        pt[1],
        0,
        rt.helperHwnd,
        0n,
      )
      u.PostMessageW(rt.helperHwnd, WM_NULL, 0n, 0n)
      if (cmd !== 0) {
        const h = handlers
        if (cmd === TRAY_CMD.openMain) h.onOpenMain()
        else if (cmd === TRAY_CMD.startSt) h.onStartSt()
        else if (cmd === TRAY_CMD.stopSt) h.onStopSt()
        else if (cmd === TRAY_CMD.restartSt) h.onRestartSt()
        else if (cmd === TRAY_CMD.quit) h.onQuit()
      }
    } finally {
      rt.user32.DestroyMenu(menu)
    }
  } catch (err) {
    logError(`[tray] 打开托盘菜单失败: ${errMsg(err)}`)
  } finally {
    menuActive = false
  }
}

/**
 * 启用系统托盘（幂等：已启用只刷新 handlers——设置页热切换与热更后陈旧闭包的自愈路径）。
 * 失败仅记日志并返回 false——调用方（requestClose 的托盘分流）据此回落原行为，
 * 应用照常运行。非 win32/Bun 环境恒 false（静默降级，不抛错）。
 */
export async function initTray(options: TrayInitOptions): Promise<boolean> {
  if (runtime !== null) {
    handlers = options.handlers
    return true
  }
  if (process.platform !== 'win32' || !process.versions.bun) return false
  // 失败路径回滚凭证：HeapAlloc 类名缓冲**分配即登记**（RegisterClassW 失败也要
  // HeapFree，否则每次失败尝试漏一块不可移动堆内存）；已注册的窗口类必须
  // UnregisterClass，否则重开撞"类已注册"
  let rollback: {
    addr: bigint
    instance: bigint
    heapFree(addr: bigint): number
    classRegistered: boolean
  } | null = null
  try {
    await loadFfi()
    const { dlopen, FFIType, JSCallback } = await import('bun:ffi')
    const user32 = user32Cache as TrayUser32
    const shellNotifyIcon = shellNotifyIconFn as (msg: number, data: unknown) => number

    // 1. wndproc（JSCallback 非 threadsafe：泵在 JS 线程，回调永远同线程抵达）。
    //    只认回调 + TaskbarCreated 两类消息，其余一律 DefWindowProc——保持极小，
    //    explorer 对窗口的稀有直送消息也落到这，任何重活都别放这里。
    //    ⚠ DefWindowProc 必须走模块级 user32Cache 而非 runtime：CreateWindowExW
    //    期间系统同步发 WM_NCCREATE（返回 0 = 建窗中止），那一刻 runtime 尚未
    //    赋值——守卫回落 0n 会让建窗当场失败（verify-tray 实测踩过）。
    //    taskbarCreatedMsg 同理先落模块级变量再建窗。
    const wndProcFn = (hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
      if (msg === TRAY_CALLBACK_MESSAGE) {
        // 经典语义 lParam = 鼠标消息（数值小，直接取低 16 位防御负数符号扩展）
        const mouse = Number(BigInt.asIntN(32, lParam)) & 0xffff
        if ((mouse === WM_LBUTTONUP || mouse === WM_LBUTTONDBLCLK) && handlers) handlers.onOpenMain()
        else if ((mouse === WM_RBUTTONUP || mouse === WM_CONTEXTMENU) && !menuActive) showTrayMenu()
        return 0n
      }
      if (taskbarCreatedMsg !== 0 && msg === taskbarCreatedMsg && runtime !== null) {
        // explorer 重启：原注册已随旧任务栏消亡，重挂即可
        if (runtime.shellNotifyIcon(NIM_ADD, runtime.notifyData) === 0) {
          logError('[tray] explorer 重启后重挂托盘图标失败')
        }
        return 0n
      }
      const u = user32Cache
      if (u === null) return 0n // 不可能：回调只可能在 FFI 加载后抵达
      return u.DefWindowProcW(hwnd, msg, wParam, lParam)
    }
    const wndProc = new JSCallback(wndProcFn, {
      args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64],
      returns: FFIType.i64,
    }) as unknown as { ptr: bigint | number }

    // 2. 注册窗口类 + 建隐藏顶层窗（WS_POPUP 永不显示；标题 NULL 不撞标题+PID 枚举）
    const kernel32 = dlopen('kernel32.dll', {
      GetModuleHandleW: { args: [FFIType.pointer], returns: FFIType.u64 },
      GetProcessHeap: { args: [], returns: FFIType.u64 },
      HeapAlloc: { args: [FFIType.u64, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
      HeapFree: { args: [FFIType.u64, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
    }).symbols as unknown as {
      GetModuleHandleW(name: bigint): bigint
      GetProcessHeap(): bigint
      HeapAlloc(heap: bigint, flags: number, size: number): bigint
      HeapFree(heap: bigint, flags: number, addr: bigint): number
    }
    // msvcrt.memcpy：把类名字节拷进 HeapAlloc 的不可移动内存（WNDCLASSW 内嵌
    // 指针字段需要持久地址，JS Buffer 的 FFI 取址只在调用瞬间有效）
    const memcpy = dlopen('msvcrt.dll', {
      memcpy: { args: [FFIType.pointer, FFIType.pointer, FFIType.u64], returns: FFIType.i32 },
    }).symbols.memcpy as unknown as (dst: bigint, src: unknown, size: number) => number

    const processHeap = kernel32.GetProcessHeap()
    const hInstance = kernel32.GetModuleHandleW(0n)
    const classNameBuf = utf16zBuf(TRAY_WINDOW_CLASS)
    const classNameAddr = kernel32.HeapAlloc(processHeap, HEAP_ZERO_MEMORY, classNameBuf.length)
    if (classNameAddr === 0n) throw new Error('HeapAlloc(类名缓冲) 失败')
    memcpy(classNameAddr, classNameBuf, classNameBuf.length)
    const heapFree = (addr: bigint): number => kernel32.HeapFree(processHeap, 0, addr)
    rollback = { addr: classNameAddr, instance: hInstance, heapFree, classRegistered: false }

    const wc = Buffer.alloc(WNDCLASS_SIZE)
    wc.writeBigUInt64LE(BigInt.asUintN(64, BigInt(wndProc.ptr)), WC_WNDPROC)
    wc.writeBigUInt64LE(hInstance, WC_HINSTANCE)
    wc.writeBigUInt64LE(classNameAddr, WC_CLASSNAME)
    if (user32.RegisterClassW(wc) === 0) throw new Error('RegisterClassW 失败（类已注册或参数非法）')
    rollback.classRegistered = true

    // 消息号先落模块级：wndproc 在建窗期间就可能被调（WM_NCCREATE），读的是它
    taskbarCreatedMsg = user32.RegisterWindowMessageW(utf16zBuf('TaskbarCreated'))
    const helperHwnd = user32.CreateWindowExW(
      0,
      classNameBuf,
      0n,
      WS_POPUP,
      0,
      0,
      0,
      0,
      0n,
      0n,
      hInstance,
      0n,
    )
    if (helperHwnd === 0n) throw new Error('CreateWindowExW 失败')

    // 3. 图标（复用 windowIcon 的预缩放管线，尺寸取系统小图标档）
    const iconHandle = await createHiconFromDataUrl(
      options.iconDataUrl,
      user32.GetSystemMetrics(SM_CXSMICON),
      user32.GetSystemMetrics(SM_CYSMICON),
    )
    if (iconHandle === 0) throw new Error('托盘图标创建失败（CreateIconFromResourceEx 返回 0）')

    const notifyData = buildNotifyIconData({
      hwnd: helperHwnd,
      iconHandle: BigInt(iconHandle),
      callbackMessage: TRAY_CALLBACK_MESSAGE,
      id: 1,
      tooltip: options.tooltip ?? 'SillyTavernLauncher',
    })
    if (shellNotifyIcon(NIM_ADD, notifyData) === 0) {
      throw new Error('Shell_NotifyIconW(NIM_ADD) 失败')
    }

    // 4. JS 线程消息泵（50ms 轮询 PeekMessage；延迟上限即泵周期，托盘交互无感）。
    //    泵容器分配一次复用——每 tick 新分配纯属 GC 白噪
    const msg = Buffer.alloc(MSG_SIZE)
    const pumpTimer = setInterval(() => {
      const u = user32Cache
      if (u === null) return
      while (u.PeekMessageW(msg, 0n, 0, 0, PM_REMOVE) !== 0) {
        u.TranslateMessage(msg)
        u.DispatchMessageW(msg)
      }
    }, 50)

    // 原生退出路径的托盘收尾：NIM_DELETE 同步 FFI 在 exit 钩子内合法
    const exitHook = () => {
      try {
        shellNotifyIcon(NIM_DELETE, notifyData)
      } catch {
        // DEVIATION（错误处理纪律）：exit 钩子运行在解释器关闭阶段，logError 的
        // 文件 IO 此时不可依赖——此处静默吞异常（窗口随进程回收，幽灵图标风险
        // 接受，崩溃路径同款）；运行期路径的异常一律 logError，不适用本豁免
      }
    }
    process.on('exit', exitHook)

    runtime = {
      user32,
      shellNotifyIcon,
      helperHwnd,
      notifyData,
      wndProc,
      pumpTimer,
      exitHook,
      classNameAddr,
      hInstance,
      iconHandle: BigInt(iconHandle),
      freeClassNameMem: () => heapFree(classNameAddr),
    }
    ;(globalThis as TrayGlobal).__stlTray = runtime
    handlers = options.handlers
    console.log(`[tray] 系统托盘已启用（helper hwnd=${helperHwnd}）`)
    return true
  } catch (err) {
    if (rollback !== null) {
      if (rollback.classRegistered) {
        try {
          user32Cache?.UnregisterClassW(rollback.addr, rollback.instance)
        } catch (unregErr) {
          logError(`[tray] 初始化失败回滚：UnregisterClass 失败: ${errMsg(unregErr)}`)
        }
      }
      try {
        rollback.heapFree(rollback.addr)
      } catch (freeErr) {
        logError(`[tray] 初始化失败回滚：HeapFree(类名缓冲) 失败: ${errMsg(freeErr)}`)
      }
    }
    logError(`[tray] 初始化失败: ${errMsg(err)}`)
    return false
  }
}

/** 停用系统托盘（设置页关闭开关；未启用时空操作）。逐项拆除、逐项记错：
 *  单步失败不阻断后续拆除（NIM_DELETE 失败也要拆窗/释放句柄），但绝不静默。 */
export function destroyTray(): void {
  const rt = runtime
  if (rt === null) return
  clearInterval(rt.pumpTimer)
  try {
    rt.shellNotifyIcon(NIM_DELETE, rt.notifyData)
  } catch (err) {
    // 图标已失效（explorer 重启等）属预期路径——记录但继续拆
    logError(`[tray] 移除托盘图标失败（可能 explorer 已重启）: ${errMsg(err)}`)
  }
  try {
    rt.user32.DestroyWindow(rt.helperHwnd)
  } catch (err) {
    logError(`[tray] 拆除 helper 窗失败: ${errMsg(err)}`)
  }
  try {
    rt.user32.UnregisterClassW(BigInt(rt.classNameAddr), rt.hInstance)
  } catch (err) {
    logError(`[tray] 注销窗口类失败（重开托盘可能撞"类已注册"）: ${errMsg(err)}`)
  }
  try {
    rt.user32.DestroyIcon(rt.iconHandle)
  } catch (err) {
    logError(`[tray] 销毁托盘图标句柄失败: ${errMsg(err)}`)
  }
  try {
    rt.freeClassNameMem()
  } catch (err) {
    logError(`[tray] 释放类名堆缓冲失败: ${errMsg(err)}`)
  }
  process.removeListener('exit', rt.exitHook)
  runtime = null
  handlers = null
  ;(globalThis as TrayGlobal).__stlTray = undefined
  console.log('[tray] 系统托盘已停用')
}

/** 托盘是否启用（requestClose 的关闭到托盘分流依据；非 win32/Bun 恒 false） */
export function isTrayActive(): boolean {
  return runtime !== null
}
