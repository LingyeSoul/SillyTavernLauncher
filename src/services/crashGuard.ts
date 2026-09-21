/**
 * 进程级异常兜底：把 uncaughtException / unhandledRejection 落盘 logs/Error_*.txt。
 *
 * 动机（RCA：关窗偶发报错未捕获，2026-09 采样复现）：点窗口 X 后 gpui 开始
 * 拆除窗口、GPU UI 线程停机，但 Bun 事件循环短暂存活——拆除窗口期恰有一帧
 * React commit 落地时，reconciler 的 flushMutations → applyBatch 调 GPU API
 * 抛 "The GPUI UI thread is not running"（GenericFailure），成为
 * uncaughtException；@gpuix 自带的 handler 只打 stderr 并尝试弹错误浮层
 * （此时 UI 线程已死，浮层二次失败，无害），进程退出码 0。该错误链不经过
 * logError，logs/Error_*.txt 永远收不到——本模块补上这条落盘通道。
 *
 * 噪音过滤（2026-09-21 追加，用户反馈关窗报错写入文件）：上述关窗竞态是已知、
 * 无害、不可在启动器侧修复的退出期噪音（gpui 拆除时序决定），落盘只会给用户留下
 * "报错"假象。已知噪音经 isShutdownNoise 精确匹配后跳过落盘；gpuix handler 的
 * stderr 留痕与进程退出语义完全不变（只增不替）。清单只收实测采样到的模式，
 * 宁漏勿滥——真崩溃与噪音共用同一 handler，过滤过宽会吞掉真问题。
 *
 * 语义约束：只增不替——@gpuix 的 handler 与进程默认退出行为保持原样（其在场
 * 时实测退出码 0，本兜底只落盘）。防御（2026-09-21）：安装时记录两类事件的
 * 既有 listener 数；若本兜底是唯一 listener（gpuix 升级移除其 handler 的场景），
 * 落盘后以无兜底时的原生崩溃退出码结束——仅记录不退出会让致命异常后进程
 * 带伤存活，同样违背"只增不替"。噪音沿用同一退出语义：只跳过落盘，不干预退出。
 */
import { errMsg, logError } from './errorLog'

/** --hot 模块重求值去重（globalThis 跨热更存活，同 windowIcon 模式） */
interface CrashGuardFlag {
  __stlCrashGuardInstalled?: boolean
}

/**
 * 已知退出期噪音模式（精确子串匹配 message，实测采样录入）：
 * - 'The GPUI UI thread is not running'：关窗后 GPU UI 线程已停、事件循环里
 *   恰有一帧 React commit 落地时 reconciler 抛出（GenericFailure）。进程正在
 *   关闭（gpuix handler 在场时退出码恒 0），无需落盘。
 */
const SHUTDOWN_NOISE_PATTERNS: readonly string[] = ['The GPUI UI thread is not running']

/**
 * 判定已知退出期噪音。匹配不到的一律照常落盘（真崩溃优先保留）；
 * 导出供单测直接覆盖判定边界。
 */
export function isShutdownNoise(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return SHUTDOWN_NOISE_PATTERNS.some((pattern) => message.includes(pattern))
}

/**
 * 安装进程级异常落盘兜底（幂等）。必须在 app 入口、render 之前调用：
 * 注册越早，启动早期异常的覆盖面越大。
 */
export function installCrashGuard(): void {
  const flag = globalThis as CrashGuardFlag
  if (flag.__stlCrashGuardInstalled) return
  flag.__stlCrashGuardInstalled = true

  // 独监听防御：见头部「语义约束」。注册前记录基线——gpuix handler 在场时
  // 恒为 false，退出语义与无本兜底时完全一致
  const soloUncaught = process.listenerCount('uncaughtException') === 0
  const soloRejection = process.listenerCount('unhandledRejection') === 0

  process.on('uncaughtException', (err: unknown) => {
    // 已知退出期噪音只跳过落盘（gpuix handler 已在 stderr 留痕，此处不再重复）；
    // exit 语义与独监听防御保持原样。logError 自带文件通道降级兜底，绝不再抛
    if (!isShutdownNoise(err)) {
      logError('[crashGuard] uncaughtException:', err)
    }
    if (soloUncaught) process.exit(1)
  })

  process.on('unhandledRejection', (reason: unknown) => {
    // 同 uncaughtException：同一 GPUI 噪音若改走 promise 路径，同等过滤
    if (!isShutdownNoise(reason)) {
      logError(`[crashGuard] unhandledRejection: ${errMsg(reason)}`)
    }
    if (soloRejection) process.exit(1)
  })
}
