/**
 * Windows 进程完整性级别（Mandatory Integrity Control）探测与修复指引。
 *
 * 背景（2026-11 用户报障）：启动器 exe 落在带 Low 完整性标签（S-1-16-4096）
 * 的目录后（沙箱/审计工具会给工作区根目录打继承标签），Windows 按"用户与镜像
 * 标签的较低者"创建进程——启动器以 Low 运行，对中完整性的 config.json、日志、
 * SillyTavern settings.json 的写入被 SYSTEM_MANDATORY_LABEL_NO_WRITE_UP 拒绝
 * （EPERM）。Low 进程无法提升自身镜像标签（实测低标签 icacls 报"安全 ID 不能
 * 作为对象的标签分配"），因此运行期只能精确探测 + 引导用户更换存放目录；
 * 构建侧由 scripts/build-onefile.ts 把 dist/ 与产物归一为 Medium。
 *
 * 纯函数（RID → 级别、换目录文案）在 Node/vitest 可测；FFI 部分仅 win32 + Bun
 * 运行时执行，其余环境显式抛错，由启动链路 catch + logError 记录。
 */
import { dirname } from 'node:path'
import { formatMoveLauncherGuide } from './launcherDirectoryGuide'

export type IntegrityLevel =
  | 'untrusted'
  | 'low'
  | 'medium'
  | 'high'
  | 'system'
  | 'protected'
  | 'unknown'

/** 完整性 SID 的最后一个子权威（RID）→ 级别（Well-known SIDs：S-1-16-*） */
const INTEGRITY_LEVEL_BY_RID: ReadonlyMap<number, IntegrityLevel> = new Map([
  [0x0000, 'untrusted'],
  [0x1000, 'low'],
  [0x2000, 'medium'],
  [0x3000, 'high'],
  [0x4000, 'system'],
  [0x5000, 'protected'],
])

/** TokenIntegrityLevel 的 SID RID → 级别；未知 RID 返回 'unknown'（不猜测） */
export function integrityLevelFromRid(rid: number): IntegrityLevel {
  return INTEGRITY_LEVEL_BY_RID.get(rid) ?? 'unknown'
}

const LEVEL_LABEL: Record<'low' | 'untrusted', string> = {
  low: 'Low（S-1-16-4096）',
  untrusted: 'Untrusted（S-1-16-0）',
}

export interface IntegrityRemediation {
  /** 现象（展示在错误对话框正文区，面向普通用户） */
  message: string
  /** 更换存放目录步骤（对话框详情区） */
  detail: string
  /** 级别/路径/icacls 命令（只进 errorLog，不展示） */
  technicalDetail: string
}

/**
 * Low/Untrusted 进程的用户指引（纯函数，单测锁定"界面只给换目录、技术命令只进日志"）。
 *
 * 首屏不暴露 icacls：目标用户是电脑小白，把启动器复制到普通文件夹即可获得
 * Medium 标签（新目录创建的文件继承目标目录标签）。技术命令覆盖数据根、exe
 * 目录与 exe 本身，供 errorLog/支持排查；目录相同时去重。
 */
export function formatLowIntegrityRemediation(
  level: 'low' | 'untrusted',
  installRoot: string,
  exePath: string,
): IntegrityRemediation {
  const dirs = [...new Set([installRoot, dirname(exePath)])]
  const commands = [
    ...dirs.map((dir) => `icacls "${dir}" /setintegritylevel "(OI)(CI)Medium"`),
    `icacls "${exePath}" /setintegritylevel "Medium"`,
  ]
  return {
    message: [
      '启动器所在的文件夹限制了它保存文件：设置、日志和酒馆数据都会写入失败。',
      '请把启动器换到一个普通文件夹（步骤见下）。',
    ].join('\n'),
    detail: formatMoveLauncherGuide(),
    technicalDetail: [
      `进程完整性级别：${LEVEL_LABEL[level]}`,
      `启动器目录：${installRoot}`,
      `可执行文件：${exePath}`,
      '',
      '技术修复（可选；普通用户按界面步骤更换目录即可）：',
      ...commands,
    ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Win32 FFI：TokenIntegrityLevel 查询（仅 win32 + Bun 运行时执行）
// ---------------------------------------------------------------------------

interface Kernel32IntegritySymbols {
  /** 伪句柄 (HANDLE)-1；句柄域一律 u64（pointer 出参无法可靠判空，见 windowLookup） */
  GetCurrentProcess(): bigint
  CloseHandle(handle: bigint): number
  GetLastError(): number
}

interface Advapi32IntegritySymbols {
  OpenProcessToken(processHandle: bigint, desiredAccess: number, tokenOut: unknown): number
  GetTokenInformation(
    tokenHandle: bigint,
    infoClass: number,
    infoOut: unknown,
    infoLen: number,
    returnLenOut: unknown,
  ): number
}

const TOKEN_QUERY = 0x0008
const TOKEN_INTEGRITY_LEVEL_CLASS = 25
/** TOKEN_MANDATORY_LABEL 足够放下 SID_AND_ATTRIBUTES + 单个 SID；256 字节留裕量 */
const TOKEN_INFO_BUFFER_BYTES = 256

/**
 * 读取当前进程 token 的完整性级别（GetTokenInformation(TokenIntegrityLevel)）。
 * 返回的 TOKEN_MANDATORY_LABEL.Label.Sid 指向缓冲区内的完整性 SID，RID 位于
 * 最后一个子权威（SID 头 8 字节 + (count-1)×4）。
 */
export async function currentProcessIntegrityLevel(): Promise<IntegrityLevel> {
  if (process.platform !== 'win32' || !process.versions.bun) {
    throw new Error(
      `完整性级别探测仅支持 win32 + Bun 运行时（当前 ${process.platform}，bun=${String(process.versions.bun)}）`,
    )
  }
  // 动态引入：vitest(Node) 下模块解析失败必须走调用方 catch 而不是顶层 import
  const { dlopen, FFIType, read } = await import('bun:ffi')
  const kernel32 = dlopen('kernel32.dll', {
    GetCurrentProcess: { args: [], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols as unknown as Kernel32IntegritySymbols
  const advapi32 = dlopen('advapi32.dll', {
    OpenProcessToken: {
      args: [FFIType.u64, FFIType.u32, FFIType.pointer],
      returns: FFIType.i32,
    },
    GetTokenInformation: {
      args: [FFIType.u64, FFIType.u32, FFIType.pointer, FFIType.u32, FFIType.pointer],
      returns: FFIType.i32,
    },
  }).symbols as unknown as Advapi32IntegritySymbols

  const tokenOut = new BigUint64Array(1)
  if (advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), TOKEN_QUERY, tokenOut) === 0) {
    throw new Error(`OpenProcessToken 失败（GetLastError=${kernel32.GetLastError()}）`)
  }
  const token = tokenOut[0] as bigint
  try {
    const info = new Uint8Array(TOKEN_INFO_BUFFER_BYTES)
    const returnLen = new Uint32Array(1)
    if (
      advapi32.GetTokenInformation(
        token,
        TOKEN_INTEGRITY_LEVEL_CLASS,
        info,
        info.byteLength,
        returnLen,
      ) === 0
    ) {
      throw new Error(`GetTokenInformation(TokenIntegrityLevel) 失败（GetLastError=${kernel32.GetLastError()}）`)
    }
    // SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } —— x64 下 Sid 在偏移 0
    const view = new DataView(info.buffer, info.byteOffset, info.byteLength)
    const sidAddress = Number(view.getBigUint64(0, true))
    if (sidAddress === 0) throw new Error('GetTokenInformation 返回空完整性 SID 指针')
    const revision = read.u8(sidAddress, 0)
    const subAuthorityCount = read.u8(sidAddress, 1)
    if (revision !== 1 || subAuthorityCount < 1) {
      throw new Error(`完整性 SID 形态异常（revision=${revision}, subAuthorities=${subAuthorityCount}）`)
    }
    const rid = read.u32(sidAddress, 8 + (subAuthorityCount - 1) * 4)
    return integrityLevelFromRid(rid)
  } finally {
    kernel32.CloseHandle(token)
  }
}