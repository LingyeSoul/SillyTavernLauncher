/**
 * 跨服务共享类型（services 层，禁止依赖 UI / store / React）。
 *
 * 对应迁移：src/config/config_manager.py、src/core/git_utils.py、
 * src/features/st/config.py、src/core/terminal.py（进程部分）。
 */

/** 进程输出的单行日志（stdout / stderr 已按行切分并解码） */
export interface LogLine {
  stream: 'stdout' | 'stderr'
  text: string
}

/**
 * 统一子进程接口。
 * 生产宿主是 Bun（Bun.spawn），vitest 下回退 node:child_process——
 * 两侧都归一化为 web ReadableStream + awaited exited（见 services/runtime.ts）。
 */
export interface Subprocess {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  /** 进程退出时 resolve 退出码；spawn 失败时 reject */
  readonly exited: Promise<number>
  /** 进程仍在运行时为 null（用于“是否需要强杀”判断） */
  readonly exitCode: number | null
  /** 发送信号终止进程（默认 SIGTERM 语义；Windows 上为强制终止） */
  kill(signal?: number | string): void
}

/** 同步 spawn 结果（对应 Python subprocess.run + capture_output） */
export interface SyncSpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** 活动进程注册表条目 ← terminal.py 的 proc_info dict */
export interface ProcessInfo {
  pid: number
  command: string
  createdAt: number
  proc: Subprocess
  /** 进程退出且两条输出流全部消费完成后 resolve */
  whenSettled: Promise<void>
  /**
   * 进程语义分类：'st-server' = SillyTavern 服务进程，其余（git/npm 等临时任务）不标记。
   * UI 的 running 派生与运行判断只认 st-server（← Python is_running 显式标志语义，
   * 修复：全量计数会把安装/更新期间的 git/npm 误报为「运行中」）。
   */
  kind?: string
}

/** ← git_utils.py get_st_tags 返回的 tag 信息 */
export interface GitTag {
  commit: string
  date: string
  tag_name: string
}

export interface StTagsData {
  versions: Record<string, GitTag>
  latest: string
}

/** Python (success, message) 元组的等价物 */
export interface BoolMessage {
  ok: boolean
  message: string
}

/** ← get_current_commit 的 (success, commit, message) */
export interface CommitResult extends BoolMessage {
  commit: string | null
}

/** ← get_st_tags 的 (success, tags_data, message) */
export interface TagsResult {
  ok: boolean
  data: StTagsData | null
  message: string
}

/** ← st/config.py stcfg 托管的 SillyTavern config.yaml 字段视图 */
export interface StConfigShape {
  listen: boolean
  port: number
  requestProxy: { enabled: boolean; url: string }
  hostWhitelist: { enabled: boolean; scan: boolean; hosts: string[] }
  whitelistMode: boolean
  enableForwardedWhitelist: boolean
  whitelist: string[]
  unifiedWhitelist: boolean
  privateAddressWhitelist: {
    enabled: boolean
    allowUnresolvedHosts: boolean
    log: { blockedRequests: boolean; allowedRequests: boolean }
    allowedRanges: string[]
  }
}
