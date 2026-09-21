/**
 * ← src/core/git_utils.py（近乎 1:1 移植）
 *
 * 安全纪律（设计计划 §7：安全逻辑必须 1:1 移植）：
 * - runGit 只接受参数数组，绝不 shell 字符串拼接（对应 Python shell=False）。
 * - windowsHide: true 隐藏子窗口（对应 CREATE_NO_WINDOW）。
 * - commit hash / tag 名注入校验正则与 Python 完全一致。
 *
 * DEVIATION: Python 中 _get_git_command/_format_git_cmd 基于 shlex 字符串拆分；
 * TS 直接传数组参数，引号语义由 spawn 层保证，不再需要 needs_quotes。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePortableEnv } from './env'
import { getConfigStore } from './configStore'
import type { EnvMode } from './configStore'
import { logError } from './errorLog'
import { mirrorDisplayName } from './mirrors'
import { IS_WINDOWS, spawnAsync } from './runtime'
import type { BoolMessage, CommitResult, SyncSpawnResult, TagsResult } from './types'
import { compareVersions } from './env'

/** ← _COMMIT_HASH_RE：7-40 位小写十六进制 */
export const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/
/** ← _TAG_NAME_RE：仅字母数字点下划线短横线 */
export const TAG_NAME_RE = /^[a-zA-Z0-9._-]+$/

/**
 * git 证书信任链失败的 stderr 特征（openssl 后端的 ca-bundle 不认
 * Watt Toolkit/企业网关装在 Windows 系统证书库里的自签 CA）。
 */
const GIT_SSL_FAILURE_RE =
  /SSL certificate problem|certificate verif(?:y|ication) failed|self-signed certificate|unable to get local issuer certificate/i

/** Windows 系统证书库回退参数（一次性 -c，不污染用户 git 配置；
 *  schannelCheckRevoke=false 规避劫持证书无 CRL 端点时的吊销检查失败） */
export const GIT_SCHANNEL_FALLBACK_ARGS = [
  '-c',
  'http.sslBackend=schannel',
  '-c',
  'http.schannelCheckRevoke=false',
] as const

/** stderr 是否为证书信任链失败（→ Windows 上值得用系统证书库重试一次） */
export function isGitSslFailure(stderr: string): boolean {
  return IS_WINDOWS && GIT_SSL_FAILURE_RE.test(stderr)
}

/** git 执行器（默认真实 spawn；测试注入以断言 schannel 回退的参数拼装） */
export type GitExecutor = (cmd: string[], cwd: string) => Promise<SyncSpawnResult & { ok: boolean }>

export interface GitCallOptions {
  /**
   * 显式指定 git 可执行文件（测试注入用）。
   * 默认按 config 的 env_mode 解析：system 模式 "git"，其余模式 env/cmd/git.exe。
   */
  gitExecutable?: string
  /** 执行器注入（测试断言 schannel 回退参数；默认真实 spawn） */
  executor?: GitExecutor
}

/** ← _get_git_command */
export function resolveGitExecutable(options: { envMode?: EnvMode } = {}): string {
  const envMode = options.envMode ?? getConfigStore().get<EnvMode>('env_mode', 'portable')
  if (envMode === 'system') {
    return 'git'
  }
  // Phase 4 已了结：embedded 的 Git 全部经 isoGit 服务（StRepoOps 路由 / 扩展浅克隆
  // / 版本页 getStTagsEmbedded / currentVersionEmbedded），不落本函数——embedded 下
  // 唯一到达此处的前提是误用 spawn git，返回值不可达亦不可信，属调用方缺陷
  return resolvePortableEnv().gitExe
}

/** 默认执行器：真实 spawn + 流收集（原 runGit 主体） */
const defaultExecutor: GitExecutor = async (cmd, cwd) => {
  try {
    const proc = spawnAsync({ cmd, cwd, windowsHide: true })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      streamText(proc.stdout),
      streamText(proc.stderr),
    ])
    return { exitCode, stdout, stderr, ok: exitCode === 0 }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { exitCode: null, stdout: '', stderr: message, ok: false }
  }
}

/**
 * ← run_git_command：数组参数、shell 永不启用。
 * Windows 上证书信任链失败时自动用系统证书库（schannel）重试一次——
 * 覆盖 Watt Toolkit/企业网关等 hosts 劫持 + 本地反代换证书的环境，
 * 首选路径（openssl + 自带 ca-bundle）行为不变。
 */
export async function runGit(
  args: string[],
  cwd: string,
  options: GitCallOptions = {},
): Promise<SyncSpawnResult & { ok: boolean }> {
  const gitCmd = options.gitExecutable ?? resolveGitExecutable()
  const executor = options.executor ?? defaultExecutor
  const result = await executor([gitCmd, ...args], cwd)

  if (!result.ok && isGitSslFailure(result.stderr)) {
    console.warn('[git] SSL 证书校验失败，改用 Windows 系统证书库（schannel）重试')
    const retried = await executor(
      [gitCmd, ...GIT_SCHANNEL_FALLBACK_ARGS, ...args],
      cwd,
    )
    if (!retried.ok) {
      logError(
        `[git] schannel 回退仍失败: ${retried.stderr.trim().slice(0, 300)}`,
      )
    }
    return retried
  }
  return result
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text()
  } catch {
    return ''
  }
}

function defaultStDir(): string {
  return join(process.cwd(), 'SillyTavern')
}

/** ← checkout_st_version：保持在 release 分支上切换 commit，stash 非 package-lock 改动 */
export async function checkoutStVersion(
  commitHash: string,
  stDir?: string,
  options: GitCallOptions = {},
): Promise<BoolMessage> {
  const dir = stDir ?? defaultStDir()

  if (!existsSync(dir)) {
    return { ok: false, message: 'SillyTavern目录不存在' }
  }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, message: 'SillyTavern目录不是Git仓库' }
  }
  // 防 commit hash 命令注入
  if (!COMMIT_HASH_RE.test(commitHash)) {
    return { ok: false, message: `无效的 commit hash 格式: ${commitHash}` }
  }

  try {
    // 步骤1：检查当前分支状态
    const checkBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir, options)
    const currentBranch = checkBranch.ok ? checkBranch.stdout.trim() : ''

    // 步骤2：detached HEAD 时先切回 release 分支
    if (currentBranch === 'HEAD') {
      let checkoutRelease = await runGit(['checkout', 'release'], dir, options)
      if (!checkoutRelease.ok) {
        // 本地没有 release 分支，从远程创建
        checkoutRelease = await runGit(['checkout', '-b', 'release', 'origin/release'], dir, options)
        if (!checkoutRelease.ok) {
          return {
            ok: false,
            message: `无法切换到release分支: ${checkoutRelease.stderr.trim() || '未知错误'}`,
          }
        }
      }
    }

    // 步骤3：其他分支则切换到 release
    if (currentBranch !== 'release') {
      const checkoutRelease = await runGit(['checkout', 'release'], dir, options)
      if (!checkoutRelease.ok) {
        return {
          ok: false,
          message: `切换到release分支失败: ${checkoutRelease.stderr.trim() || '未知错误'}`,
        }
      }
    }

    // 步骤4-5：检查工作区，非 package-lock 改动先 stash
    const statusResult = await runGit(['status', '--porcelain'], dir, options)
    if (statusResult.stdout.trim()) {
      const nonPackageLockChanges = statusResult.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim() && !line.includes('package-lock.json'))
      if (nonPackageLockChanges.length > 0) {
        const stashResult = await runGit(
          ['stash', 'push', '-m', `版本切换前保存${commitHash.slice(0, 7)}`],
          dir,
          options,
        )
        if (!stashResult.ok) {
          return {
            ok: false,
            message: `保存本地更改失败: ${stashResult.stderr.trim() || '未知错误'}`,
          }
        }
      } else {
        // 只有 package-lock.json 被修改，恢复它
        await runGit(['checkout', '--', 'package-lock.json'], dir, options)
      }
    }

    // 步骤6：从远程获取最新提交（失败继续，本地可能已有目标 commit）
    // DEVIATION: Python 在 fetch 失败时 print 提示后继续；服务层无 UI 日志，静默继续
    await runGit(['fetch', 'origin', 'release'], dir, options)

    // 步骤6.5：验证 commit 是否存在
    const verifyResult = await runGit(['cat-file', '-t', commitHash], dir, options)
    if (!verifyResult.ok) {
      return {
        ok: false,
        message:
          `切换失败: 该版本(${commitHash.slice(0, 7)})在远程仓库中不存在。\n` +
          `建议: 尝试更新到最新版本后再试。`,
      }
    }

    // 步骤7：reset --hard 切换（保持在 release 分支上）
    const resetResult = await runGit(['reset', '--hard', commitHash], dir, options)
    if (resetResult.ok) {
      const verifyBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir, options)
      if (verifyBranch.ok) {
        const branchName = verifyBranch.stdout.trim()
        if (branchName === 'release') {
          return { ok: true, message: `成功切换到版本 ${commitHash.slice(0, 7)}（在release分支上）` }
        }
        return { ok: false, message: `切换后未在release分支上，当前在: ${branchName}` }
      }
      return { ok: true, message: `成功切换到版本 ${commitHash.slice(0, 7)}` }
    }
    return { ok: false, message: `切换失败: ${resetResult.stderr.trim() || '未知错误'}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `切换过程中发生错误: ${message}` }
  }
}

/** ← check_git_status：工作区是否干净（自动恢复仅 package-lock.json 的改动） */
export async function checkGitStatus(
  stDir?: string,
  options: GitCallOptions = {},
): Promise<BoolMessage> {
  const dir = stDir ?? defaultStDir()
  try {
    const result = await runGit(['status', '--porcelain'], dir, options)
    if (!result.stdout.trim()) {
      return { ok: true, message: '工作区干净' }
    }
    const nonPackageLockChanges = result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim() && !line.includes('package-lock.json'))
    if (nonPackageLockChanges.length === 0) {
      // 只有 package-lock.json 被修改，自动恢复
      await runGit(['checkout', '--', 'package-lock.json'], dir, options)
      return { ok: true, message: '工作区干净（已自动恢复package-lock.json）' }
    }
    return { ok: false, message: `检测到${nonPackageLockChanges.length}个文件有未提交的更改` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `检查Git状态时出错: ${message}` }
  }
}

/** ← get_current_commit */
export async function getCurrentCommit(
  stDir?: string,
  options: GitCallOptions = {},
): Promise<CommitResult> {
  const dir = stDir ?? defaultStDir()
  try {
    const result = await runGit(['rev-parse', 'HEAD'], dir, options)
    if (result.ok) {
      return { ok: true, commit: result.stdout.trim(), message: '成功获取当前commit' }
    }
    return { ok: false, commit: null, message: `获取commit失败: ${result.stderr.trim()}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, commit: null, message: `获取commit时出错: ${message}` }
  }
}

/** ← switch_git_remote：所有镜像源统一指回 GitHub 原始仓库 */
export async function switchGitRemote(
  mirrorType = 'github',
  stDir?: string,
  options: GitCallOptions = {},
): Promise<BoolMessage> {
  const dir = stDir ?? defaultStDir()
  if (!existsSync(dir)) {
    return { ok: false, message: 'SillyTavern目录不存在' }
  }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, message: 'SillyTavern目录不是Git仓库' }
  }
  try {
    const remoteUrl = 'https://github.com/SillyTavern/SillyTavern.git'
    const result = await runGit(['remote', 'set-url', 'origin', remoteUrl], dir, options)
    if (result.ok) {
      // 镜像名标注（2026-09-21 镜像增强）：镜像站名单已收敛到 mirrors 注册表，
      // 此处不再硬编码站名——官方源哨兵 'github' 之外一律按镜像站回报
      const mirrorName = mirrorDisplayName(mirrorType)
      return { ok: true, message: `已将远程地址设置为GitHub仓库（通过${mirrorName}加速）` }
    }
    return { ok: false, message: `切换失败: ${result.stderr.trim()}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `切换过程中发生错误: ${message}` }
  }
}

/** ← cleanup_git_state：中止 merge/rebase/cherry-pick/revert 后 reset --hard */
export async function cleanupGitState(
  stDir?: string,
  options: GitCallOptions = {},
): Promise<BoolMessage> {
  const dir = stDir ?? defaultStDir()

  if (!existsSync(dir)) {
    return { ok: true, message: 'SillyTavern目录不存在，无需清理' }
  }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: true, message: '不是Git仓库，无需清理' }
  }

  try {
    // 检测未完成状态标志文件
    const flagFiles = {
      mergeHead: join(dir, '.git', 'MERGE_HEAD'),
      rebaseApply: join(dir, '.git', 'rebase-apply'),
      rebaseMerge: join(dir, '.git', 'rebase-merge'),
      cherryPickHead: join(dir, '.git', 'CHERRY_PICK_HEAD'),
      revertHead: join(dir, '.git', 'REVERT_HEAD'),
    }
    const needsCleanup = Object.values(flagFiles).some((p) => existsSync(p))
    if (!needsCleanup) {
      return { ok: true, message: 'Git状态干净，无需清理' }
    }

    // 清理步骤1：中止合并
    if (existsSync(flagFiles.mergeHead)) {
      await runGit(['merge', '--abort'], dir, options)
    }
    // 清理步骤2：中止 rebase（新版 rebase-merge 优先于旧版 rebase-apply）
    if (existsSync(flagFiles.rebaseMerge) || existsSync(flagFiles.rebaseApply)) {
      await runGit(['rebase', '--abort'], dir, options)
    }
    // 清理步骤3：中止 cherry-pick
    if (existsSync(flagFiles.cherryPickHead)) {
      await runGit(['cherry-pick', '--abort'], dir, options)
    }
    // 清理步骤4：中止 revert
    if (existsSync(flagFiles.revertHead)) {
      await runGit(['revert', '--abort'], dir, options)
    }
    // 清理步骤5：清理工作区索引
    const resetResult = await runGit(['reset', '--hard', 'HEAD'], dir, options)
    if (!resetResult.ok && resetResult.stderr.trim()) {
      console.warn(`[git] 清理工作区失败: ${resetResult.stderr.trim()}`)
    }

    // 清理步骤6：清理可能存在的未提交更改
    const statusResult = await runGit(['status', '--porcelain'], dir, options)
    if (statusResult.stdout.trim()) {
      const nonPackageLockChanges = statusResult.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim() && !line.includes('package-lock.json'))
      if (nonPackageLockChanges.length > 0) {
        await runGit(['reset', '--hard', 'HEAD'], dir, options)
      } else {
        // 只有 package-lock.json 被修改，恢复它
        await runGit(['checkout', '--', 'package-lock.json'], dir, options)
      }
    }

    // 清理步骤7：验证标志文件已移除
    const remainingFlags = Object.values(flagFiles)
      .filter((p) => existsSync(p))
      .map((p) => p.split(/[\\/]/).pop() ?? p)
    if (remainingFlags.length > 0) {
      const errorMsg = `清理失败，仍存在的状态文件: ${remainingFlags.join(', ')}`
      logError(`[git] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
    return { ok: true, message: 'Git状态清理成功' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `清理Git状态时出错: ${message}` }
  }
}

/** ← get_st_tags 内部的版本 tag 正则（x.y.z 可带预发布/构建后缀）。
 *  Phase 4 收尾导出：isoGit.getStTagsEmbedded 复用同一过滤语义，避免两处漂移 */
export const VERSION_TAG_RE = /^(\d+)\.(\d+)\.(\d+)(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/

export function normalizeVersion(tagName: string): string {
  if (tagName.startsWith('v') || tagName.startsWith('V')) {
    return tagName.slice(1)
  }
  return tagName
}

/** 语义化版本 ≥1.13.0 判定（Phase 4 收尾导出：与 VERSION_TAG_RE 同理由 isoGit 复用） */
export function versionGte1130(versionStr: string): boolean {
  const parts = versionStr.split('.')
  if (parts.length < 3) return false
  const nums = parts.slice(0, 3).map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return false
  const [major, minor, patch] = nums
  if (major > 1) return true
  if (major === 1) {
    if (minor > 13) return true
    if (minor === 13) return patch >= 0
    return false
  }
  return false
}

/** ← get_st_tags：本地 tag 列表 → ≥1.13.0 语义化版本过滤 + 排序 */
export async function getStTags(
  stDir?: string,
  options: GitCallOptions = {},
): Promise<TagsResult> {
  const dir = stDir ?? defaultStDir()

  if (!existsSync(dir)) {
    return { ok: false, data: null, message: 'SillyTavern目录不存在' }
  }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, data: null, message: 'SillyTavern目录不是Git仓库' }
  }

  try {
    // 步骤1: 获取本地 tag 列表
    const listTagsResult = await runGit(['tag', '-l'], dir, options)
    if (!listTagsResult.ok) {
      return { ok: false, data: null, message: `获取tag列表失败: ${listTagsResult.stderr.trim()}` }
    }
    const allTags = listTagsResult.stdout
      .trim()
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)

    // 步骤3: 过滤语义化版本且 >= 1.13.0
    const versions: Record<string, { commit: string; date: string; tag_name: string }> = {}
    const validTags: Array<[string, string]> = []
    for (const tag of allTags) {
      const versionStr = normalizeVersion(tag)
      if (VERSION_TAG_RE.test(versionStr) && versionGte1130(versionStr)) {
        validTags.push([tag, versionStr])
      }
    }

    // 步骤4: 获取每个 tag 的 commit 与日期（%H 完整hash, %aI ISO8601 作者日期）
    for (const [tagName, versionStr] of validTags) {
      const showResult = await runGit(
        ['show', tagName, '--format=%H|%aI', '-s'],
        dir,
        options,
      )
      if (showResult.ok) {
        let output = showResult.stdout.trim()
        // 兼容 Python 输出端引号剥离逻辑（无 shell 时通常无引号）
        output = output.replace(/^["']+|["']+$/g, '')
        const parts = output.split('|')
        if (parts.length === 2) {
          versions[versionStr] = {
            commit: parts[0] ?? '',
            date: parts[1] ?? '',
            tag_name: tagName,
          }
        }
      }
    }

    // 步骤5: 语义化版本排序取最新
    const sortedVersions = Object.keys(versions).sort((a, b) => compareVersions(b, a))
    const latestVersion = sortedVersions[0] ?? ''

    return {
      ok: true,
      data: { versions, latest: latestVersion },
      message: `成功获取 ${Object.keys(versions).length} 个版本`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, data: null, message: `获取tag列表时出错: ${message}` }
  }
}

/** ← checkout_st_tag：校验 tag 名后切换（含 stash 非 package-lock 改动） */
export async function checkoutStTag(
  tagName: string,
  stDir?: string,
  options: GitCallOptions = {},
): Promise<BoolMessage> {
  const dir = stDir ?? defaultStDir()

  if (!existsSync(dir)) {
    return { ok: false, message: 'SillyTavern目录不存在' }
  }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, message: 'SillyTavern目录不是Git仓库' }
  }
  // 防 tag 名命令注入（同时天然拒绝 "../" 路径穿越：斜杠不在白名单内）
  if (!TAG_NAME_RE.test(tagName)) {
    return { ok: false, message: `无效的 tag 名称格式: ${tagName}` }
  }

  try {
    // 步骤1: 校验 tag 存在
    const verifyResult = await runGit(['rev-parse', tagName], dir, options)
    if (!verifyResult.ok) {
      return {
        ok: false,
        message: `切换失败: Tag ${tagName} 不存在。\n请先使用更新功能获取最新版本。`,
      }
    }

    // 步骤2-3: 未提交更改处理（排除 package-lock.json）
    const statusResult = await runGit(['status', '--porcelain'], dir, options)
    if (statusResult.stdout.trim()) {
      const nonPackageLockChanges = statusResult.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim() && !line.includes('package-lock.json'))
      if (nonPackageLockChanges.length > 0) {
        const stashResult = await runGit(
          ['stash', 'push', '-m', `版本切换前保存${tagName}`],
          dir,
          options,
        )
        if (!stashResult.ok) {
          return {
            ok: false,
            message: `保存本地更改失败: ${stashResult.stderr.trim() || '未知错误'}`,
          }
        }
      } else {
        await runGit(['checkout', '--', 'package-lock.json'], dir, options)
      }
    }

    // 步骤4: 切换到 tag
    const checkoutResult = await runGit(['checkout', tagName], dir, options)
    if (checkoutResult.ok) {
      return { ok: true, message: `成功切换到 tag ${tagName}` }
    }
    return { ok: false, message: `切换失败: ${checkoutResult.stderr.trim() || '未知错误'}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `切换过程中发生错误: ${message}` }
  }
}
