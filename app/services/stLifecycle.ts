/**
 * ← src/core/event.py 的 ST 生命周期编排（install/start/stop/restart/update/
 * check_and_start/switch_st_version/install_npm_dependencies/update_mirror_setting）
 *
 * 只提取编排逻辑；对话框/确认弹窗/Flet page 调用一概不迁移——
 * 服务返回结果对象，展示是 UI 层的事（设计计划 §7 D2）。
 *
 * 语义保持：
 * - npm install 全部 --no-audit --no-fund --loglevel=error --no-progress
 *   --omit=dev --registry=https://registry.npmmirror.com
 *   （install_npm_dependencies 变体无 --omit=dev，与 Python 一致）。
 * - git pull --rebase --autostash；package-lock 冲突恢复 ≤2 重试；
 *   _with_callback 变体追加 npm cache clean --force + node_modules 重装重试 ≤2。
 * - 启动命令 "<node>" server.js [--max-old-space-size=4096] [校验过的自定义参数]，
 *   cwd=SillyTavern/，env=NODE_ENV=production + PATH 前置 + FORCE_COLOR=1。
 * - 镜像管理：env/etc/gitconfig（或 ~/.gitconfig_internal）的
 *   url.<mirror>.insteadOf 改写，保持 ST remote 指向官方 GitHub。
 *
 * DEVIATION: auto_proxy 的系统代理检测 Python 读 Windows 注册表
 *   （urllib.getproxies）；TS 仅读环境变量（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY），
 *   注册表代理不迁移（无内置 API，遗留 TODO）。
 * DEVIATION: "SillyTavern 正在运行" 判断从 terminal.is_running 标志改为
 *   processManager 活动进程计数（等价状态源）。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getConfigStore, type ConfigStore } from './configStore'
import {
  checkGitStatus,
  checkoutStTag,
  cleanupGitState,
  getCurrentCommit,
  runGit,
  switchGitRemote,
  type GitCallOptions,
} from './git'
import {
  buildProcessEnv,
  executeProcessAsync,
  getActiveProcessesCount,
  hasActiveProcess,
  stopAllProcesses,
  validateCustomArgs,
  type ExecuteProcessOptions,
} from './processManager'
import { checkNodeModules, checkStInstalled, resolvePortableEnv, type PortableEnvPaths } from './env'
import { getStConfig } from './stConfig'
import { which } from './runtime'
import { ensureDirSync } from './atomicFs'
import type { BoolMessage, ProcessInfo, SyncSpawnResult } from './types'

export const ST_REPO_URL = 'https://github.com/SillyTavern/SillyTavern.git'
export const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com'
export const EXPECTED_ST_REMOTE = ST_REPO_URL

// ---------------------------------------------------------------------------
// 纯函数：命令构造（便于测试断言）
// ---------------------------------------------------------------------------

/** ← install/update 的 npm install 命令（--omit=dev 版本） */
export function buildNpmInstallCommand(npmExe: string): string {
  return (
    `"${npmExe}" install --no-audit --no-fund --loglevel=error --no-progress ` +
    `--omit=dev --registry=${NPM_MIRROR_REGISTRY}`
  )
}

/** ← install_npm_dependencies 的 npm install 命令（无 --omit=dev，1:1） */
export function buildNpmInstallCommandNoOmit(npmExe: string): string {
  return `"${npmExe}" install --no-audit --no-fund --loglevel=error --no-progress --registry=${NPM_MIRROR_REGISTRY}`
}

/** ← npm cache clean --force */
export function buildNpmCacheCleanCommand(npmExe: string): string {
  return `"${npmExe}" cache clean --force`
}

/** ← git clone -b release */
export function buildGitCloneCommand(gitExe: string): string {
  return `"${gitExe}" clone ${ST_REPO_URL} -b release`
}

/** ← git pull --rebase --autostash */
export function buildGitPullCommand(gitExe: string): string {
  return `"${gitExe}" pull --rebase --autostash`
}

/** ← start 的启动命令：node server.js + 可选优化参数 + 校验过的自定义参数 */
export function buildStStartCommand(options: {
  nodeExe: string
  useOptimizeArgs?: boolean
  customArgs?: string
}): string {
  let command = `"${options.nodeExe}" server.js`
  if (options.useOptimizeArgs) command += ' --max-old-space-size=4096'
  const customArgs = (options.customArgs ?? '').trim()
  if (customArgs) command += ` ${customArgs}`
  return command
}

// ---------------------------------------------------------------------------
// 纯函数：NPM 路径校验（← validate_path_for_npm，1:1 移植）
// ---------------------------------------------------------------------------

export interface PathValidation {
  ok: boolean
  message: string
}

/** NPM 不支持的字符集（← problematic_chars 集合，含 '-'，1:1 保留） */
const PROBLEMATIC_CHARS = new Set([
  // 空格和空白字符
  ' ', '\t', '\n', '\r',
  // 特殊符号
  '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', ';', '<', '=', '>',
  '?', '@', '[', ']', '^', '`', '{', '|', '}', '~', '-',
  // 中文标点
  '，', '。', '！', '？', '；', '：', '（', '）', '【', '】', '、', '《', '》',
  '“', '”', '…', '——',
  // 全角字符
  '　', '＂', '＃', '＄', '％', '＆', '＇', '＊', '＋', '－', '．', '／', '＜',
  '＝', '＞', '＠', '［', '＼', '］', '＾', '＿', '｀', '｛', '｜', '｝', '～',
])

export function validatePathForNpm(path: string): PathValidation {
  const foundProblematicChars: string[] = []
  for (const char of path) {
    // 检查中文字符
    if (char >= '\u4e00' && char <= '\u9fff') {
      foundProblematicChars.push(`中文字符 '${char}'`)
    } else if (
      (char >= '\u3040' && char <= '\u309f') ||
      (char >= '\u30a0' && char <= '\u30ff')
    ) {
      foundProblematicChars.push(`日文字符 '${char}'`)
    } else if (char >= '\uac00' && char <= '\ud7af') {
      foundProblematicChars.push(`韩文字符 '${char}'`)
    } else if (PROBLEMATIC_CHARS.has(char)) {
      foundProblematicChars.push(char === ' ' ? '空格' : `特殊字符 '${char}'`)
    }
  }

  if (foundProblematicChars.length > 0) {
    const uniqueChars = [...new Set(foundProblematicChars)]
    let errorMsg = '错误：当前路径包含以下NPM不支持的字符：\n'
    if (uniqueChars.length <= 5) {
      errorMsg += '  ' + uniqueChars.join('\n  ')
    } else {
      errorMsg += `  ${uniqueChars.slice(0, 5).join('\n  ')}\n  ... 还有${uniqueChars.length - 5}个其他问题字符`
    }
    errorMsg += `\n\n当前路径：${path}`
    errorMsg += '\n\n建议：请将程序移动到纯英文路径下（不包含空格和特殊字符）'
    return { ok: false, message: errorMsg }
  }

  // 额外检查：确保路径是有效的ASCII路径
  if (!/^[\x00-\x7f]*$/.test(path)) {
    return {
      ok: false,
      message: `错误：路径包含非ASCII字符，可能导致NPM运行失败\n当前路径：${path}`,
    }
  }

  // 警告类检查（不阻断，Python 仍返回 True）
  const warnings: string[] = []
  if (path.length > 250) {
    warnings.push(`警告：路径长度过长（${path.length}字符），建议缩短路径以避免潜在问题`)
  }
  if (path.startsWith('\\\\')) {
    warnings.push('警告：检测到网络路径（UNC），可能影响NPM正常运行')
  }
  if (path.length > 2 && path.slice(2).includes(':')) {
    warnings.push('警告：检测到非常规的驱动器路径格式，可能影响NPM正常运行')
  }

  return { ok: true, message: ['路径验证通过：' + path, ...warnings].join('\n') }
}

// ---------------------------------------------------------------------------
// 工具链解析（← Env / SysEnv 的 get_git_path / get_node_path）
// ---------------------------------------------------------------------------

export interface Toolchain {
  gitExe: string | null
  nodeExe: string | null
  npmExe: string | null
  /** 镜像配置使用的 git 目录（env/cmd 或系统 git 所在目录） */
  gitDir: string | null
  portable: boolean
}

export function resolveToolchain(
  config: Pick<ConfigStore, 'get'>,
  options: { whichFn?: (binary: string) => string | null; portableEnv?: (envRoot?: string) => PortableEnvPaths } = {},
): Toolchain {
  const whichFn = options.whichFn ?? which
  const isFileOk = (p: string): boolean => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  const useSysEnv = config.get<boolean>('use_sys_env', false)
  if (!useSysEnv) {
    // 内置环境：env/cmd/git.exe、env/node.exe、env/npm.cmd
    const paths = (options.portableEnv ?? resolvePortableEnv)()
    return {
      gitExe: isFileOk(paths.gitExe) ? paths.gitExe : null,
      nodeExe: isFileOk(paths.nodeExe) ? paths.nodeExe : null,
      npmExe: isFileOk(paths.npmCmd) ? paths.npmCmd : null,
      gitDir: paths.gitDir,
      portable: true,
    }
  }
  // 系统环境：PATH 探测
  const gitExe = whichFn('git')
  const nodeExe = whichFn('node')
  const npmExe = whichFn('npm')
  return {
    gitExe,
    nodeExe,
    npmExe,
    gitDir: gitExe ? dirname(gitExe) : null,
    portable: false,
  }
}

// ---------------------------------------------------------------------------
// gitconfig INI 解析/序列化（← configparser + optionxform=str + 手写回写）
// ---------------------------------------------------------------------------

export interface IniSection {
  name: string
  entries: Array<{ key: string; value: string }>
}

/** 多编码容错读取：utf-8 → gbk → latin1（← Python 三段 fallback） */
export function readGitConfigText(path: string): string {
  const buffer = readFileSync(path)
  for (const encoding of ['utf-8', 'gbk', 'latin1']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer)
    } catch {
      // 尝试下一编码
    }
  }
  return buffer.toString('latin1')
}

export function parseGitConfigIni(text: string): IniSection[] {
  const sections: IniSection[] = []
  let current: IniSection | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sectionMatch = /^\[(.+)\]$/.exec(line)
    if (sectionMatch) {
      current = { name: sectionMatch[1] ?? '', entries: [] }
      sections.push(current)
      continue
    }
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    const value = line.slice(eqIndex + 1).trim()
    if (!current) {
      // ← configparser MissingSectionHeaderError
      throw new Error('更新Git配置失败: Missing section header')
    }
    // 键名大小写保留（optionxform=str）
    current.entries.push({ key, value })
  }
  return sections
}

export function serializeGitConfigIni(sections: IniSection[]): string {
  const parts: string[] = []
  for (const section of sections) {
    parts.push(`[${section.name}]\n`)
    for (const { key, value } of section.entries) {
      // 转义可能引起问题的字符（← value.replace("%", "%%")）
      parts.push(`${key} = ${value.replace(/%/g, '%%')}\n`)
    }
    parts.push('\n')
  }
  return parts.join('')
}

function iniHasOption(section: IniSection, key: string): boolean {
  return section.entries.some((entry) => entry.key === key)
}

function iniGetOption(section: IniSection, key: string): string | undefined {
  return section.entries.find((entry) => entry.key === key)?.value
}

function iniSetOption(section: IniSection, key: string, value: string): void {
  const existing = section.entries.find((entry) => entry.key === key)
  if (existing) existing.value = value
  else section.entries.push({ key, value })
}

// ---------------------------------------------------------------------------
// 依赖注入面（测试 mock processManager / git / config / stConfig）
// ---------------------------------------------------------------------------

export interface StProxyConfig {
  proxyEnabled: boolean
  proxyUrl: string
  save(): boolean
}

export interface StLifecycleDeps {
  executeProcessAsync?: (options: ExecuteProcessOptions) => Promise<ProcessInfo | null>
  runGit?: (args: string[], cwd: string, options?: GitCallOptions) => Promise<SyncSpawnResult & { ok: boolean }>
  cleanupGitState?: (stDir?: string, options?: GitCallOptions) => Promise<BoolMessage>
  checkGitStatus?: (stDir?: string, options?: GitCallOptions) => Promise<BoolMessage>
  checkoutStTag?: (tagName: string, stDir?: string, options?: GitCallOptions) => Promise<BoolMessage>
  getCurrentCommit?: (stDir?: string, options?: GitCallOptions) => Promise<{ ok: boolean; commit: string | null; message: string }>
  switchGitRemote?: (mirrorType?: string, stDir?: string, options?: GitCallOptions) => Promise<BoolMessage>
  configStore?: Pick<ConfigStore, 'get' | 'set' | 'save'>
  stConfig?: StProxyConfig
  getActiveProcessesCount?: () => number
  /** ST 服务进程是否在运行（← Python is_running 显式标志语义；默认按 kind='st-server' 检查） */
  hasStServerProcess?: () => boolean
  stopAllProcesses?: (onEvent?: (message: string) => void) => Promise<boolean>
  whichFn?: (binary: string) => string | null
  portableEnv?: (envRoot?: string) => PortableEnvPaths
}

export interface StLifecycleOptions {
  baseDir?: string
  /** 终端日志回调（← terminal.add_log 等价物） */
  onLog?: (message: string) => void
  deps?: StLifecycleDeps
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export interface StartStResult extends BoolMessage {
  proc: ProcessInfo | null
}

export type StUpdateCheckStatus = 'not-installed' | 'no-git' | 'check-failed' | 'up-to-date' | 'needs-update'

export interface StUpdateCheckResult {
  status: StUpdateCheckStatus
  message: string
}

// ---------------------------------------------------------------------------
// StLifecycle
// ---------------------------------------------------------------------------

export class StLifecycle {
  readonly baseDir: string
  readonly stDir: string
  private readonly onLog: (message: string) => void
  private readonly deps: StLifecycleDeps

  constructor(options: StLifecycleOptions = {}) {
    this.baseDir = options.baseDir ?? process.cwd()
    this.stDir = join(this.baseDir, 'SillyTavern')
    this.onLog = options.onLog ?? (() => undefined)
    this.deps = options.deps ?? {}
  }

  private log(message: string): void {
    this.onLog(message)
  }

  private get config(): Pick<ConfigStore, 'get' | 'set' | 'save'> {
    return this.deps.configStore ?? getConfigStore()
  }

  private get runGitFn(): NonNullable<StLifecycleDeps['runGit']> {
    return this.deps.runGit ?? runGit
  }

  /** 等待进程退出并返回退出码 */
  private async waitProcess(proc: ProcessInfo): Promise<number | null> {
    return proc.proc.exited
  }

  /** ← execute_command：env 组装 + processManager 执行 */
  private async executeCommand(
    command: string,
    workdir: string,
    kind?: string,
  ): Promise<ProcessInfo | null> {
    const execute = this.deps.executeProcessAsync ?? executeProcessAsync
    const useSysEnv = this.config.get<boolean>('use_sys_env', false)
    let prependDirs: string[] = []
    if (!useSysEnv) {
      const resolveEnv = this.deps.portableEnv ?? resolvePortableEnv
      const paths = resolveEnv(join(this.baseDir, 'env'))
      prependDirs = [dirname(paths.nodeExe), paths.gitDir]
    }
    const env = buildProcessEnv(prependDirs)
    // 确保工作目录存在（← os.makedirs(workdir, exist_ok=True)）
    ensureDirSync(workdir)
    // 进程 stdout/stderr 与命令回显接入终端日志（← Python execute_process_async 的 add_log 路径）
    return execute({
      command,
      cwd: workdir,
      env,
      kind,
      onLine: (line) => this.log(line.text),
      onEvent: (message) => this.log(message),
    })
  }

  private toolchain(): Toolchain {
    return resolveToolchain(this.config, {
      whichFn: this.deps.whichFn,
      portableEnv: this.deps.portableEnv,
    })
  }

  /** ST 是否在运行（← terminal.is_running 显式标志语义；按 kind='st-server' 判定，临时 git/npm 不算） */
  private isRunning(): boolean {
    return (this.deps.hasStServerProcess ?? hasActiveProcess)('st-server')
  }

  /** ← _record_download */
  private recordDownload(action: string): void {
    try {
      const downloads = this.config.get<unknown[]>('downloads', []) ?? []
      downloads.push({ timestamp: new Date().toISOString(), action })
      this.config.set('downloads', downloads)
      this.config.save()
    } catch (err) {
      console.error(`[stLifecycle] 记录下载行为失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // 安装（← install_sillytavern；确认对话框由 UI 层发起后调用）
  // -------------------------------------------------------------------------

  /** 失败 clone 目录判定：空目录或仅含 .git（← is_failed_clone_folder） */
  private isFailedCloneFolder(path: string): boolean {
    try {
      if (!existsSync(path)) return false
      const entries = readdirSync(path)
      return entries.length === 0 || (entries.length === 1 && entries[0] === '.git')
    } catch {
      return false
    }
  }

  async installSt(): Promise<BoolMessage> {
    try {
      const validation = validatePathForNpm(this.baseDir)
      this.log(validation.message)
      if (!validation.ok) return { ok: false, message: validation.message }

      const tools = this.toolchain()
      if (checkStInstalled(this.stDir)) {
        this.log('SillyTavern已安装')
        if (tools.npmExe) {
          if (checkNodeModules(this.stDir)) {
            this.log('依赖项已安装')
            return { ok: true, message: 'SillyTavern已安装，依赖项已安装' }
          }
          this.log('正在安装依赖...')
          const proc = await this.executeCommand(
            buildNpmInstallCommand(tools.npmExe),
            this.stDir,
          )
          if (proc) {
            await this.waitProcess(proc)
            this.log('依赖安装完成')
            return { ok: true, message: '依赖安装完成' }
          }
          return { ok: false, message: '创建npm install进程失败' }
        }
        this.log('未找到nodejs')
        return { ok: true, message: 'SillyTavern已安装，未找到nodejs' }
      }

      // ST 未安装 → git clone
      if (!tools.gitExe) {
        this.log('Error: Git路径未正确配置')
        return { ok: false, message: 'Error: Git路径未正确配置' }
      }

      this.log(`正在从 ${ST_REPO_URL} 安装SillyTavern...`)
      const proc = await this.executeCommand(buildGitCloneCommand(tools.gitExe), this.baseDir)
      if (!proc) {
        this.log('安装失败: 创建git clone进程失败')
        return { ok: false, message: '安装失败: 创建git clone进程失败' }
      }
      const exitCode = await this.waitProcess(proc)
      if (exitCode !== 0) {
        const errorMsg = `安装失败: git clone进程返回错误码: ${exitCode}`
        this.log(errorMsg)
        // 自动清理失败的clone文件夹
        if (this.isFailedCloneFolder(this.stDir)) {
          try {
            rmSync(this.stDir, { recursive: true, force: true })
            this.log('已自动清理失败的安装目录')
          } catch (cleanupErr) {
            console.error(`[stLifecycle] 清理失败目录时出错: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
          }
        }
        return { ok: false, message: errorMsg }
      }
      this.log('SillyTavern安装完成')
      this.recordDownload('clone')

      // 检查Node.js环境并自动安装依赖
      if (tools.npmExe) {
        if (!checkNodeModules(this.stDir)) {
          this.log('正在安装依赖...')
          const depProcess = await this.executeCommand(
            buildNpmInstallCommand(tools.npmExe),
            this.stDir,
          )
          if (depProcess) {
            await this.waitProcess(depProcess)
            this.log('依赖安装完成')
          }
        } else {
          this.log('依赖项已安装')
        }
      } else {
        this.log('未找到nodejs')
      }
      return { ok: true, message: 'SillyTavern安装完成' }
    } catch (err) {
      const errorMsg = `安装SillyTavern时出错: ${err instanceof Error ? err.message : String(err)}`
      this.log(errorMsg)
      console.error(`[stLifecycle] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }

  // -------------------------------------------------------------------------
  // 启动/停止/重启
  // -------------------------------------------------------------------------

  /**
   * ← auto_proxy 检测（DEVIATION: 仅环境变量代理，注册表不读）。
   * stConfig 取依赖注入或全局单例；仅在 startSt 检测到 auto_proxy 配置开启时调用。
   */
  private async autoDetectProxy(): Promise<void> {
    // 生产构造不注入 stConfig 依赖，须懒默认到全局单例（否则 auto_proxy 静默失效）
    const stCfg = this.deps.stConfig ?? getStConfig()
    const env = process.env
    const candidates = [
      env.HTTPS_PROXY ?? env.https_proxy,
      env.HTTP_PROXY ?? env.http_proxy,
      env.ALL_PROXY ?? env.all_proxy,
    ]
    const proxyUrl = candidates.find((value) => typeof value === 'string' && value.length > 0) ?? ''
    if (!proxyUrl) {
      stCfg.proxyEnabled = false
      stCfg.save()
      this.log('未检测到有效的系统代理，已自动关闭请求代理')
      return
    }
    stCfg.proxyEnabled = true
    stCfg.proxyUrl = proxyUrl
    stCfg.save()
    this.log(`自动设置代理: ${proxyUrl}`)
  }

  /** ← start_sillytavern（首次启动确认对话框由 UI 层处理 has_started_st） */
  async startSt(): Promise<StartStResult> {
    try {
      this.log('正在启动SillyTavern...')

      const validation = validatePathForNpm(this.baseDir)
      this.log(validation.message)
      if (!validation.ok) return { ok: false, message: validation.message, proc: null }

      // 检查是否开启了自动代理设置
      if (this.config.get<boolean>('auto_proxy', false)) {
        try {
          await this.autoDetectProxy()
        } catch (err) {
          this.log(`自动检测代理时出错: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (this.isRunning()) {
        this.log('SillyTavern已经在运行中')
        return { ok: false, message: 'SillyTavern已经在运行中', proc: null }
      }

      if (!checkStInstalled(this.stDir)) {
        this.log('SillyTavern未安装，请先安装SillyTavern')
        return { ok: false, message: 'SillyTavern未安装，请先安装SillyTavern', proc: null }
      }
      if (!checkNodeModules(this.stDir)) {
        this.log('依赖未安装，请先安装依赖')
        return { ok: false, message: '依赖未安装，请先安装依赖', proc: null }
      }

      const tools = this.toolchain()
      if (!tools.nodeExe) {
        this.log('未找到nodejs')
        return { ok: false, message: '未找到nodejs', proc: null }
      }

      // 自定义参数安全性校验（防御性编程）
      let customArgs = this.config.get<string>('custom_args', '')
      if (customArgs) {
        const validation = validateCustomArgs(customArgs)
        if (!validation.ok) {
          this.log(`警告：自定义启动参数不安全，已忽略: ${validation.message}`)
          customArgs = ''
        }
      }
      const useOptimizeArgs = this.config.get<boolean>('use_optimize_args', false)
      const command = buildStStartCommand({
        nodeExe: tools.nodeExe,
        useOptimizeArgs,
        customArgs,
      })

      const proc = await this.executeCommand(command, this.stDir, 'st-server')
      if (proc) {
        this.log('✓ SillyTavern启动成功')
        // 进程退出后的状态复位由调用方（UI 层）在 whenSettled 后处理
        return { ok: true, message: '✓ SillyTavern启动成功', proc }
      }
      return { ok: false, message: '创建进程失败', proc: null }
    } catch (err) {
      const errorMsg = `启动SillyTavern时出错: ${err instanceof Error ? err.message : String(err)}`
      this.log(errorMsg)
      console.error(`[stLifecycle] ${errorMsg}`)
      return { ok: false, message: errorMsg, proc: null }
    }
  }

  /** ← stop_sillytavern */
  async stopSt(): Promise<BoolMessage> {
    try {
      this.log('正在检查进程状态...')
      const count = (this.deps.getActiveProcessesCount ?? getActiveProcessesCount)()
      if (count === 0) {
        this.log('当前没有运行中的进程')
        return { ok: true, message: '当前没有运行中的进程' }
      }
      this.log(`检测到 ${count} 个运行中的进程`)
      this.log('正在停止SillyTavern进程...')
      const stop = this.deps.stopAllProcesses ?? stopAllProcesses
      await stop((message) => this.log(message))
      this.log('✓ 所有进程已停止')
      return { ok: true, message: '✓ 所有进程已停止' }
    } catch (err) {
      const errorMsg = `停止进程时出错: ${err instanceof Error ? err.message : String(err)}`
      this.log(errorMsg)
      console.error(`[stLifecycle] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }

  /** ← restart_sillytavern（路径检查仅中文+空格，1:1） */
  async restartSt(): Promise<StartStResult> {
    this.log('正在重启SillyTavern...')
    try {
      const stop = this.deps.stopAllProcesses ?? stopAllProcesses
      await stop((message) => this.log(message))
      this.log('旧进程已停止')

      // 检查路径是否包含中文或空格（restart 仅做这两项检查）
      const currentPath = this.baseDir
      const hasChinese = [...currentPath].some((char) => char >= '\u4e00' && char <= '\u9fff')
      if (hasChinese) {
        const message = '错误：路径包含中文字符，请将程序移动到不包含中文字符的路径下运行'
        this.log(message)
        return { ok: false, message, proc: null }
      }
      if (currentPath.includes(' ')) {
        const message = '错误：路径包含空格，请将程序移动到不包含空格的路径下运行'
        this.log(message)
        return { ok: false, message, proc: null }
      }

      if (!checkStInstalled(this.stDir)) {
        this.log('SillyTavern未安装')
        return { ok: false, message: 'SillyTavern未安装', proc: null }
      }
      if (!checkNodeModules(this.stDir)) {
        this.log('依赖项未安装')
        return { ok: false, message: '依赖项未安装', proc: null }
      }

      const tools = this.toolchain()
      if (!tools.nodeExe) {
        this.log('未找到nodejs')
        return { ok: false, message: '未找到nodejs', proc: null }
      }

      let customArgs = this.config.get<string>('custom_args', '')
      if (customArgs) {
        const validation = validateCustomArgs(customArgs)
        if (!validation.ok) {
          this.log(`警告：自定义启动参数不安全，已忽略: ${validation.message}`)
          customArgs = ''
        }
      }
      const useOptimizeArgs = this.config.get<boolean>('use_optimize_args', false)
      const command = buildStStartCommand({
        nodeExe: tools.nodeExe,
        useOptimizeArgs,
        customArgs,
      })

      const proc = await this.executeCommand(command, this.stDir, 'st-server')
      if (proc) {
        this.log('SillyTavern已重启')
        return { ok: true, message: 'SillyTavern已重启', proc }
      }
      this.log('重启失败')
      return { ok: false, message: '重启失败', proc: null }
    } catch (err) {
      const message = `重启失败: ${err instanceof Error ? err.message : String(err)}`
      this.log(message)
      console.error(`[stLifecycle] ${message}`)
      return { ok: false, message, proc: null }
    }
  }

  // -------------------------------------------------------------------------
  // 更新（← update_sillytavern + update_sillytavern_with_callback 合并）
  // -------------------------------------------------------------------------

  /**
   * 单次 npm install 执行；_with_callback 变体（withAutoStart）失败时
   * cache clean + 删除 node_modules 后重试（← on_npm_complete 重试链，≤2 重试；
   * 普通变体失败即止，1:1 对应 Python 两个 update 方法的行为差异）。
   */
  private async runNpmInstallWithRetry(npmExe: string, withAutoStart: boolean): Promise<BoolMessage> {
    let npmRetryCount = 0
    for (;;) {
      this.log('正在安装依赖...')
      const proc = await this.executeCommand(buildNpmInstallCommand(npmExe), this.stDir)
      const exitCode = proc ? await this.waitProcess(proc) : null
      if (exitCode === 0) {
        this.log('依赖安装成功')
        return { ok: true, message: '依赖安装成功' }
      }
      if (!withAutoStart || npmRetryCount >= 2) {
        const message = withAutoStart ? '依赖安装失败，正在启动SillyTavern...' : '依赖安装失败'
        this.log(message)
        return { ok: false, message }
      }
      npmRetryCount += 1
      this.log(`依赖安装失败，正在重试... (尝试次数: ${npmRetryCount}/2)`)
      // 清理npm缓存
      const cacheProcess = await this.executeCommand(
        buildNpmCacheCleanCommand(npmExe),
        this.stDir,
      )
      if (cacheProcess) await this.waitProcess(cacheProcess)
      // 删除node_modules
      const nodeModulesPath = join(this.stDir, 'node_modules')
      if (existsSync(nodeModulesPath)) {
        try {
          rmSync(nodeModulesPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch (err) {
          this.log(`删除node_modules失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  /**
   * ← update_sillytavern / update_sillytavern_with_callback。
   * withAutoStart=true 对应 _with_callback 变体（失败/成功后自动启动）。
   */
  async updateSt(options: { withAutoStart?: boolean } = {}): Promise<BoolMessage> {
    const withAutoStart = options.withAutoStart ?? false
    try {
      const validation = validatePathForNpm(this.baseDir)
      this.log(validation.message)
      if (!validation.ok) return { ok: false, message: validation.message }

      const tools = this.toolchain()
      if (!checkStInstalled(this.stDir)) {
        this.log('SillyTavern未安装')
        return { ok: false, message: 'SillyTavern未安装' }
      }
      this.log('正在更新SillyTavern...')
      if (!tools.gitExe) {
        this.log('未找到Git路径，请手动更新SillyTavern')
        return { ok: false, message: '未找到Git路径，请手动更新SillyTavern' }
      }

      // 步骤0：清理Git未完成状态（merge、rebase等）
      this.log('清理Git状态...')
      try {
        const cleanup = this.deps.cleanupGitState ?? cleanupGitState
        const { ok: cleanupOk, message: cleanupMessage } = await cleanup(this.stDir)
        if (!cleanupOk) this.log(`警告: ${cleanupMessage}`)
        else this.log(cleanupMessage)
      } catch (err) {
        this.log(`清理Git状态时出错: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 检查并恢复detached HEAD状态
      this.log('检查Git状态...')
      try {
        const branchCheck = await this.runGitFn(['rev-parse', '--abbrev-ref', 'HEAD'], this.stDir)
        if (branchCheck.ok) {
          const currentBranch = branchCheck.stdout.trim()
          if (currentBranch === 'HEAD') {
            this.log('检测到detached HEAD状态，正在切换到release分支...')
            const checkoutResult = await this.runGitFn(
              ['checkout', '-B', 'release', 'origin/release'],
              this.stDir,
            )
            if (checkoutResult.ok) {
              this.log('成功切换到release分支')
            } else {
              // 尝试更简单的恢复方式
              this.log('尝试另一种恢复方式...')
              const checkoutResult2 = await this.runGitFn(['checkout', 'release'], this.stDir)
              if (checkoutResult2.ok) {
                this.log('成功切换到release分支')
              } else {
                this.log('切换到release分支失败，请手动处理')
                return { ok: false, message: '切换到release分支失败，请手动处理' }
              }
            }
          }
        }
      } catch (err) {
        this.log(`检查detached HEAD状态时出错: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 检查当前远程仓库地址是否正确（所有镜像源都使用GitHub原始仓库地址）
      try {
        const currentRemoteProcess = await this.runGitFn(['remote', 'get-url', 'origin'], this.stDir)
        if (currentRemoteProcess.ok) {
          const currentRemote = currentRemoteProcess.stdout.trim()
          if (currentRemote !== EXPECTED_ST_REMOTE) {
            this.log(`更新远程仓库地址: ${EXPECTED_ST_REMOTE}`)
            await this.runGitFn(['remote', 'set-url', 'origin', EXPECTED_ST_REMOTE], this.stDir)
          }
        }
      } catch (err) {
        this.log(`检查/更新远程仓库地址时出错: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 执行git pull（package-lock 冲突恢复 ≤2 重试）
      let gitUpdated = false
      let retryCount = 0
      while (!gitUpdated) {
        const pullProcess = await this.executeCommand(
          buildGitPullCommand(tools.gitExe),
          this.stDir,
        )
        const exitCode = pullProcess ? await this.waitProcess(pullProcess) : null
        if (exitCode === 0) {
          this.log('Git更新成功')
          gitUpdated = true
          break
        }
        if (retryCount < 2) {
          retryCount += 1
          this.log(
            `Git更新失败，检查是否为package-lock.json冲突... (尝试次数: ${retryCount}/2)`,
          )
          try {
            // 尝试解决package-lock.json冲突
            const resetProcess = await this.runGitFn(
              ['checkout', '--', 'package-lock.json'],
              this.stDir,
            )
            if (resetProcess.ok) {
              this.log('已重置package-lock.json，重新尝试更新...')
              continue
            }
            this.log('无法解决package-lock.json冲突，需要手动处理')
            return { ok: false, message: '无法解决package-lock.json冲突，需要手动处理' }
          } catch (err) {
            this.log(`处理package-lock.json冲突时出错: ${err instanceof Error ? err.message : String(err)}`)
            return { ok: false, message: `处理package-lock.json冲突时出错: ${err instanceof Error ? err.message : String(err)}` }
          }
        }
        // 重试次数耗尽（← _with_callback: Git更新失败，正在启动...）
        if (withAutoStart) {
          this.log('Git更新失败，正在启动SillyTavern...')
          await this.startSt()
          return { ok: false, message: 'Git更新失败（已按配置启动SillyTavern）' }
        }
        this.log('重试更新失败')
        return { ok: false, message: '重试更新失败' }
      }

      // 安装依赖（node_modules 重装重试链）
      if (tools.npmExe) {
        const npmResult = await this.runNpmInstallWithRetry(tools.npmExe, withAutoStart)
        if (withAutoStart) {
          if (npmResult.ok) {
            this.log('依赖安装成功，正在启动SillyTavern...')
          }
          await this.startSt()
          return npmResult
        }
        return npmResult
      }
      this.log(withAutoStart ? '未找到nodejs，正在启动SillyTavern...' : '未找到nodejs')
      if (withAutoStart) await this.startSt()
      return { ok: true, message: withAutoStart ? 'Git更新成功（未找到nodejs，已启动SillyTavern）' : 'Git更新成功（未找到nodejs）' }
    } catch (err) {
      const errorMsg = `更新SillyTavern时出错: ${err instanceof Error ? err.message : String(err)}`
      this.log(errorMsg)
      console.error(`[stLifecycle] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }

  // -------------------------------------------------------------------------
  // 启动前更新检查（← check_and_start_sillytavern）
  // -------------------------------------------------------------------------

  /** ← check_updates 的差异判定（纯编排，无自动启动副作用） */
  async checkForStUpdate(): Promise<StUpdateCheckResult> {
    if (!checkStInstalled(this.stDir)) {
      return { status: 'not-installed', message: 'SillyTavern未安装，请先安装' }
    }
    this.log('正在检查更新...')
    const tools = this.toolchain()
    if (!tools.gitExe) {
      return { status: 'no-git', message: '未找到Git路径，直接启动SillyTavern...' }
    }

    try {
      // git fetch --all
      const fetchProcess = await this.executeCommand(`"${tools.gitExe}" fetch --all`, this.stDir)
      if (!fetchProcess) {
        return { status: 'check-failed', message: '执行更新检查命令失败，直接启动SillyTavern...' }
      }
      if ((await this.waitProcess(fetchProcess)) !== 0) {
        return { status: 'check-failed', message: '检查更新失败，直接启动SillyTavern...' }
      }

      // git status -uno（与 Python 一致地先行执行）
      this.log('正在检查release分支状态...')
      const statusProcess = await this.executeCommand(`"${tools.gitExe}" status -uno`, this.stDir)
      if (!statusProcess) {
        return { status: 'check-failed', message: '无法执行状态检查命令，直接启动SillyTavern...' }
      }
      await this.waitProcess(statusProcess)

      // git diff release..origin/release
      const diffProcess = await this.runGitFn(['diff', 'release..origin/release'], this.stDir)
      if (diffProcess.ok && !diffProcess.stdout.trim()) {
        return { status: 'up-to-date', message: '已是最新版本，正在启动SillyTavern...' }
      }
      return { status: 'needs-update', message: '检测到新版本，正在更新...' }
    } catch (err) {
      return {
        status: 'check-failed',
        message: `检查更新时出错: ${err instanceof Error ? err.message : String(err)}，正在更新...`,
      }
    }
  }

  /** ← check_and_start_sillytavern：无差异启动，有差异先更新再启动 */
  async checkAndStartSt(): Promise<BoolMessage> {
    const result = await this.checkForStUpdate()
    this.log(result.message)
    switch (result.status) {
      case 'not-installed':
        return { ok: false, message: result.message }
      case 'needs-update':
        return this.updateSt({ withAutoStart: true })
      default:
        // no-git / check-failed / up-to-date → 直接启动（Python 语义）
        return this.startSt()
    }
  }

  // -------------------------------------------------------------------------
  // 版本切换（← switch_st_version；确认/安装依赖对话框归 UI 层）
  // -------------------------------------------------------------------------

  async switchStVersion(
    versionInfo: { version: string; commit?: string; date?: string },
    tagName: string,
  ): Promise<BoolMessage> {
    try {
      // 1. 检查SillyTavern是否正在运行
      if (this.isRunning()) {
        const errorMsg = '错误: 请先停止SillyTavern后再切换版本'
        this.log(errorMsg)
        console.error(`[stLifecycle] ${errorMsg}`)
        return { ok: false, message: errorMsg }
      }

      this.log(`开始切换到版本 v${versionInfo.version}...`)

      // 2. 检查Git工作区状态
      const checkStatus = this.deps.checkGitStatus ?? checkGitStatus
      const { ok: isClean, message: statusMsg } = await checkStatus(this.stDir)
      if (!isClean) {
        this.log(`警告: ${statusMsg}`)
        console.warn(`[stLifecycle] 版本切换警告: ${statusMsg}`)
        return { ok: false, message: `${statusMsg}，切换可能丢失更改` }
      }

      // 3. 执行版本切换（使用tag）
      const checkout = this.deps.checkoutStTag ?? checkoutStTag
      const { ok: checkoutOk, message } = await checkout(tagName, this.stDir)
      if (!checkoutOk) {
        this.log(`✗ ${message}`)
        console.error(`[stLifecycle] 切换版本失败: ${message}`)
        return { ok: false, message: `切换版本失败: ${message}` }
      }

      this.log(`✓ ${message}`)
      this.log(`✓ 成功切换到版本 v${versionInfo.version}`)

      // 验证当前commit
      const getCommit = this.deps.getCurrentCommit ?? getCurrentCommit
      const { ok: verifyOk, commit, message: verifyMsg } = await getCommit(this.stDir)
      if (verifyOk && commit) {
        this.log(`当前commit: ${commit.slice(0, 7)}`)
      }

      return { ok: true, message: `成功切换到版本 v${versionInfo.version}` }
    } catch (err) {
      const errorMsg = `切换版本时发生错误: ${err instanceof Error ? err.message : String(err)}`
      this.log(errorMsg)
      console.error(`[stLifecycle] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }

  /** ← install_npm_dependencies（无 --omit=dev，1:1） */
  async installNpmDependencies(): Promise<BoolMessage> {
    try {
      if (!existsSync(this.stDir)) {
        this.log('错误: SillyTavern目录不存在')
        return { ok: false, message: 'SillyTavern目录不存在' }
      }
      const tools = this.toolchain()
      if (!tools.npmExe) {
        this.log('错误: 未找到 Node.js')
        return { ok: false, message: '未找到 Node.js' }
      }
      this.log('正在执行 npm install，这可能需要几分钟...')
      const proc = await this.executeCommand(buildNpmInstallCommandNoOmit(tools.npmExe), this.stDir)
      if (!proc) {
        this.log('错误: 无法执行npm install')
        return { ok: false, message: '无法执行npm install' }
      }
      await this.waitProcess(proc)
      this.log('✓ npm依赖安装完成')
      return { ok: true, message: 'npm依赖安装完成' }
    } catch (err) {
      const errorMsg = `安装依赖时发生错误: ${err instanceof Error ? err.message : String(err)}`
      this.log(errorMsg)
      console.error(`[stLifecycle] ${errorMsg}`)
      return { ok: false, message: errorMsg }
    }
  }

  // -------------------------------------------------------------------------
  // 镜像管理（← update_mirror_setting，event.py:1673-1833）
  // -------------------------------------------------------------------------

  /** gitconfig 路径解析（内置 Git 的三种 fallback，1:1） */
  private resolveGitConfigPath(gitDir: string, portable: boolean): string | null {
    if (!portable) {
      // 系统Git使用internal配置文件
      return join(homedir(), '.gitconfig_internal')
    }
    let gitconfigPath = join(gitDir, '..', 'etc', 'gitconfig')
    if (!existsSync(gitconfigPath)) {
      gitconfigPath = join(gitDir, 'etc', 'gitconfig')
    }
    if (!existsSync(gitconfigPath)) {
      gitconfigPath = join(dirname(gitDir), 'etc', 'gitconfig')
    }
    // 验证最终路径是否存在
    if (!existsSync(dirname(gitconfigPath))) {
      return null
    }
    return gitconfigPath
  }

  async updateMirrorSetting(mirrorType: string): Promise<BoolMessage> {
    try {
      // 保存设置到配置文件
      this.config.set('github.mirror', mirrorType)
      this.config.save()

      // 判断是否应修改内部Git配置（仅限内置Git或启用了patchgit的系统Git）
      const useSysEnv = this.config.get<boolean>('use_sys_env', false)
      const shouldPatch =
        (useSysEnv && this.config.get<boolean>('patchgit', false)) || !useSysEnv

      const tools = this.toolchain()
      const gitDir = tools.gitDir
      if (shouldPatch && gitDir && existsSync(gitDir)) {
        // 使用配置文件直接操作方式
        const gitconfigPath = this.resolveGitConfigPath(gitDir, tools.portable)
        if (!gitconfigPath) {
          this.log(`错误: 无法找到Git配置目录: ${gitDir}`)
          return { ok: false, message: `无法找到Git配置目录: ${gitDir}` }
        }

        // 读取现有配置（多编码容错）
        const sections: IniSection[] = existsSync(gitconfigPath)
          ? parseGitConfigIni(readGitConfigText(gitconfigPath))
          : []

        // 收集所有指向 https://github.com/ 的 insteadof 规则并删除
        const sectionsToKeep: IniSection[] = []
        let removedCount = 0
        for (const section of sections) {
          if (section.name.startsWith('url "') && section.name.endsWith('"')) {
            const insteadOf = section.entries.find((entry) => entry.key === 'insteadof')?.value
            if (insteadOf === 'https://github.com/') {
              this.log(`移除旧镜像映射: ${section.name}`)
              removedCount += 1
              continue
            }
          }
          sectionsToKeep.push(section)
        }
        if (removedCount > 0) {
          this.log(`共移除 ${removedCount} 个旧的镜像映射`)
        }
        const gitconfig = sectionsToKeep

        // 仅当选择非GitHub镜像时才添加镜像映射
        let needsWrite = false
        if (mirrorType !== 'github') {
          // 使用镜像站作为GitHub的镜像源
          const mirrorUrl = `https://${mirrorType}/https://github.com/`
          const newSectionName = `url "${mirrorUrl}"`
          const targetInsteadOf = 'https://github.com/'

          const existing = gitconfig.find((section) => section.name === newSectionName)
          if (!existing) {
            gitconfig.push({
              name: newSectionName,
              entries: [{ key: 'insteadof', value: targetInsteadOf }],
            })
            needsWrite = true
            this.log(`添加镜像映射: ${newSectionName} -> ${targetInsteadOf}`)
          } else if (!iniHasOption(existing, 'insteadof')) {
            existing.entries.push({ key: 'insteadof', value: targetInsteadOf })
            needsWrite = true
            this.log(`添加镜像映射: ${newSectionName} -> ${targetInsteadOf}`)
          } else {
            // 检查当前配置是否已经是目标值
            const currentInsteadOf = iniGetOption(existing, 'insteadof')
            if (currentInsteadOf !== targetInsteadOf) {
              iniSetOption(existing, 'insteadof', targetInsteadOf)
              needsWrite = true
              this.log(`更新镜像映射: ${newSectionName} -> ${targetInsteadOf}`)
            }
          }
        }

        // 如果没有配置项且文件不存在，则不创建空文件
        if (gitconfig.length === 0 && !existsSync(gitconfigPath)) {
          this.log('未添加任何镜像配置，无需创建配置文件')
        } else {
          // 检查是否有实际变更
          const hasChanges = needsWrite || removedCount > 0
          if (!hasChanges) {
            this.log('镜像配置无变更，跳过写入')
          } else {
            // 确保目录存在 + 写回
            ensureDirSync(dirname(gitconfigPath))
            writeFileSync(gitconfigPath, serializeGitConfigIni(gitconfig), 'utf8')
            this.log(mirrorType === 'github' ? '已恢复使用官方GitHub源' : 'Git镜像配置已成功更新')
          }
        }
      }

      // 若SillyTavern已存在，同步切换其远程地址为GitHub原始仓库
      if (checkStInstalled(this.stDir)) {
        const switchRemote = this.deps.switchGitRemote ?? switchGitRemote
        const { ok: remoteOk, message } = await switchRemote(mirrorType, this.stDir)
        if (remoteOk) {
          this.log(`远程仓库地址已同步: ${message}`)
        } else {
          this.log(`切换SillyTavern仓库远程地址失败: ${message}`)
        }
      }

      return { ok: true, message: '镜像配置已更新' }
    } catch (err) {
      const message = `更新Git配置失败: ${err instanceof Error ? err.message : String(err)}`
      this.log(message)
      console.error(`[stLifecycle] ${message}`)
      return { ok: false, message }
    }
  }
}
