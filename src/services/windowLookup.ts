/**
 * 窗口定位服务：枚举顶层窗口，按 标题+PID 双匹配定位目标进程的窗口句柄。
 *
 * ← windowIcon 拆分：枚举职责与图标职责原本混在一个模块，但两者的消费者面
 * 完全不同——图标只服务"本进程窗口"（applyWindowIcon 自用），枚举却被
 * windowControl / 打包冒烟 / 真窗取证脚本复用，且必须支持任意进程探测。
 *
 * 为什么不用 FindWindowW：它只返回 Z 序第一个命中，dev 与 E2E 并存多个
 * 同名启动器窗口时会永远拿到别家实例。
 *
 * 窗口枚举（findWindowByTitleAndPid）为 FFI 导出：任意进程的 标题+PID
 * 双匹配探测，供打包冒烟等进程外观测复用；非 win32+Bun 下抛错而非空操作
 * （观测方需要显式失败，不能与"未找到窗口"混淆）。
 */

// ---------------------------------------------------------------------------
// Win32 FFI：仅 win32 + Bun 运行时执行
// ---------------------------------------------------------------------------

/**
 * 句柄全部按 u64 往来（2026-11-03 真机实测）：
 * `FFIType.pointer` 返回值是 Pointer 对象（Z 序末尾是 `null` 对象，**恒真**），
 * `!== 0` 判空永远不成立，循环只能靠 guard 上限收敛；而 `u64` 返回 bigint，
 * 末尾是真 `0n`，判空可靠。注意只换返回类型不够——`0n !== 0` 恒为 true，
 * 比较字面量必须同步写成 `0n`（同 tray.ts 的 CreateWindowExW 取舍）。
 *
 * 实测（375 个顶层窗口的真机桌面）：pointer + `!== 0` 跑满 2000 次上限；
 * u64 + `!== 0` 同样跑满；u64 + `!== 0n` 在 Z 序末尾自然终止（375 次）。
 */
interface User32Symbols {
  GetTopWindow(hwnd: bigint): bigint
  /** cmd: GW_HWNDNEXT=2 沿 Z 序走兄弟窗口 */
  GetWindow(hwnd: bigint, cmd: number): bigint
  GetWindowTextW(hwnd: bigint, buf: unknown, maxCount: number): number
  GetWindowThreadProcessId(hwnd: bigint, pidOut: unknown): number
}

/** user32 符号懒加载缓存：窗口枚举只 dlopen 一次 */
let user32Symbols: User32Symbols | null = null

async function loadUser32(): Promise<User32Symbols> {
  if (user32Symbols) return user32Symbols
  // 动态引入：vitest(Node) 下模块解析失败必须走调用方 catch 而不是顶层 import
  const { dlopen, FFIType } = await import('bun:ffi')
  user32Symbols = dlopen('user32.dll', {
    GetTopWindow: { args: [FFIType.pointer], returns: FFIType.u64 },
    GetWindow: { args: [FFIType.pointer, FFIType.u32], returns: FFIType.u64 },
    GetWindowTextW: { args: [FFIType.pointer, FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u32 },
  }).symbols as unknown as User32Symbols
  return user32Symbols
}

/**
 * GetTopWindow/GetWindow 链上按 标题+PID 双匹配定位顶层窗口（找不到返回 0）。
 * 不能用 FindWindowW 单命中：它只返回 Z 序第一个标题命中，dev 与 E2E 常态
 * 并存多个同名启动器窗口时会拿到别家实例（见模块头）。
 */
function findWindowByTitleAndPidSync(user32: User32Symbols, title: string, pid: number): number {
  let hwnd = user32.GetTopWindow(0n)
  let guard = 0
  while (hwnd !== 0n && guard++ < 2000) {
    const pidOut = new Uint32Array(1)
    user32.GetWindowThreadProcessId(hwnd, pidOut)
    if (pidOut[0] === pid) {
      const buf = Buffer.alloc(512)
      const len = user32.GetWindowTextW(hwnd, buf, 256)
      // 对外契约仍是 number（调用方按 number 收，windowControl 再 BigInt(found) 回投递）
      if (buf.toString('utf16le', 0, Math.max(0, len) * 2) === title) return Number(hwnd)
    }
    hwnd = user32.GetWindow(hwnd, 2 /* GW_HWNDNEXT */)
  }
  return 0
}

/**
 * 枚举顶层窗口，定位"标题为 title 且属于 pid 进程"的窗口；未找到返回 0。
 * 供进程外观测方（打包冒烟、诊断脚本）判定目标进程的窗口是否已创建。
 * 跨进程读标题安全：GetWindowTextW 读系统缓存副本，不向目标窗口泵发消息。
 */
export async function findWindowByTitleAndPid(title: string, pid: number): Promise<number> {
  if (process.platform !== 'win32' || !process.versions.bun) {
    throw new Error('窗口枚举仅支持 win32 + Bun 运行时')
  }
  return findWindowByTitleAndPidSync(await loadUser32(), title, pid)
}
