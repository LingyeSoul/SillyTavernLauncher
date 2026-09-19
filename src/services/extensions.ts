/**
 * ← src/features/extensions/extension_manager.py（1:1 语义移植）
 *
 * 安全纪律（设计计划 §7：安全逻辑 1:1 + 测试）：
 * - 名称正则 ^[A-Za-z0-9_-]+$（斜杠/引号/shell 元字符全部拒绝）。
 * - realpath 遏制：目标路径必须落在受管目录内（commonpath 语义）。
 * - git URL 校验：仅无凭据的 http(s) + hostname；git clone 走参数数组。
 * - Zip-Slip：解压前逐 entry realpath 遏制检查，越界 entry 抛错。
 *
 * DEVIATION: git clone 增加 --depth 1（任务规格：浅克隆加速，非安全逻辑，
 *   Python 无此参数）。
 * DEVIATION: Python shutil.rmtree 的 onerror 回调处理 Windows 只读文件；
 *   TS 侧失败时先 chmod 整棵树再重试（等价语义）。
 * DEVIATION: 临时目录解压使用 fs.mkdtempSync（Python tempfile.TemporaryDirectory
 *   语义一致，均自动清理）。
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { unzipSync } from 'fflate'
import { getConfigStore } from './configStore'
import { checkStInstalled } from './env'
import { resolveGitExecutable } from './git'
import { isDirSync, realpathBestEffort } from './atomicFs'
import { spawnAsync } from './runtime'
import type { BoolMessage } from './types'

// ---------------------------------------------------------------------------
// 类型（← ExtensionType / ExtensionInfo）
// ---------------------------------------------------------------------------

export type ExtensionType = 'global' | 'user'

export interface ExtensionManifest {
  display_name?: string
  version?: string
  [key: string]: unknown
}

export interface ExtensionInfo {
  name: string
  path: string
  extType: ExtensionType
  manifest: ExtensionManifest | null
  isValid: boolean
  errorMsg: string
}

function displayNameOf(ext: ExtensionInfo): string {
  return typeof ext.manifest?.display_name === 'string'
    ? ext.manifest.display_name
    : ext.name
}

function versionOf(ext: ExtensionInfo): string {
  return typeof ext.manifest?.version === 'string' ? ext.manifest.version : '未知'
}

function descriptionOf(ext: ExtensionInfo): string {
  return typeof ext.manifest?.description === 'string' ? ext.manifest.description : ''
}

function authorOf(ext: ExtensionInfo): string {
  return typeof ext.manifest?.author === 'string' ? ext.manifest.author : '未知'
}

/** 派生展示字段（← ExtensionInfo @property display_name/version/...） */
export function extensionDisplayFields(ext: ExtensionInfo): {
  displayName: string
  version: string
  description: string
  author: string
} {
  return {
    displayName: displayNameOf(ext),
    version: versionOf(ext),
    description: descriptionOf(ext),
    author: authorOf(ext),
  }
}

// ---------------------------------------------------------------------------
// 常量与校验（安全逻辑 1:1）
// ---------------------------------------------------------------------------

export const GLOBAL_EXT_DIR = 'SillyTavern/public/scripts/extensions/third-party'
export const USER_EXT_DIR = 'SillyTavern/data/default-user/extensions'
/** ← EXTENSION_NAME_RE */
export const EXTENSION_NAME_RE = /^[A-Za-z0-9_-]+$/

export class ExtensionNameError extends Error {}
export class ExtensionPathError extends Error {}

/** ← _validate_extension_name：strip + 白名单，非法抛 ValueError 等价异常 */
export function validateExtensionName(name: string): string {
  const normalized = name.trim()
  if (!normalized || !EXTENSION_NAME_RE.test(normalized)) {
    throw new ExtensionNameError('扩展名称只能包含字母、数字、下划线和短横线')
  }
  return normalized
}

/**
 * 路径遏制：path 必须等于 base 或位于 base + sep 之下
 * （← os.path.commonpath((base, path)) == base 的宽松等价；
 *   Python commonpath 在不同盘符时抛 ValueError，此处同样判为越界）。
 */
export function isPathUnder(base: string, path: string): boolean {
  if (path === base) return true
  return path.startsWith(base + sep)
}

/** ← _safe_extension_path：校验名称 + realpath 遏制 */
export function safeExtensionPath(targetDir: string, name: string): string {
  const normalizedName = validateExtensionName(name)
  const realTargetDir = realpathBestEffort(targetDir)
  // realpath 语义与 Python 一致：不存在时词法解析（消除 .. / .）
  const targetPath = realpathBestEffort(join(realTargetDir, normalizedName))
  // join 后 realpath：若 name 含 ..（正则已拒绝斜杠，防御性兜底）会逃逸
  if (!isPathUnder(realTargetDir, targetPath)) {
    throw new ExtensionPathError('扩展路径超出受管目录')
  }
  return targetPath
}

// ---------------------------------------------------------------------------
// git 可执行解析（← _get_git_command 的目录语义 → exe 路径）
// ---------------------------------------------------------------------------

export interface GitRunnerResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

export type GitRunner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<GitRunnerResult>

/** 默认实现：复用 git.ts 的可执行解析（use_sys_env 决定系统/便携 git） */
const defaultGitRunner: GitRunner = async (args, cwd, signal) => {
  const gitExe = resolveGitExecutable()
  const proc = spawnAsync({ cmd: [gitExe, ...args], cwd, windowsHide: true })
  const abort = (): void => {
    try {
      proc.kill()
    } catch {
      // 已退出
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  const stdoutDone = new Response(proc.stdout).text()
  const stderrDone = new Response(proc.stderr).text()
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      stdoutDone,
      stderrDone,
    ])
    return { ok: exitCode === 0, exitCode, stdout, stderr }
  } catch (err) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

// ---------------------------------------------------------------------------
// 目录/文件工具
// ---------------------------------------------------------------------------

/**
 * ← delete_extension 的 on_rm_error：Windows 只读文件先 chmod 再删。
 * 整树先常规删除，EPERM/EBUSY 时 chmod 全树后重试。
 */
function removeTree(path: string, ignoreErrors = false): void {
  try {
    rmSync(path, { recursive: true, force: true })
    return
  } catch (err) {
    if (ignoreErrors) return
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY') {
      throw err
    }
  }
  // 只读文件兜底：chmod 整棵树后重试
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry)
      if (isDirSync(child)) walk(child)
      else {
        try {
          // ← os.chmod(path, stat.S_IWRITE)：清只读位
          chmodSync(child, 0o200)
        } catch {
          // 忽略单个文件失败，rmSync force 再兜底
        }
      }
    }
    try {
      chmodSync(dir, 0o200)
    } catch {
      // 忽略
    }
  }
  walk(path)
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (err) {
    if (!ignoreErrors) throw err
  }
}

/** ← shutil.move（同卷 rename；跨设备/被占用时回退 copy + rm） */
function moveTree(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch {
    cpSync(src, dest, { recursive: true, force: true })
    removeTree(src, true)
  }
}

// ---------------------------------------------------------------------------
// ExtensionManager
// ---------------------------------------------------------------------------

export interface ExtensionManagerOptions {
  /** 启动器根目录（默认 process.cwd()，扩展目录相对它拼接） */
  baseDir?: string
  /** 镜像读取（默认 configStore 的 github.mirror；测试注入） */
  getMirror?: () => string
  /** 日志回调 */
  log?: (message: string) => void
  /** git 执行器（测试注入；默认参数数组 + windowsHide） */
  gitRunner?: GitRunner
}

export class ExtensionManager {
  private readonly baseDir: string
  private readonly getMirror: () => string
  private logFn: (message: string) => void
  private readonly gitRunner: GitRunner

  constructor(options: ExtensionManagerOptions = {}) {
    this.baseDir = options.baseDir ?? process.cwd()
    this.getMirror =
      options.getMirror ?? (() => getConfigStore().get<string>('github.mirror', 'github'))
    this.logFn = options.log ?? (() => undefined)
    this.gitRunner = options.gitRunner ?? defaultGitRunner
  }

  /** 单例晚到的 log 选项也能生效（原 first-wins 会把后续回调静默丢弃） */
  setLogFn(fn: (message: string) => void): void {
    this.logFn = fn
  }

  private log(message: string): void {
    this.logFn(message)
  }

  getGlobalExtPath(): string {
    return join(this.baseDir, GLOBAL_EXT_DIR)
  }

  getUserExtPath(): string {
    return join(this.baseDir, USER_EXT_DIR)
  }

  private extPathOf(extType: ExtensionType): string {
    return extType === 'global' ? this.getGlobalExtPath() : this.getUserExtPath()
  }

  /** ← _check_st_installed（复用 env 服务的探测，package.json + server.js） */
  private checkStInstalledDir(): boolean {
    return checkStInstalled(join(this.baseDir, 'SillyTavern'))
  }

  /** ← _ensure_dir_exists：仅在 SillyTavern 已安装时创建 */
  private ensureDirExists(path: string): void {
    if (!this.checkStInstalledDir()) {
      this.log('SillyTavern 未安装，无法创建扩展目录')
      return
    }
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true })
      this.log(`创建目录: ${path}`)
    }
  }

  /** ← _validate_managed_extension：声明目录一致才允许操作 */
  private validateManagedExtension(ext: ExtensionInfo): void {
    const targetDir = this.extPathOf(ext.extType)
    const expectedPath = safeExtensionPath(targetDir, ext.name)
    if (realpathBestEffort(ext.path) !== expectedPath) {
      throw new ExtensionPathError('扩展路径不在声明的受管目录中')
    }
  }

  /** ← _load_manifest */
  loadManifest(extPath: string): ExtensionManifest | null {
    const manifestPath = join(extPath, 'manifest.json')
    if (existsSync(manifestPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed as ExtensionManifest
        }
        return null
      } catch (err) {
        console.warn(
          `[extensions] 加载 manifest 失败 ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return null
  }

  /** ← _is_valid_extension：目录 + (manifest.json | index.js) */
  isValidExtension(extPath: string): boolean {
    if (!isDirSync(extPath)) return false
    return existsSync(join(extPath, 'manifest.json')) || existsSync(join(extPath, 'index.js'))
  }

  /** ← scan_extensions（含按名称小写排序、隐藏目录跳过） */
  scanExtensions(extType: ExtensionType, signal?: AbortSignal): ExtensionInfo[] {
    const extensions: ExtensionInfo[] = []
    const basePath = this.extPathOf(extType)

    // SillyTavern 未安装时目录不存在，静默返回空列表
    if (!isDirSync(basePath)) {
      return extensions
    }

    this.ensureDirExists(basePath)

    try {
      for (const item of readdirSync(basePath)) {
        if (signal?.aborted) throw signal.reason ?? new Error('扫描已取消')
        const itemPath = join(basePath, item)
        if (isDirSync(itemPath) && !item.startsWith('.')) {
          if (this.isValidExtension(itemPath)) {
            extensions.push({
              name: item,
              path: itemPath,
              extType,
              manifest: this.loadManifest(itemPath),
              isValid: true,
              errorMsg: '',
            })
          } else {
            // 无效扩展但仍然显示
            extensions.push({
              name: item,
              path: itemPath,
              extType,
              manifest: null,
              isValid: false,
              errorMsg: '缺少 manifest.json 或 index.js',
            })
          }
        }
      }
    } catch (err) {
      // signal.reason 非 Error（或消息不同）时，aborted 仍应判定为取消而非扫描失败
      if ((err instanceof Error && err.message === '扫描已取消') || signal?.aborted) throw err
      this.log(`扫描扩展失败: ${err instanceof Error ? err.message : String(err)}`)
    }

    extensions.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    return extensions
  }

  /** ← get_all_extensions */
  getAllExtensions(signal?: AbortSignal): Record<ExtensionType, ExtensionInfo[]> {
    return {
      global: this.scanExtensions('global', signal),
      user: this.scanExtensions('user', signal),
    }
  }

  /** ← delete_extension */
  deleteExtension(ext: ExtensionInfo): BoolMessage {
    try {
      this.validateManagedExtension(ext)
      if (existsSync(ext.path)) {
        // Windows 上需要处理只读文件
        removeTree(ext.path)
        this.log(`已删除扩展: ${ext.name}`)
        return { ok: true, message: `成功删除扩展: ${ext.name}` }
      }
      return { ok: false, message: `扩展目录不存在: ${ext.path}` }
    } catch (err) {
      const errorMsg = `删除扩展失败: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[extensions] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }

  /** ← move_extension：全局/用户互转 */
  moveExtension(ext: ExtensionInfo, targetType: ExtensionType): BoolMessage {
    if (ext.extType === targetType) {
      return { ok: false, message: '源类型和目标类型相同' }
    }

    try {
      this.validateManagedExtension(ext)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }

    const targetDir = this.extPathOf(targetType)
    this.ensureDirExists(targetDir)
    const targetPath = safeExtensionPath(targetDir, ext.name)

    if (existsSync(targetPath)) {
      return { ok: false, message: `目标位置已存在同名扩展: ${ext.name}` }
    }

    try {
      moveTree(ext.path, targetPath)
      const typeName = targetType === 'global' ? '全局' : '用户'
      this.log(`已将扩展 ${ext.name} 移动到${typeName}插件目录`)
      return { ok: true, message: `成功将扩展移动到${typeName}插件目录` }
    } catch (err) {
      const errorMsg = `移动扩展失败: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[extensions] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }

  /** ← _apply_github_mirror：GitHub URL 前置镜像站 */
  applyGithubMirror(url: string): string {
    const mirror = this.getMirror()
    if (mirror === 'github') return url

    const githubPatterns = [/^https?:\/\/github\.com\//, /^https?:\/\/raw\.githubusercontent\.com\//]
    const isGithub = githubPatterns.some((pattern) => pattern.test(url))
    if (!isGithub) return url

    if (mirror === 'gh-proxy.org') return `https://gh-proxy.org/${url}`
    if (mirror === 'gh.llkk.cc') return `https://gh.llkk.cc/${url}`
    return url
  }

  /** ← install_from_git 内部的 URL 提取与校验（纯函数便于测试） */
  extractRepoNameFromUrl(url: string): string | null {
    const match = /\/([^/]+?)(?:\.git)?$/.exec(url)
    return match?.[1] ?? null
  }

  /**
   * ← install_from_git 内部的 URL 安全校验：
   * 仅允许无凭据的 HTTP(S) URL（urlsplit 等价语义）。
   */
  validateRepoUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      if (!parsed.hostname) return false
      if (parsed.username || parsed.password) return false
      return true
    } catch {
      return false
    }
  }

  /** ← install_from_git */
  async installFromGit(
    repoUrl: string,
    extType: ExtensionType,
    customName?: string,
    signal?: AbortSignal,
  ): Promise<BoolMessage> {
    // 应用镜像
    const originalUrl = repoUrl
    repoUrl = this.applyGithubMirror(repoUrl)
    if (originalUrl !== repoUrl) {
      this.log(`使用镜像: ${repoUrl}`)
    }

    // 只允许无凭据的 HTTP(S) URL；命令使用参数列表执行，不经过 shell。
    if (!this.validateRepoUrl(repoUrl)) {
      return { ok: false, message: `无效的仓库 URL: ${repoUrl}` }
    }

    const targetDir = this.extPathOf(extType)
    this.ensureDirExists(targetDir)

    // 从 URL 提取扩展名称
    let extName: string
    if (customName) {
      extName = customName
    } else {
      const extracted = this.extractRepoNameFromUrl(repoUrl)
      if (!extracted) {
        return { ok: false, message: '无法从 URL 提取扩展名称，请提供自定义名称' }
      }
      extName = extracted
    }

    let targetPath: string
    try {
      extName = validateExtensionName(extName)
      targetPath = safeExtensionPath(targetDir, extName)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }

    // 检查是否已存在
    if (existsSync(targetPath)) {
      return { ok: false, message: `扩展已存在: ${extName}` }
    }

    try {
      this.log(`正在从 Git 安装扩展: ${extName}`)
      // DEVIATION: 任务规格要求 --depth 1 浅克隆（Python 无）
      const result = await this.gitRunner(
        ['clone', '--depth', '1', '--', repoUrl, targetPath],
        this.baseDir,
        signal,
      )

      if (result.exitCode === 0) {
        if (this.isValidExtension(targetPath)) {
          this.log(`成功安装扩展: ${extName}`)
          return { ok: true, message: `成功安装扩展: ${extName}` }
        }
        // 不是有效扩展，删除并返回错误
        removeTree(targetPath, true)
        return {
          ok: false,
          message: '安装的仓库不是有效的 SillyTavern 扩展（缺少 manifest.json 或 index.js）',
        }
      }
      const errorMsg = result.stderr.trim() || '未知错误'
      return { ok: false, message: `Git 克隆失败: ${errorMsg}` }
    } catch (err) {
      const errorMsg = `安装扩展失败: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[extensions] ${errorMsg}`)
      if (existsSync(targetPath)) {
        removeTree(targetPath, true)
      }
      return { ok: false, message: errorMsg }
    }
  }

  /** ← install_from_zip 内部的文件名提取（纯函数便于测试） */
  extractNameFromZipFilename(zipPath: string): string {
    // ← os.path.splitext(basename)[0]：仅去掉最后一个扩展名
    const base = basename(zipPath)
    const dot = base.lastIndexOf('.')
    const noExt = dot > 0 ? base.slice(0, dot) : base
    // 移除常见的后缀（-main/_master/-latest，大小写不敏感）
    return noExt.replace(/[-_](main|master|latest)$/i, '')
  }

  /** ZIP 魔数检查（← zipfile.is_zipfile 的轻量等价） */
  isZipFile(zipPath: string): boolean {
    try {
      if (isDirSync(zipPath) || !existsSync(zipPath)) return false
      const buf = readFileSync(zipPath)
      // PK\x03\x04（本地文件头）或 PK\x05\x06（空归档 EOCD）或 PK\x07\x08（跨卷）
      if (
        buf.length >= 4 &&
        buf[0] === 0x50 &&
        buf[1] === 0x4b &&
        ((buf[2] === 0x03 && buf[3] === 0x04) ||
          (buf[2] === 0x05 && buf[3] === 0x06) ||
          (buf[2] === 0x07 && buf[3] === 0x08))
      ) {
        return true
      }
      // 自解压档案：EOCD 可能不在开头，扫描尾部签名
      return lastIndexOfSignature(buf, [0x50, 0x4b, 0x05, 0x06]) !== -1
    } catch {
      return false
    }
  }

  /** ← install_from_zip（fflate 解压 + Zip-Slip 遏制） */
  installFromZip(
    zipPath: string,
    extType: ExtensionType,
    customName?: string,
    signal?: AbortSignal,
  ): BoolMessage {
    if (!existsSync(zipPath)) {
      return { ok: false, message: `ZIP 文件不存在: ${zipPath}` }
    }
    if (!this.isZipFile(zipPath)) {
      return { ok: false, message: '无效的文件格式，请选择 ZIP 文件' }
    }

    const targetDir = this.extPathOf(extType)
    this.ensureDirExists(targetDir)

    let extName = customName ? customName : this.extractNameFromZipFilename(zipPath)

    let targetPath: string
    try {
      extName = validateExtensionName(extName)
      targetPath = safeExtensionPath(targetDir, extName)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }

    if (existsSync(targetPath)) {
      return { ok: false, message: `扩展已存在: ${extName}` }
    }

    let tempDir: string | null = null
    try {
      this.log(`正在从 ZIP 安装扩展: ${extName}`)

      // 创建临时目录解压
      tempDir = mkdtempSync(join(tmpdir(), 'stlext'))
      const buffer = readFileSync(zipPath)
      const entries = unzipSync(buffer)

      // 解压 ZIP（Zip Slip 防护：逐 entry realpath 遏制）
      const realTemp = realpathBestEffort(tempDir)
      for (const [member, data] of Object.entries(entries)) {
        if (signal?.aborted) throw new Error('安装已取消')
        const memberPath = realpathBestEffort(resolve(tempDir, member))
        if (!isPathUnder(realTemp, memberPath) && memberPath !== realTemp) {
          throw new Error(`ZIP 包含不安全的路径: ${member}`)
        }
        if (member.endsWith('/')) continue // 目录 entry
        mkdirSync(dirname(memberPath), { recursive: true })
        writeFileSync(memberPath, data)
      }

      // 检查解压后的结构
      const extractedItems = readdirSync(tempDir)

      // 如果解压后只有一个目录，且用户没有指定自定义名称，使用该目录名
      let sourcePath = tempDir
      const onlyItem = extractedItems.length === 1 ? extractedItems[0] : undefined
      if (onlyItem !== undefined && isDirSync(join(tempDir, onlyItem))) {
        sourcePath = join(tempDir, onlyItem)
        if (!customName) {
          extName = validateExtensionName(onlyItem)
          targetPath = safeExtensionPath(targetDir, extName)
          if (existsSync(targetPath)) {
            return { ok: false, message: `扩展已存在: ${extName}` }
          }
        }
      }

      // 检查是否是有效的扩展
      if (this.isValidExtension(sourcePath)) {
        moveTree(sourcePath, targetPath)
        this.log(`成功安装扩展: ${extName}`)
        return { ok: true, message: `成功安装扩展: ${extName}` }
      }
      return {
        ok: false,
        message: 'ZIP 文件内容不是有效的 SillyTavern 扩展（缺少 manifest.json 或 index.js）',
      }
    } catch (err) {
      const errorMsg = `安装扩展失败: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[extensions] ${errorMsg}`)
      // 清理可能残留的文件
      if (existsSync(targetPath)) {
        removeTree(targetPath, true)
      }
      return { ok: false, message: errorMsg }
    } finally {
      if (tempDir) {
        try {
          removeTree(tempDir, true)
        } catch {
          // 临时目录清理失败不影响结果
        }
      }
    }
  }

  /** ← duplicate_extension */
  duplicateExtension(
    ext: ExtensionInfo,
    targetType: ExtensionType,
    newName?: string,
  ): BoolMessage {
    try {
      this.validateManagedExtension(ext)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }

    const targetDir = this.extPathOf(targetType)
    this.ensureDirExists(targetDir)

    // 确定新名称（Python 先 safe path 再 validate，顺序保留）
    let targetName = newName ?? ext.name
    let targetPath: string
    try {
      targetPath = safeExtensionPath(targetDir, targetName)
      targetName = validateExtensionName(targetName)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }

    if (existsSync(targetPath)) {
      return { ok: false, message: `目标位置已存在同名扩展: ${targetName}` }
    }

    try {
      cpSync(ext.path, targetPath, { recursive: true })
      const typeName = targetType === 'global' ? '全局' : '用户'
      this.log(`已复制扩展 ${ext.name} 到${typeName}插件目录`)
      return { ok: true, message: `成功复制扩展到${typeName}插件目录` }
    } catch (err) {
      const errorMsg = `复制扩展失败: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[extensions] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }

  /** ← rename_extension */
  renameExtension(ext: ExtensionInfo, newName: string): BoolMessage {
    if (!newName || newName.trim() === '') {
      return { ok: false, message: '新名称不能为空' }
    }
    newName = newName.trim()

    try {
      this.validateManagedExtension(ext)
      newName = validateExtensionName(newName)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }

    if (newName === ext.name) {
      return { ok: false, message: '新名称与原名称相同' }
    }

    const targetDir = this.extPathOf(ext.extType)
    const targetPath = safeExtensionPath(targetDir, newName)

    if (existsSync(targetPath)) {
      return { ok: false, message: `已存在同名扩展: ${newName}` }
    }

    try {
      moveTree(ext.path, targetPath)
      this.log(`已将扩展 ${ext.name} 重命名为 ${newName}`)
      return { ok: true, message: `成功重命名扩展为: ${newName}` }
    } catch (err) {
      const errorMsg = `重命名扩展失败: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[extensions] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }
}

// ---------------------------------------------------------------------------
// 共享小工具
// ---------------------------------------------------------------------------

/** 在缓冲区尾部搜索 4 字节签名（EOCD），返回偏移或 -1 */
export function lastIndexOfSignature(buf: Uint8Array, sig: number[]): number {
  outer: for (let i = buf.length - 4; i >= 0; i--) {
    for (let j = 0; j < sig.length; j++) {
      if (buf[i + j] !== sig[j]) continue outer
    }
    return i
  }
  return -1
}

let managerInstance: ExtensionManager | null = null

/** ← get_extension_manager（单例；JS 单线程免锁）。晚到的 log 选项更新到现有实例 */
export function getExtensionManager(options?: ExtensionManagerOptions): ExtensionManager {
  if (!managerInstance) {
    managerInstance = new ExtensionManager(options)
  } else if (options?.log) {
    managerInstance.setLogFn(options.log)
  }
  return managerInstance
}

/** 仅供测试重置单例 */
export function __resetExtensionManagerForTests(): void {
  managerInstance = null
}
