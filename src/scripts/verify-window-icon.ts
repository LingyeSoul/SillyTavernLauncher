/**
 * 校验脚本：窗口图标链路自检（win32 + Bun 下运行，其他环境直接退出）。
 *
 * 两种用法：
 *   bun scripts/verify-window-icon.ts
 *     自检模式：从 src/assets/logo.png 直接创建 HICON，验证
 *     CreateIconFromResourceEx 对 PNG 字节可用（无需应用在跑）。
 *   bun scripts/verify-window-icon.ts --probe "SillyTavernLauncher" [--pid 1234]
 *     探针模式：找到该标题的运行中窗口，WM_GETICON 反查三个槽位
 *     （ICON_SMALL/BIG/SMALL2）当前持有的 HICON，与应用侧
 *     applyWindowIcon 日志中的句柄对照即完成外部取证。
 *     --pid：按进程号过滤。dev 与 E2E 同名窗口并存时标题单匹配会撞上
 *     别家实例（同 FindWindowW 陷阱），此时取证必须带 PID。
 */
import { dlopen, FFIType } from 'bun:ffi'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  console.log('非 win32 平台，跳过')
  process.exit(0)
}

const WM_GETICON = 0x007f
const ICON_SMALL = 0
const ICON_BIG = 1
const ICON_SMALL2 = 2
const SMTO_ABORTIFHUNG = 0x0002

const user32 = dlopen('user32.dll', {
  CreateIconFromResourceEx: {
    args: [FFIType.pointer, FFIType.u32, FFIType.i32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
    returns: FFIType.pointer,
  },
  DestroyIcon: { args: [FFIType.pointer], returns: FFIType.i32 },
  GetTopWindow: { args: [FFIType.pointer], returns: FFIType.pointer },
  GetWindow: { args: [FFIType.pointer, FFIType.u32], returns: FFIType.pointer },
  GetWindowTextW: { args: [FFIType.pointer, FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
  GetWindowThreadProcessId: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u32 },
  SendMessageTimeoutW: {
    args: [FFIType.pointer, FFIType.u32, FFIType.u64, FFIType.i64, FFIType.u32, FFIType.u32, FFIType.pointer],
    returns: FFIType.i64,
  },
}).symbols

const probeTitle = process.argv.includes('--probe') ? process.argv[process.argv.indexOf('--probe') + 1] : null
const pidArg = process.argv.includes('--pid') ? Number(process.argv[process.argv.indexOf('--pid') + 1]) : null

if (!probeTitle) {
  // 自检模式：PNG 字节 → HICON
  const png = readFileSync(join(import.meta.dir, '..', 'assets', 'logo.png'))
  const hIcon = user32.CreateIconFromResourceEx(png, png.length, 1, 0x00030000, 0, 0, 0)
  if (hIcon === 0) {
    console.error('FAIL: CreateIconFromResourceEx 返回 NULL')
    process.exit(1)
  }
  user32.DestroyIcon(hIcon)
  console.log(`OK: logo.png -> HICON(${hIcon}) 创建/销毁成功`)
  process.exit(0)
}

// 探针模式：枚举找标题（可选按 PID 过滤），WM_GETICON 反查
const readTitle = (hwnd: number): string => {
  const buf = Buffer.alloc(512)
  const n = user32.GetWindowTextW(hwnd, buf, 256)
  return buf.toString('utf16le', 0, Math.max(0, n) * 2)
}
const readPid = (hwnd: number): number => {
  const pid = new Uint32Array(1)
  user32.GetWindowThreadProcessId(hwnd, pid)
  return pid[0]
}
let hwnd = user32.GetTopWindow(0n)
let found = 0
let foundPid = 0
let guard = 0
while (hwnd !== 0 && guard++ < 2000) {
  if (readTitle(hwnd) === probeTitle) {
    const pid = readPid(hwnd)
    if (pidArg === null || pid === pidArg) {
      found = hwnd
      foundPid = pid
      break
    }
  }
  hwnd = user32.GetWindow(hwnd, 2 /* GW_HWNDNEXT */)
}
if (found === 0) {
  console.error(
    pidArg === null
      ? `FAIL: 未找到标题为 "${probeTitle}" 的窗口`
      : `FAIL: 未找到标题为 "${probeTitle}" 且 PID=${pidArg} 的窗口`,
  )
  process.exit(1)
}
const getIcon = (slot: number): string => {
  const result = new BigUint64Array(1)
  const ok = user32.SendMessageTimeoutW(found, WM_GETICON, BigInt(slot), 0n, SMTO_ABORTIFHUNG, 500, result)
  return ok === 0 ? '超时' : String(result[0])
}
console.log(`窗口 ${probeTitle} (hwnd=${found}, pid=${foundPid}) 当前图标槽位：`)
console.log(`  ICON_SMALL  = ${getIcon(ICON_SMALL)}`)
console.log(`  ICON_BIG    = ${getIcon(ICON_BIG)}`)
console.log(`  ICON_SMALL2 = ${getIcon(ICON_SMALL2)}`)
