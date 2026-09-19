/**
 * ← src/features/system/env.py（Env：便携 env 路径）
 *   + src/features/system/env_sys.py（SysEnv：系统 git/node 探测）
 *
 * - 便携 env 路径：env/cmd/git.exe、env/node.exe、env/npm.cmd、env/SillyTavern。
 * - 系统模式探测：which('git') / which('node') + `--version` 子进程校验。
 * - Node ≥ 18 版本比较（对应 packaging.version.parse）。
 * - Windows 无扩展名可执行文件探测：.exe → .cmd → .bat → .ps1
 *   （照搬 terminal.py 的扩展名探测顺序，Node 包的 POSIX 脚本与
 *   .cmd 启动器伴生，必须优先选择 Win32 可执行文件）。
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { IS_WINDOWS, isFile, spawnSyncCmd, which } from './runtime'

/** ← env.py Env 的路径集合 */
export interface PortableEnvPaths {
  /** <cwd>/env */
  baseDir: string
  /** <cwd>/env/cmd（git.exe 所在目录） */
  gitDir: string
  /** <cwd>/env/cmd/git.exe */
  gitExe: string
  /** <cwd>/env/node.exe */
  nodeExe: string
  /** <cwd>/env/npm.cmd */
  npmCmd: string
  /** <cwd>/SillyTavern */
  stDir: string
}

export function resolvePortableEnv(envRoot?: string): PortableEnvPaths {
  const baseDir = envRoot ?? join(process.cwd(), 'env')
  return {
    baseDir,
    gitDir: join(baseDir, 'cmd'),
    gitExe: join(baseDir, 'cmd', 'git.exe'),
    nodeExe: join(baseDir, 'node.exe'),
    npmCmd: join(baseDir, 'npm.cmd'),
    stDir: join(dirname(baseDir), 'SillyTavern'),
  }
}

/** ← Env.checkEnv：成功返回 true，失败返回错误消息字符串（保留 Python 原文） */
export function checkEnv(paths: PortableEnvPaths): true | string {
  if (!existsSync(paths.baseDir)) return 'Base dir is not exists'
  if (!existsSync(paths.gitDir)) return 'Git dir is not exists'
  // Python 中 node_path 即 base_dir 本身
  if (!existsSync(paths.baseDir)) return 'Node path is not exists'
  return true
}

/** ← Env.checkST / SysEnv.checkST：SillyTavern 是否已安装 */
export function checkStInstalled(stDir: string): boolean {
  return isFile(join(stDir, 'package.json')) && isFile(join(stDir, 'server.js'))
}

/** ← Env.check_nodemodules */
export function checkNodeModules(stDir: string): boolean {
  return existsSync(join(stDir, 'node_modules'))
}

// ---------------------------------------------------------------------------
// 版本比较（← env_sys.py 的 packaging.version 依赖）
// ---------------------------------------------------------------------------

interface ParsedVersion {
  core: [number, number, number]
  pre: string[] | null
}

/** 解析 "v18.20.1"、"1.13.0-beta.1"、"18" 等宽松版本串 */
export function parseVersion(input: string): ParsedVersion | null {
  let s = input.trim()
  if (/^[vV]\d/.test(s)) s = s.slice(1)
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] !== undefined ? m[4].split('.') : null,
  }
}

/**
 * 语义化版本比较：a < b 返回负数，相等返回 0，a > b 返回正数。
 * 无预发布 > 有预发布（semver 规则），与 packaging.version 行为对齐；
 * 无法解析时回退字符串比较。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (xn !== yn) {
      // 数字标识符始终低于字母数字标识符
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// 系统环境探测（← env_sys.py SysEnv）
// ---------------------------------------------------------------------------

export interface GitProbe {
  ok: boolean
  message: string
  /** git.exe 所在目录（带分隔符语义由调用方 join 决定） */
  gitDir: string | null
}

export interface NodeProbe {
  ok: boolean
  message: string
  nodeDir: string | null
  version: string | null
}

/** ← SysEnv.check_system_git：which + `git --version` 退出码校验 */
export function probeSystemGit(whichFn: (binary: string) => string | null = which): GitProbe {
  const gitExecutable = whichFn('git')
  if (!gitExecutable) {
    return { ok: false, message: 'Git is not installed on system', gitDir: null }
  }
  const result = spawnSyncCmd([gitExecutable, '--version'])
  if (result.exitCode !== 0) {
    return { ok: false, message: 'Git is not installed on system', gitDir: null }
  }
  return { ok: true, message: 'ok', gitDir: dirname(gitExecutable) }
}

/** ← SysEnv.check_system_node：which + `node --version` + ≥18 校验 */
export function probeSystemNode(
  whichFn: (binary: string) => string | null = which,
): NodeProbe {
  const nodeExecutable = whichFn('node')
  if (!nodeExecutable) {
    return { ok: false, message: 'Node.js is not installed on system', nodeDir: null, version: null }
  }
  const result = spawnSyncCmd([nodeExecutable, '--version'])
  if (result.exitCode !== 0) {
    return { ok: false, message: 'Node.js is not installed on system', nodeDir: null, version: null }
  }
  const nodeVersion = result.stdout.trim().replace(/^v/, '')
  if (compareVersions(nodeVersion, '18.0.0') < 0) {
    return {
      ok: false,
      message: `Node.js version ${nodeVersion} is too old, requires 18.x LTS or higher`,
      nodeDir: null,
      version: nodeVersion,
    }
  }
  return { ok: true, message: 'ok', nodeDir: dirname(nodeExecutable), version: nodeVersion }
}

/** ← SysEnv.checkSysEnv：两者都通过才返回 true，否则返回错误消息 */
export function checkSysEnv(
  whichFn: (binary: string) => string | null = which,
): true | string {
  const gitCheck = probeSystemGit(whichFn)
  const nodeCheck = probeSystemNode(whichFn)
  if (gitCheck.ok && nodeCheck.ok) return true
  if (!gitCheck.ok) return 'System Git Not Found'
  return 'System Node Not Found'
}

/** ← SysEnv.get_git_root_dir：git.exe 在 cmd/ 或 bin/ 子目录时取上级 */
export function getGitRootDir(gitExePath: string): string {
  const parent = dirname(gitExePath)
  const parentName = basename(parent)
  if (parentName === 'cmd' || parentName === 'bin') {
    return dirname(parent)
  }
  return gitExePath
}

// ---------------------------------------------------------------------------
// Windows 无扩展名可执行文件探测（← terminal.py execute_process_async）
// ---------------------------------------------------------------------------

export const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1'] as const

/** basename 无扩展名时按序探测 .exe/.cmd/.bat/.ps1，均不存在则原样返回 */
export function resolveExecutableExtension(executable: string): string {
  if (!IS_WINDOWS) return executable
  if (basename(executable).includes('.')) return executable
  for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
    const candidate = executable + ext
    if (isFile(candidate)) return candidate
  }
  return executable
}
