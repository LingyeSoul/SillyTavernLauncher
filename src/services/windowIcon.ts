/**
 * 窗口图标服务：让 win32 任务栏/Alt-Tab 渲染启动器 logo。
 * 注（2026-09-22 自绘标题栏 O12 起）：原生标题栏被 titlebarTransparent 隐藏后，
 * ICON_SMALL/SMALL2 两个槽位已无可见消费者（标题栏图标位不存在），本服务只剩
 * 任务栏/Alt-Tab 两处收益——三槽位投递链路与顺序**保持不变**（改动无收益、有回归风险）。
 *
 * 为什么不用 GPUIX 的 API：@gpuix/native 0.9.0 的 WindowOptions 没有 icon
 * 字段，native 导出面（activateWindow/setWindowTitle/...）也没有任何窗口
 * 句柄或图标入口（已核实二进制符号表）。因此走 Win32 侧自力更生：
 *   枚举顶层窗口（GetTopWindow/GetWindow 链）按 标题+PID 双匹配定位本进程窗口
 *   → CreateIconFromResourceEx(PNG 字节直喂，Vista+ 支持 PNG 图标资源)
 *   → PostMessageW(WM_SETICON, ICON_SMALL / ICON_BIG / ICON_SMALL2)
 *   （不用 FindWindowW：它只返回 Z 序第一个命中，dev 与 E2E 并存多个
 *   同名启动器窗口时会永远拿到别家实例）
 *
 * 关键决策（全部经 bun:ffi 冒烟验证，见 scripts/verify-window-icon.ts）：
 * - PostMessageW 而非 SendMessageW：GPUIX 的 UI 消息泵在独立原生线程，
 *   跨线程 SendMessage 会阻塞等待对端泵消息，存在树互斥死锁风险；
 *   PostMessage 异步投递无此问题。
 * - 多尺寸预缩放而非 256 一张走天下：标题栏 16px 直接拉伸 256 图会发糊，
 *   这里在 JS 里做 area-average 预缩放（预乘 alpha 防透明边缘黑晕），
 *   16/20/24/32/48/64/256 全档覆盖各 DPI。
 * - 图标源用内嵌 dataURL 解出的 PNG 字节（复用 ui/assets/logo 的常量，
 *   纯数据无 UI 依赖），不读文件——bun build --compile 单 exe 无随包资产。
 *
 * 纯函数部分（解码/缩放/编码）在 Node/vitest 下可测；FFI 部分仅
 * win32 + Bun 运行时执行，其余环境为静默空操作（非错误路径）。
 * 窗口枚举（findWindowByTitleAndPid）为 FFI 导出：任意进程的 标题+PID
 * 双匹配探测，供打包冒烟等进程外观测复用；非 win32+Bun 下抛错而非空操作
 * （观测方需要显式失败，不能与"未找到窗口"混淆）。
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { logError } from './errorLog'

// ---------------------------------------------------------------------------
// 纯函数：PNG 解码 / 缩放 / 编码（Node & Bun 皆可运行，供单测）
// ---------------------------------------------------------------------------

export interface DecodedImage {
  width: number
  height: number
  /** RGBA，每像素 4 字节，straight alpha */
  rgba: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * 解码 PNG 为 RGBA。仅支持本仓库资产画像：8-bit、真彩（RGB/RGBA）、
 * 非隔行——logo.png 即此格式；其余格式抛错（调用方 logError 后放弃，
 * 窗口退回默认 exe 图标，不影响应用运行）。
 */
export function decodePngRgba(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('不是 PNG 文件（签名不匹配）')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatChunks: Uint8Array[] = []
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos)
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const dataStart = pos + 8
    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8]
      colorType = bytes[dataStart + 9]
      interlace = bytes[dataStart + 12]
    } else if (type === 'IDAT') {
      idatChunks.push(bytes.subarray(dataStart, dataStart + length))
    } else if (type === 'IEND') {
      break
    }
    pos = dataStart + length + 4 // 跳过 CRC
  }
  if (width <= 0 || height <= 0 || idatChunks.length === 0) throw new Error('PNG 结构不完整')
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`不支持的 PNG 格式：bitDepth=${bitDepth} colorType=${colorType}（仅支持 8-bit RGB/RGBA）`)
  }
  if (interlace !== 0) throw new Error('不支持隔行 PNG（interlace）')

  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idatChunks))
  const stride = width * channels
  const rgba = new Uint8Array(width * height * 4)
  // 逐行反滤波（filter 0-4；bpp=channels）
  let prev = new Uint8Array(stride)
  let cur = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    cur.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (filter === 1) cur[x] = (cur[x] + a) & 0xff
      else if (filter === 2) cur[x] = (cur[x] + b) & 0xff
      else if (filter === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    const rowStart = y * stride
    for (let x = 0; x < width; x++) {
      rgba[(y * width + x) * 4] = cur[x * channels]
      rgba[(y * width + x) * 4 + 1] = cur[x * channels + 1]
      rgba[(y * width + x) * 4 + 2] = cur[x * channels + 2]
      rgba[(y * width + x) * 4 + 3] = channels === 4 ? cur[x * channels + 3] : 255
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  return { width, height, rgba }
}

/**
 * area-average（盒式）下采样，可分离两趟；对 alpha 预乘后平均再反预乘，
 * 避免透明边缘与不透明区域混合时产生暗晕。放大场景退化为最近邻
 * （图标场景只会用到缩小/等尺寸）。
 */
export function resizeRgba(src: DecodedImage, dw: number, dh: number): Uint8Array {
  const { width: sw, height: sh, rgba } = src
  if (dw === sw && dh === sh) return new Uint8Array(rgba)
  if (dw <= 0 || dh <= 0 || dw > sw || dh > sh) {
    throw new Error(`不支持的缩放尺寸：${sw}x${sh} -> ${dw}x${dh}（仅支持缩小/等尺寸）`)
  }
  // 水平趟：sw -> dw，结果存 Float64（预乘 RGBA）
  const mid = new Float64Array(dw * sh * 4)
  const scaleX = sw / dw
  for (let y = 0; y < sh; y++) {
    for (let dx = 0; dx < dw; dx++) {
      const start = dx * scaleX
      const end = (dx + 1) * scaleX
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sx = Math.floor(start); sx < end && sx < sw; sx++) {
        const w = Math.min(end, sx + 1) - Math.max(start, sx)
        const i = (y * sw + sx) * 4
        r += rgba[i] * rgba[i + 3] * w
        g += rgba[i + 1] * rgba[i + 3] * w
        b += rgba[i + 2] * rgba[i + 3] * w
        a += rgba[i + 3] * w
      }
      const o = (y * dw + dx) * 4
      mid[o] = r
      mid[o + 1] = g
      mid[o + 2] = b
      mid[o + 3] = a
    }
  }
  // 垂直趟：sh -> dh，边平均边反预乘输出 straight alpha 的 8-bit
  const out = new Uint8Array(dw * dh * 4)
  const scaleY = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    const start = dy * scaleY
    const end = (dy + 1) * scaleY
    for (let dx = 0; dx < dw; dx++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = Math.floor(start); sy < end && sy < sh; sy++) {
        const w = Math.min(end, sy + 1) - Math.max(start, sy)
        const i = (sy * dw + dx) * 4
        r += mid[i] * w
        g += mid[i + 1] * w
        b += mid[i + 2] * w
        a += mid[i + 3] * w
      }
      const o = (dy * dw + dx) * 4
      if (a <= 0) {
        out[o + 3] = 0
        continue
      }
      out[o] = Math.round(Math.min(255, r / a))
      out[o + 1] = Math.round(Math.min(255, g / a))
      out[o + 2] = Math.round(Math.min(255, b / a))
      out[o + 3] = Math.round(Math.min(255, a / (scaleX * scaleY)))
    }
  }
  return out
}

/** PNG CRC32（node:zlib 的 crc32 有版本门槛，自实现零依赖） */
function crc32(bytes: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** 编码 RGBA 为 8-bit RGBA PNG（全行 filter 0；CreateIconFromResourceEx 可直接解码） */
export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = new Uint8Array(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  const idat = deflateSync(Buffer.from(raw), { level: 9 })
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))])
}

/** 从 dataURL（data:image/png;base64,...）提取 PNG 字节 */
export function pngBytesFromDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.startsWith('data:')) throw new Error('非法 dataURL')
  return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), 'base64'))
}

/** 图标尺寸档位：覆盖 16（标题栏）到 256（任务栏大图/预览）各 DPI 取值 */
export const ICON_SIZES = [16, 20, 24, 32, 48, 64, 256] as const

/** 就近选档（等距取小档，宁可锐利不可糊） */
export function pickNearestSize(target: number): number {
  let best: number = ICON_SIZES[0]
  for (const size of ICON_SIZES) {
    if (Math.abs(size - target) < Math.abs(best - target)) best = size
  }
  return best
}

// ---------------------------------------------------------------------------
// Win32 FFI：仅 win32 + Bun 运行时执行
// ---------------------------------------------------------------------------

const WM_SETICON = 0x0080
const ICON_SMALL = 0
const ICON_BIG = 1
/** 高 DPI 下标题栏备用小图标槽位（Chromium 同款三连设置） */
const ICON_SMALL2 = 2
const SM_CXICON = 11
const SM_CYICON = 12
const SM_CXSMICON = 49
const SM_CYSMICON = 50

interface User32Symbols {
  GetTopWindow(hwnd: unknown): number
  /** cmd: GW_HWNDNEXT=2 沿 Z 序走兄弟窗口 */
  GetWindow(hwnd: number, cmd: number): number
  GetWindowTextW(hwnd: number, buf: unknown, maxCount: number): number
  GetWindowThreadProcessId(hwnd: number, pidOut: unknown): number
  GetSystemMetrics(index: number): number
  CreateIconFromResourceEx(bits: unknown, size: number, isIcon: number, version: number, cx: number, cy: number, flags: number): number
  PostMessageW(hwnd: number, msg: number, wParam: bigint, lParam: bigint): number
}
interface Kernel32Symbols {
  GetCurrentProcessId(): number
}

/** --hot 模块重求值去重（globalThis 跨热更存活） */
interface IconAppliedFlag {
  __stlWindowIconApplied?: boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** user32 符号懒加载缓存：applyWindowIcon 与 findWindowByTitleAndPid 共用一次 dlopen */
let user32Symbols: User32Symbols | null = null

async function loadUser32(): Promise<User32Symbols> {
  if (user32Symbols) return user32Symbols
  // 动态引入：vitest(Node) 下模块解析失败必须走调用方 catch 而不是顶层 import
  const { dlopen, FFIType } = await import('bun:ffi')
  user32Symbols = dlopen('user32.dll', {
    GetTopWindow: { args: [FFIType.pointer], returns: FFIType.pointer },
    GetWindow: { args: [FFIType.pointer, FFIType.u32], returns: FFIType.pointer },
    GetWindowTextW: { args: [FFIType.pointer, FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u32 },
    GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    CreateIconFromResourceEx: {
      args: [FFIType.pointer, FFIType.u32, FFIType.i32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
      returns: FFIType.pointer,
    },
    PostMessageW: { args: [FFIType.pointer, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
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

/**
 * 为本进程标题为 title 的窗口设置图标（icon 源为 PNG dataURL 字符串，
 * 解析在本函数 try 内进行，调用点无裸抛路径）。win32 + Bun 之外静默空操作；
 * 内部自吞异常（logError 记录），任何失败都不影响应用主流程——
 * 最坏情况窗口保持默认 exe 图标。
 */
export async function applyWindowIcon(dataUrl: string, title: string): Promise<void> {
  const flag = globalThis as IconAppliedFlag
  if (flag.__stlWindowIconApplied) return
  flag.__stlWindowIconApplied = true
  if (process.platform !== 'win32' || !process.versions.bun) return
  try {
    const user32 = await loadUser32()
    const { dlopen, FFIType } = await import('bun:ffi')
    const kernel32 = dlopen('kernel32.dll', {
      GetCurrentProcessId: { args: [], returns: FFIType.u32 },
    }).symbols as unknown as Kernel32Symbols

    // 1. 枚举顶层窗口找"标题匹配 + 属于本进程"的那个
    //    （FindWindowW 单命中的陷阱见 findWindowByTitleAndPidSync 注释）。
    const myPid = kernel32.GetCurrentProcessId()
    // render() 同步建窗，但留重试兜底（标题设置或窗口链入 Z 序的极短窗口期）
    let hwnd = 0
    for (let attempt = 0; attempt < 10 && hwnd === 0; attempt++) {
      hwnd = findWindowByTitleAndPidSync(user32, title, myPid)
      if (hwnd === 0) await sleep(100)
    }
    if (hwnd === 0) throw new Error('未找到本进程的窗口（枚举 10 次重试后放弃）')

    // 2. 按系统图标槽位尺寸预缩放并创建 HICON。
    //    dataURL 解析必须留在 try 内：非法格式（logo.ts 手工重生成手误）
    //    要走 catch 的 logError，上移到调用点求值会绕过 try 直接炸主流程
    const pngBytes = pngBytesFromDataUrl(dataUrl)
    const source = decodePngRgba(pngBytes)
    const makeIcon = (targetW: number, targetH: number): number => {
      const w = pickNearestSize(targetW)
      const h = pickNearestSize(targetH)
      const png =
        w === source.width && h === source.height
          ? pngBytes // 原尺寸直接复用原始字节，避免重编码损失
          : encodePngRgba(resizeRgba(source, w, h), w, h)
      return user32.CreateIconFromResourceEx(png, png.length, 1, 0x00030000, 0, 0, 0)
    }
    const hIconSmall = makeIcon(user32.GetSystemMetrics(SM_CXSMICON), user32.GetSystemMetrics(SM_CYSMICON))
    const hIconBig = makeIcon(user32.GetSystemMetrics(SM_CXICON), user32.GetSystemMetrics(SM_CYICON))
    if (hIconSmall === 0 || hIconBig === 0) throw new Error(`CreateIconFromResourceEx 失败：small=${hIconSmall} big=${hIconBig}`)

    // 3. 三槽位投递（PostMessage 异步，避免跨线程 SendMessage 死锁风险）。
    //    顺序必须 SMALL2 → SMALL → BIG：实测 gpui 窗口 wndproc 对
    //    WM_SETICON(ICON_SMALL2) 的存储与 BIG 槽位别名（投 SMALL2 会把
    //    BIG 覆盖成同值），BIG 放最后才能让 32px 图标落在终态，
    //    否则任务栏拿到的是 16px 图标放大（发糊）。
    const posted =
      user32.PostMessageW(hwnd, WM_SETICON, BigInt(ICON_SMALL2), BigInt(hIconSmall)) &
      user32.PostMessageW(hwnd, WM_SETICON, BigInt(ICON_SMALL), BigInt(hIconSmall)) &
      user32.PostMessageW(hwnd, WM_SETICON, BigInt(ICON_BIG), BigInt(hIconBig))
    if (posted === 0) throw new Error('PostMessageW(WM_SETICON) 投递失败')
    console.log(`[windowIcon] 标题栏/任务栏图标已设置（small=${hIconSmall} big=${hIconBig}）`)
  } catch (err) {
    logError(`[windowIcon] 设置窗口图标失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}
