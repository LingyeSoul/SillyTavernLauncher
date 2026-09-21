/**
 * ← event.py 编排语义等价测试：命令构造正确性（mock processManager/git
 * 断言调用参数与重试链）、install/start/stop/restart、update 的
 * package-lock 冲突恢复 ≤2 重试与 node_modules 重装重试链、
 * checkAndStart、版本切换、镜像 insteadOf 管理（utf-8 容错读写）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../services/configStore'
import type { StRepoOps } from '../services/isoGit'
import {
  EXPECTED_ST_REMOTE,
  StLifecycle,
  buildBunInstallCommand,
  buildBunInstallForceCommand,
  buildGitCloneCommand,
  buildGitPullCommand,
  buildNpmCacheCleanCommand,
  buildNpmInstallCommand,
  buildNpmInstallCommandNoOmit,
  buildStStartCommand,
  checkStatusFromPorcelain,
  normalizeProxyServer,
  parseGitConfigIni,
  readGitConfigText,
  readWindowsRegistryProxy,
  resolveToolchain,
  serializeGitConfigIni,
  validatePathForNpm,
  type StLifecycleDeps,
  type Toolchain,
} from '../services/stLifecycle'
import type { ExecuteProcessOptions } from '../services/processManager'
import { checkNodeModules, depsPendingMarkerPath } from '../services/env'
import type { ProcessInfo, SyncSpawnResult } from '../services/types'

// stConfig 全局单例替换为内存假对象（避免 auto_proxy 懒默认测试写真实 config.yaml）
const stConfigMock = vi.hoisted(() => ({
  instance: null as { proxyEnabled: boolean; proxyUrl: string; save: () => boolean } | null,
}))
vi.mock('../services/stConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/stConfig')>()),
  getStConfig: () => {
    if (!stConfigMock.instance) {
      stConfigMock.instance = { proxyEnabled: false, proxyUrl: '', save: () => true }
    }
    return stConfigMock.instance
  },
}))

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** CI（GitHub Windows Runner）的 tmpdir() 是 8.3 短路径（C:\Users\RUNNER~1\...），
 *  其中的 '~' 会被 validatePathForNpm 判为 NPM 不支持字符，导致 install/start 全量
 *  用例被产品路径校验提前拦截。先经 realpathSync.native 展开短名为真实长路径再建
 *  临时目录（仅测试基建治"选了非法基座"，产品校验语义不变；展开失败原样回退）。 */
const TMP_ROOT = (() => {
  const raw = tmpdir()
  try {
    return realpathSync.native(raw)
  } catch {
    return raw
  }
})()

let root: string
let configPath: string
let logs: string[]

beforeEach(() => {
  root = mkdtempSync(join(TMP_ROOT, 'stllife'))
  configPath = join(root, 'config.json')
  logs = []
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

/** 系统 git/node 探测假束：env_mode 由测试显式设置，构造期首启探测注入假探测
 *  （避免每个用例真实 spawn git/node --version，且结果与宿主机解耦） */
const FAILING_PROBES = {
  probeGit: () => ({ ok: false }),
  probeNode: () => ({ ok: false }),
}

function makeConfig(initial: Record<string, unknown> = {}): ConfigStore {
  const store = new ConfigStore(configPath, root, FAILING_PROBES)
  store.set('env_mode', 'system')
  for (const [key, value] of Object.entries(initial)) store.set(key, value)
  return store
}

/** 系统 Git/Node/npm 假路径（resolveToolchain 走 which 探测） */
const WHICH_MAP: Record<string, string> = {
  git: 'C:/fake/git.exe',
  node: 'C:/fake/node.exe',
  npm: 'C:/fake/npm.cmd',
}

function fakeProcess(exitCode: number): ProcessInfo {
  return {
    pid: 1,
    command: 'test',
    createdAt: Date.now(),
    proc: {
      pid: 1,
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exited: Promise.resolve(exitCode),
      exitCode,
      kill: () => undefined,
    },
    whenSettled: Promise.resolve(),
  }
}

/** 存活进程模型（server.js）：exited 挂起——启动探针窗口内不退出 = 启动成功 */
function fakeRunningProcess(): ProcessInfo {
  return {
    pid: 1,
    command: 'test',
    createdAt: Date.now(),
    proc: {
      pid: 1,
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exited: new Promise<number>(() => undefined),
      exitCode: null,
      kill: () => undefined,
    },
    whenSettled: Promise.resolve(),
  }
}

/** 延迟退出模型：delayMs 后以 exitCode 退出（复现缺包秒崩的启动期死亡） */
function fakeDelayedExitProcess(exitCode: number, delayMs: number): ProcessInfo {
  let code: number | null = null
  let resolveExited: (value: number) => void = () => undefined
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  setTimeout(() => {
    code = exitCode
    resolveExited(exitCode)
  }, delayMs)
  return {
    pid: 1,
    command: 'test',
    createdAt: Date.now(),
    proc: {
      pid: 1,
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exited,
      get exitCode() {
        return code
      },
      kill: () => undefined,
    },
    whenSettled: Promise.resolve(),
  }
}

/** executeProcessAsync mock：按命令脚本化结果（'running' = 存活服务进程，null = 进程创建失败） */
function makeExecHarness(
  script: (command: string, index: number) => number | null | 'running',
): { deps: StLifecycleDeps; calls: ExecuteProcessOptions[] } {
  const calls: ExecuteProcessOptions[] = []
  const fn = async (options: ExecuteProcessOptions): Promise<ProcessInfo | null> => {
    calls.push(options)
    const code = script(options.command, calls.length)
    if (code === null) return null
    if (code === 'running') return fakeRunningProcess()
    return fakeProcess(code)
  }
  return { deps: { executeProcessAsync: fn }, calls }
}

/** runGit mock：按参数脚本化结果 */
function makeGitHarness(
  handler: (args: string[]) => (Partial<SyncSpawnResult> & { ok?: boolean }) | undefined,
): { deps: StLifecycleDeps; calls: string[][] } {
  const calls: string[][] = []
  const runGit = vi.fn(async (args: string[]): Promise<SyncSpawnResult & { ok: boolean }> => {
    calls.push(args)
    const result = handler(args) ?? {}
    const exitCode = result.exitCode ?? (result.ok === false ? 1 : 0)
    return {
      exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ok: result.ok ?? exitCode === 0,
    }
  })
  return { deps: { runGit }, calls }
}

/** ST 已安装骨架（可选 node_modules） */
function setupSt(options: { nodeModules?: boolean } = {}): string {
  const stDir = join(root, 'SillyTavern')
  mkdirSync(stDir, { recursive: true })
  writeFileSync(join(stDir, 'package.json'), '{"name":"sillytavern"}', 'utf8')
  writeFileSync(join(stDir, 'server.js'), '// st', 'utf8')
  if (options.nodeModules) mkdirSync(join(stDir, 'node_modules'), { recursive: true })
  return stDir
}

function makeLifecycle(
  parts: { config?: ConfigStore; deps?: StLifecycleDeps; portable?: boolean } = {},
): StLifecycle {
  const config = parts.config ?? makeConfig()
  const deps: StLifecycleDeps = {
    getActiveProcessesCount: () => 0,
    stopAllProcesses: vi.fn(async () => true),
    // 测试基建：默认关闭启动探针（fake 进程多为「已退出」模型，探针语义另有专测）；
    // 0 = 跳过探针，保持既有用例的 spawn 即成语义
    startProbeMs: 0,
    ...(parts.deps ?? {}),
  }
  if (parts.portable) {
    config.set('env_mode', 'portable')
    const envRoot = join(root, 'env')
    mkdirSync(join(envRoot, 'cmd'), { recursive: true })
    for (const file of [
      join(envRoot, 'cmd', 'git.exe'),
      join(envRoot, 'node.exe'),
      join(envRoot, 'npm.cmd'),
    ]) {
      writeFileSync(file, '', 'utf8')
    }
    deps.portableEnv = (dir) => ({
      baseDir: dir ?? envRoot,
      gitDir: join(dir ?? envRoot, 'cmd'),
      gitExe: join(dir ?? envRoot, 'cmd', 'git.exe'),
      nodeExe: join(dir ?? envRoot, 'node.exe'),
      npmCmd: join(dir ?? envRoot, 'npm.cmd'),
      stDir: join(dirname(dir ?? envRoot), 'SillyTavern'),
    })
    deps.whichFn = () => null
  } else {
    deps.whichFn = deps.whichFn ?? ((binary) => WHICH_MAP[binary] ?? null)
  }
  return new StLifecycle({
    baseDir: root,
    onLog: (message) => logs.push(message),
    deps: { ...deps, configStore: config },
  })
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('validatePathForNpm（← validate_path_for_npm 1:1）', () => {
  it('ASCII 纯英文路径通过', () => {
    const result = validatePathForNpm('E:\\WorkProject\\launcher')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('路径验证通过')
  })

  it('中文字符拒绝（含错误信息与建议）', () => {
    const result = validatePathForNpm('E:\\工作目录\\launcher')
    expect(result.ok).toBe(false)
    expect(result.message).toContain("中文字符 '工'")
    expect(result.message).toContain('建议：请将程序移动到纯英文路径下')
  })

  it('空格/日文/韩文/特殊符号拒绝', () => {
    expect(validatePathForNpm('C:\\My Folder').ok).toBe(false) // 空格
    expect(validatePathForNpm('C:\\プロジェクト').ok).toBe(false) // 日文
    expect(validatePathForNpm('C:\\프로젝트').ok).toBe(false) // 韩文
    expect(validatePathForNpm('C:\\a(b)c').ok).toBe(false) // 特殊符号
    expect(validatePathForNpm('C:\\a!b').ok).toBe(false)
  })

  it("连字符 '-' 在 Python 集合内同样拒绝（1:1 保留）", () => {
    expect(validatePathForNpm('C:\\my-dir').ok).toBe(false)
  })

  it('非 ASCII 非 CJK 字符拒绝（ascii 编码检查）', () => {
    expect(validatePathForNpm('C:\\café').ok).toBe(false)
  })

  it('警告类不阻断：长路径/UNC/异常盘符（ok 仍为 true）', () => {
    expect(validatePathForNpm('C:\\' + 'a'.repeat(300)).ok).toBe(true)
    expect(validatePathForNpm('C:\\' + 'a'.repeat(300)).message).toContain('路径长度过长')
    expect(validatePathForNpm('\\\\server\\share').ok).toBe(true)
    expect(validatePathForNpm('\\\\server\\share').message).toContain('网络路径')
    expect(validatePathForNpm('C:\\we:ird').ok).toBe(true)
    expect(validatePathForNpm('C:\\we:ird').message).toContain('非常规的驱动器路径')
  })
})

describe('命令构造（纯函数）', () => {
  it('npm install / cache clean / clone / pull', () => {
    expect(buildNpmInstallCommand('C:/fake/npm.cmd')).toBe(
      '"C:/fake/npm.cmd" install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --registry=https://registry.npmmirror.com',
    )
    expect(buildNpmInstallCommandNoOmit('C:/fake/npm.cmd')).toBe(
      '"C:/fake/npm.cmd" install --no-audit --no-fund --loglevel=error --no-progress --registry=https://registry.npmmirror.com',
    )
    expect(buildNpmCacheCleanCommand('C:/fake/npm.cmd')).toBe('"C:/fake/npm.cmd" cache clean --force')
    expect(buildGitCloneCommand('C:/fake/git.exe')).toBe(
      '"C:/fake/git.exe" clone https://github.com/SillyTavern/SillyTavern.git -b release',
    )
    expect(buildGitPullCommand('C:/fake/git.exe')).toBe('"C:/fake/git.exe" pull --rebase --autostash')
  })

  it('start 命令：优化参数与自定义参数拼装', () => {
    expect(buildStStartCommand({ nodeExe: 'C:/fake/node.exe' })).toBe('"C:/fake/node.exe" server.js')
    expect(buildStStartCommand({ nodeExe: 'C:/fake/node.exe', useOptimizeArgs: true })).toBe(
      '"C:/fake/node.exe" server.js --max-old-space-size=4096',
    )
    expect(
      buildStStartCommand({
        nodeExe: 'C:/fake/node.exe',
        useOptimizeArgs: true,
        customArgs: '--port 8000 --ssl false',
      }),
    ).toBe('"C:/fake/node.exe" server.js --max-old-space-size=4096 --port 8000 --ssl false')
  })

  it('start 命令 embedded：D7 跳过 --max-old-space-size（Bun/JSC 不识别 V8 旗标）', () => {
    expect(
      buildStStartCommand({ nodeExe: 'C:/fake/launcher.exe', useOptimizeArgs: true, embedded: true }),
    ).toBe('"C:/fake/launcher.exe" server.js')
    expect(
      buildStStartCommand({
        nodeExe: 'C:/fake/launcher.exe',
        useOptimizeArgs: true,
        embedded: true,
        customArgs: '--port 8000',
      }),
    ).toBe('"C:/fake/launcher.exe" server.js --port 8000')
  })

  it('bun install / install --force（Phase 3 设计计划 §7，F8 旗标）', () => {
    // 主安装：--production 对齐 --omit=dev 意图；registry 值与 npm 链路同源
    expect(buildBunInstallCommand('C:/fake/launcher.exe')).toBe(
      '"C:/fake/launcher.exe" install --production --registry=https://registry.npmmirror.com',
    )
    // 重试链首步：bun 无 cache clean 等价，忽略缓存强制重装
    expect(buildBunInstallForceCommand('C:/fake/launcher.exe')).toBe(
      '"C:/fake/launcher.exe" install --force',
    )
  })
})

// ---------------------------------------------------------------------------
// 进程输出接入终端日志 + auto_proxy（Bug#1 / Bug#5）
// ---------------------------------------------------------------------------

describe('executeCommand 进程输出回调', () => {
  it('executeCommand 向 processManager 传递 onLine/onEvent，输出进入终端日志', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({ deps: harness.deps })
    await lifecycle.startSt()

    const options = harness.calls[0]
    expect(typeof options?.onLine).toBe('function')
    expect(typeof options?.onEvent).toBe('function')
    options?.onLine?.({ stream: 'stdout', text: 'server listening on port 8000' })
    options?.onLine?.({ stream: 'stderr', text: 'warn: legacy flag' })
    options?.onEvent?.('E:/st $ git clone ...')
    expect(logs).toContain('server listening on port 8000')
    expect(logs).toContain('warn: legacy flag')
    expect(logs).toContain('E:/st $ git clone ...')
  })
})

describe('autoDetectProxy（auto_proxy 开启时）', () => {
  beforeEach(() => {
    stConfigMock.instance = null
  })

  afterEach(() => {
    delete process.env.HTTPS_PROXY
    delete process.env.HTTP_PROXY
    delete process.env.ALL_PROXY
  })

  it('deps.stConfig 未注入 → 懒默认全局单例（不再静默失效）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const config = makeConfig({ auto_proxy: true })
    const lifecycle = makeLifecycle({ config, deps: harness.deps })
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'

    await lifecycle.startSt()

    expect(stConfigMock.instance?.proxyEnabled).toBe(true)
    expect(stConfigMock.instance?.proxyUrl).toBe('http://127.0.0.1:7890')
    expect(logs.some((message) => message.includes('自动设置代理: http://127.0.0.1:7890'))).toBe(true)
  })

  it('无代理环境变量且注册表无代理 → 关闭代理并记录日志', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const config = makeConfig({ auto_proxy: true })
    // 注册表读取注入为空，隔离真实系统代理状态
    const lifecycle = makeLifecycle({ config, deps: { ...harness.deps, readRegistryProxy: () => '' } })

    await lifecycle.startSt()

    expect(stConfigMock.instance?.proxyEnabled).toBe(false)
    expect(logs.some((message) => message.includes('未检测到有效的系统代理'))).toBe(true)
  })

  it('无环境变量 → 回退注册表系统代理（← getproxies_registry）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const config = makeConfig({ auto_proxy: true })
    const lifecycle = makeLifecycle({
      config,
      deps: { ...harness.deps, readRegistryProxy: () => 'http://10.0.0.2:8888' },
    })

    await lifecycle.startSt()

    expect(stConfigMock.instance?.proxyEnabled).toBe(true)
    expect(stConfigMock.instance?.proxyUrl).toBe('http://10.0.0.2:8888')
    expect(logs.some((message) => message.includes('自动设置代理: http://10.0.0.2:8888'))).toBe(true)
  })
})

describe('normalizeProxyServer / readWindowsRegistryProxy（← getproxies_registry）', () => {
  it('裸 host:port 补 http:// 前缀', () => {
    expect(normalizeProxyServer('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('分协议串优先 https 段，次选 http 段', () => {
    expect(normalizeProxyServer('http=127.0.0.1:80;https=127.0.0.1:443')).toBe('http://127.0.0.1:443')
    expect(normalizeProxyServer('http=127.0.0.1:80')).toBe('http://127.0.0.1:80')
  })

  it('无 http/https 段或空值返回空串', () => {
    expect(normalizeProxyServer('socks=127.0.0.1:1080')).toBe('')
    expect(normalizeProxyServer('   ')).toBe('')
  })

  it('已带 scheme 不重复补前缀', () => {
    expect(normalizeProxyServer('http://proxy.local:8080')).toBe('http://proxy.local:8080')
  })

  it.skipIf(process.platform !== 'win32')('reg 输出解析：ProxyEnable=0x1 + ProxyServer 生效', () => {
    const query = vi.fn((args: string[]) =>
      args.includes('ProxyEnable')
        ? { exitCode: 0, stdout: 'HKEY_CURRENT_USER\\Internet Settings\n    ProxyEnable    REG_DWORD    0x1\n' }
        : { exitCode: 0, stdout: '    ProxyServer    REG_SZ    127.0.0.1:7890\n' },
    )
    expect(readWindowsRegistryProxy(query)).toBe('http://127.0.0.1:7890')
  })

  it.skipIf(process.platform !== 'win32')(
    'reg 输出解析：ProxyEnable=0x0 / 查询失败 / 值缺失均按无代理',
    () => {
      expect(
        readWindowsRegistryProxy(() => ({ exitCode: 0, stdout: '    ProxyEnable    REG_DWORD    0x0\n' })),
      ).toBe('')
      expect(readWindowsRegistryProxy(() => ({ exitCode: 1, stdout: '' }))).toBe('')
      expect(
        readWindowsRegistryProxy((args: string[]) =>
          args.includes('ProxyEnable')
            ? { exitCode: 0, stdout: '    ProxyEnable    REG_DWORD    0x1\n' }
            : { exitCode: 0, stdout: '    ProxyServer    REG_SZ    \n' },
        ),
      ).toBe('')
    },
  )
})

// ---------------------------------------------------------------------------
// installSt
// ---------------------------------------------------------------------------

describe('installSt（← install_sillytavern）', () => {
  it('clone 失败 + 空 SillyTavern 目录（仅 .git）→ 自动清理', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(join(stDir, '.git'), { recursive: true })
    const harness = makeExecHarness(() => 128)
    const lifecycle = makeLifecycle({ deps: harness.deps })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('git clone进程返回错误码: 128')
    expect(existsSync(stDir)).toBe(false)
    expect(logs.some((message) => message.includes('已自动清理失败的安装目录'))).toBe(true)
  })

  it('clone 失败 + 目录有真实文件 → 不清理', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, 'package.json'), '{}', 'utf8')
    const harness = makeExecHarness(() => 1)
    const lifecycle = makeLifecycle({ deps: harness.deps })

    await lifecycle.installSt()
    expect(existsSync(stDir)).toBe(true)
  })

  it('clone 成功 → npm install（确切参数）+ 记录下载行为', async () => {
    // ST 未安装 → 走 clone 分支（setupSt 会把 ST 标记为已安装而跳过 clone）
    const harness = makeExecHarness(() => 0)
    const config = makeConfig()
    const lifecycle = makeLifecycle({ config, deps: harness.deps })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(true)
    const commands = harness.calls.map((call) => call.command)
    expect(commands[0]).toBe(buildGitCloneCommand('C:/fake/git.exe'))
    expect(commands[1]).toBe(buildNpmInstallCommand('C:/fake/npm.cmd'))
    expect(harness.calls[1]?.cwd).toBe(join(root, 'SillyTavern'))
    const downloads = config.get<Array<{ action: string }>>('downloads', [])
    expect(downloads.at(-1)?.action).toBe('clone')
  })

  it('ST 已安装且依赖齐备 → 不再执行任何命令', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({ deps: harness.deps })
    const result = await lifecycle.installSt()
    expect(result.ok).toBe(true)
    expect(harness.calls.length).toBe(0)
    expect(logs.some((message) => message.includes('SillyTavern已安装'))).toBe(true)
  })

  it('无 git → Error: Git路径未正确配置', async () => {
    const lifecycle = new StLifecycle({
      baseDir: root,
      deps: { configStore: makeConfig(), whichFn: () => null },
      onLog: (message) => logs.push(message),
    })
    const result = await lifecycle.installSt()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Error: Git路径未正确配置')
  })
})

// ---------------------------------------------------------------------------
// startSt / stopSt / restartSt
// ---------------------------------------------------------------------------

describe('startSt（← start_sillytavern）', () => {
  it('正常启动：命令构造 + cwd + env（NODE_ENV/FORCE_COLOR）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({ deps: harness.deps })

    const result = await lifecycle.startSt()
    expect(result.ok).toBe(true)
    expect(result.proc).not.toBeNull()
    expect(harness.calls.length).toBe(1)
    expect(harness.calls[0]?.command).toBe('"C:/fake/node.exe" server.js')
    expect(harness.calls[0]?.cwd).toBe(join(root, 'SillyTavern'))
    const env = harness.calls[0]?.env as Record<string, string>
    expect(env.NODE_ENV).toBe('production')
    expect(env.FORCE_COLOR).toBe('1')
  })

  it('优化参数与自定义参数（校验通过时拼接）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ use_optimize_args: true, custom_args: '--port 8000' }),
      deps: harness.deps,
    })
    await lifecycle.startSt()
    expect(harness.calls[0]?.command).toBe(
      '"C:/fake/node.exe" server.js --max-old-space-size=4096 --port 8000',
    )
  })

  it('不安全的自定义参数被忽略（← validate_custom_args 防御）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ custom_args: '--safe; rm -rf /' }),
      deps: harness.deps,
    })
    await lifecycle.startSt()
    expect(harness.calls[0]?.command).toBe('"C:/fake/node.exe" server.js')
    expect(logs.some((message) => message.includes('自定义启动参数不安全，已忽略'))).toBe(true)
  })

  it('已在运行 → 拒绝启动；未安装/缺依赖 → 拒绝', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const running = makeLifecycle({
      deps: { ...harness.deps, hasStServerProcess: () => true },
    })
    expect((await running.startSt()).message).toBe('SillyTavern已经在运行中')
    expect(harness.calls.length).toBe(0)

    const notInstalled = makeLifecycle({ deps: harness.deps })
    rmSync(join(root, 'SillyTavern'), { recursive: true, force: true })
    expect((await notInstalled.startSt()).message).toContain('SillyTavern未安装')

    setupSt() // 无 node_modules
    const noDeps = makeLifecycle({ deps: harness.deps })
    expect((await noDeps.startSt()).message).toContain('依赖未安装')
    expect(harness.calls.length).toBe(0)
  })

  it('便携模式 env：PATH 前置 env 与 env/cmd', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({ portable: true, deps: harness.deps })
    await lifecycle.startSt()
    expect(harness.calls[0]?.command).toBe(`"${join(root, 'env', 'node.exe')}" server.js`)
    const env = harness.calls[0]?.env as Record<string, string>
    expect(env.PATH.startsWith(join(root, 'env'))).toBe(true)
    expect(env.PATH).toContain(join(root, 'env', 'cmd'))
  })
})

// ---------------------------------------------------------------------------
// 2026-09-21 真机三收口：安装互斥 / 安装退出码 / 启动成功探针
// ---------------------------------------------------------------------------

describe('安装-启动互斥与启动探针（2026-09-21 真机竞态修复）', () => {
  it('startSt：依赖安装进行中 → 拒绝启动（不 spawn，提示等待安装完成）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      deps: { ...harness.deps, hasInstallProcess: () => true },
    })

    const result = await lifecycle.startSt()
    expect(result.ok).toBe(false)
    expect(result.proc).toBeNull()
    expect(result.message).toContain('依赖安装进行中')
    expect(harness.calls.length).toBe(0)
  })

  it('restartSt：依赖安装进行中 → 先拦（不 stopAllProcesses 误杀安装进程）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const stop = vi.fn(async () => true)
    const lifecycle = makeLifecycle({
      deps: { ...harness.deps, hasInstallProcess: () => true, stopAllProcesses: stop },
    })

    const result = await lifecycle.restartSt()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('依赖安装进行中')
    expect(stop).not.toHaveBeenCalled()
    expect(harness.calls.length).toBe(0)
  })

  it('startSt：探针窗口内进程秒退 → 启动失败（不误报「✓ 启动成功」）', async () => {
    setupSt({ nodeModules: true })
    // 缺包秒崩复现：spawn 后 10ms 以退出码 1 死亡（bun 实测缺包退出码 = 1）
    const calls: ExecuteProcessOptions[] = []
    const deps: StLifecycleDeps = {
      startProbeMs: 200,
      executeProcessAsync: async (options) => {
        calls.push(options)
        return fakeDelayedExitProcess(1, 10)
      },
    }
    const lifecycle = makeLifecycle({ deps })

    const result = await lifecycle.startSt()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('启动失败')
    expect(result.message).toContain('退出码 1')
    expect(logs.some((message) => message.includes('SillyTavern启动失败'))).toBe(true)
    expect(logs.some((message) => message.includes('✓ SillyTavern启动成功'))).toBe(false)
    expect(calls[0]?.kind).toBe('st-server')
  })

  it('startSt：进程存活过探针窗口 → 成功；晚退给出归因日志', async () => {
    setupSt({ nodeModules: true })
    const deps: StLifecycleDeps = {
      startProbeMs: 30,
      executeProcessAsync: async () => fakeRunningProcess(),
    }
    const lifecycle = makeLifecycle({ deps })

    const result = await lifecycle.startSt()
    expect(result.ok).toBe(true)
    expect(result.message).toBe('✓ SillyTavern启动成功')
  })

  it('restartSt：探针窗口内秒退 → 重启失败（同一收口口径）', async () => {
    setupSt({ nodeModules: true })
    const deps: StLifecycleDeps = {
      startProbeMs: 200,
      executeProcessAsync: async () => fakeDelayedExitProcess(1, 10),
    }
    const lifecycle = makeLifecycle({ deps })

    const result = await lifecycle.restartSt()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('重启失败')
    expect(logs.some((message) => message.includes('SillyTavern已重启'))).toBe(false)
  })
})

describe('安装退出码与「未完成」标记（2026-09-21 真机修复）', () => {
  it('installSt（已安装缺依赖）：安装失败退出码非 0 → 不报完成 + 标记保留（启动被拒）', async () => {
    const stDir = setupSt() // 无 node_modules
    // 真实 bun/npm 安装会先建出 node_modules 再失败——fake 同步建模（标记落盘前置）
    const harness = makeExecHarness((command) => {
      if (command.includes('install')) {
        mkdirSync(join(stDir, 'node_modules'), { recursive: true })
        return 1
      }
      return 0
    })
    const lifecycle = makeLifecycle({ deps: harness.deps })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('依赖安装失败')
    expect(result.message).toContain('退出码 1')
    // 半成品树：未完成标记必须保留 → checkNodeModules 拒绝
    expect(existsSync(depsPendingMarkerPath(stDir))).toBe(true)
    expect(checkNodeModules(stDir)).toBe(false)
    // 后续启动被依赖检查拦下（不会带着残树崩）
    const startResult = await lifecycle.startSt()
    expect(startResult.ok).toBe(false)
    expect(startResult.message).toContain('依赖未安装')
  })

  it('installSt（已安装缺依赖）：安装成功 → 标记清除、依赖检查恢复', async () => {
    const stDir = setupSt() // 无 node_modules
    // 安装成功建模：真实安装会建出 node_modules 后退出码 0
    const harness = makeExecHarness((command) => {
      if (command.includes('install')) {
        mkdirSync(join(stDir, 'node_modules'), { recursive: true })
        return 0
      }
      return 0
    })
    const lifecycle = makeLifecycle({ deps: harness.deps })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(true)
    expect(result.message).toBe('依赖安装完成')
    expect(existsSync(depsPendingMarkerPath(stDir))).toBe(false)
    expect(checkNodeModules(stDir)).toBe(true)
    // 安装进程挂 kind='st-install'（互斥守卫依据）
    expect(harness.calls[0]?.kind).toBe('st-install')
  })

  it('installSt（全新安装）：clone 成功但依赖安装失败 → 如实回报失败并保留标记', async () => {
    const stDir = join(root, 'SillyTavern')
    // clone 成功、install 失败；install 先建出 node_modules（真实安装形态）
    const harness = makeExecHarness((_command, index) => {
      if (index === 1) return 0
      mkdirSync(join(stDir, 'node_modules'), { recursive: true })
      return 1
    })
    const lifecycle = makeLifecycle({ deps: harness.deps })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('依赖安装失败')
    expect(existsSync(depsPendingMarkerPath(stDir))).toBe(true)
  })

  it('installNpmDependencies：退出码非 0 → 不报「✓ 安装完成」', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 3)
    const lifecycle = makeLifecycle({ deps: harness.deps })

    const result = await lifecycle.installNpmDependencies()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('退出码 3')
    expect(logs.some((message) => message.includes('✓ npm依赖安装完成'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// embedded 模式（设计计划 §6/D2/D7，Phase 2）
// ---------------------------------------------------------------------------

/** embedded 可执行文件假路径（注入隔离 vitest 宿主的真实 node.exe） */
const EMBEDDED_EXE = 'C:/fake/launcher.exe'

/** embedded deps 束：execPath 注入 + 启动前校验恒通过（真实实现另有单测） */
function embeddedDeps(base: StLifecycleDeps): StLifecycleDeps {
  return {
    ...base,
    whichFn: () => null,
    embeddedExecPath: () => EMBEDDED_EXE,
    ensureEmbeddedRuntime: async () => ({ ok: true, message: '内置运行时就绪' }),
  }
}

describe('embedded 模式（设计计划 §6/D2/D7）', () => {
  beforeEach(() => {
    // env 断言与宿主环境解耦（继承语义会把宿主的 NODE_EXTRA_CA_CERTS 带进子进程）
    delete process.env.NODE_EXTRA_CA_CERTS
  })

  it('resolveToolchain 三态字段：embedded 派生 execPath 无 Git；portable/system 恒 embedded:false', () => {
    // embedded：node/npm 均派生 execPath，gitExe/gitDir 为 null（Git 层 Phase 4 走 isoGit）
    expect(
      resolveToolchain(makeConfig({ env_mode: 'embedded' }), { embeddedExecPath: () => EMBEDDED_EXE }),
    ).toEqual({
      gitExe: null,
      nodeExe: EMBEDDED_EXE,
      npmExe: EMBEDDED_EXE,
      gitDir: null,
      portable: false,
      embedded: true,
    })

    // system（D3 零回归）：字段语义不变，embedded 恒 false
    const sys = resolveToolchain(makeConfig(), { whichFn: (b) => WHICH_MAP[b] ?? null })
    expect(sys.embedded).toBe(false)
    expect(sys.portable).toBe(false)
    expect(sys.nodeExe).toBe('C:/fake/node.exe')

    // portable（D3 零回归）
    const envRoot = join(root, 'env')
    mkdirSync(join(envRoot, 'cmd'), { recursive: true })
    for (const file of [
      join(envRoot, 'cmd', 'git.exe'),
      join(envRoot, 'node.exe'),
      join(envRoot, 'npm.cmd'),
    ]) {
      writeFileSync(file, '', 'utf8')
    }
    const portable = resolveToolchain(
      makeConfig({ env_mode: 'portable' }),
      {
        whichFn: () => null,
        portableEnv: (dir) => ({
          baseDir: dir ?? envRoot,
          gitDir: join(dir ?? envRoot, 'cmd'),
          gitExe: join(dir ?? envRoot, 'cmd', 'git.exe'),
          nodeExe: join(dir ?? envRoot, 'node.exe'),
          npmCmd: join(dir ?? envRoot, 'npm.cmd'),
          stDir: join(root, 'SillyTavern'),
        }),
      },
    )
    expect(portable.embedded).toBe(false)
    expect(portable.portable).toBe(true)
    expect(portable.nodeExe).toBe(join(envRoot, 'node.exe'))
  })

  it('startSt embedded：命令 = 引号 execPath + server.js，env 有 BUN_BE_BUN 且无 PATH 前置', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: embeddedDeps(harness.deps),
    })

    const result = await lifecycle.startSt()
    expect(result.ok).toBe(true)
    expect(harness.calls[0]?.command).toBe(`"${EMBEDDED_EXE}" server.js`)
    expect(harness.calls[0]?.cwd).toBe(join(root, 'SillyTavern'))
    const env = harness.calls[0]?.env as Record<string, string>
    expect(env.BUN_BE_BUN).toBe('1')
    expect(env.NODE_ENV).toBe('production')
    expect(env.FORCE_COLOR).toBe('1')
    // embedded 不做 PATH 前置：保持宿主原值（临时目录无 cache 文件 → 不注入 CA）
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })

  it('startSt embedded：校验通过的 customArgs 透传', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded', custom_args: '--port 8000 --ssl false' }),
      deps: embeddedDeps(harness.deps),
    })
    await lifecycle.startSt()
    expect(harness.calls[0]?.command).toBe(`"${EMBEDDED_EXE}" server.js --port 8000 --ssl false`)
  })

  it('D7：use_optimize_args 在 embedded 下被跳过且产出终端可见日志行', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded', use_optimize_args: true }),
      deps: embeddedDeps(harness.deps),
    })
    await lifecycle.startSt()
    expect(harness.calls[0]?.command).toBe(`"${EMBEDDED_EXE}" server.js`)
    expect(logs).toContain('内置运行时（Bun）不支持 --max-old-space-size，已忽略')
  })

  it('D7：use_optimize_args 关闭时 embedded 不打忽略日志（无噪声）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded', use_optimize_args: false }),
      deps: embeddedDeps(harness.deps),
    })
    await lifecycle.startSt()
    expect(harness.calls[0]?.command).toBe(`"${EMBEDDED_EXE}" server.js`)
    expect(logs.some((message) => message.includes('--max-old-space-size'))).toBe(false)
  })

  it('启动前校验失败（execPath 不存在）→ 走现有创建失败反馈路径，不 spawn', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: {
        ...harness.deps,
        whichFn: () => null,
        embeddedExecPath: () => 'C:/missing/launcher.exe',
        ensureEmbeddedRuntime: async () => ({
          ok: false,
          message: '启动器内置运行时可执行文件不存在: C:/missing/launcher.exe',
        }),
      },
    })
    const result = await lifecycle.startSt()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('创建进程失败')
    expect(harness.calls.length).toBe(0)
    expect(logs.some((message) => message.includes('启动器内置运行时可执行文件不存在'))).toBe(true)
  })

  it('restartSt embedded：命令形态 + D7 跳过同样生效', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded', use_optimize_args: true }),
      deps: embeddedDeps(harness.deps),
    })
    const result = await lifecycle.restartSt()
    expect(result.ok).toBe(true)
    expect(harness.calls[0]?.command).toBe(`"${EMBEDDED_EXE}" server.js`)
    expect(logs).toContain('内置运行时（Bun）不支持 --max-old-space-size，已忽略')
  })

  it('D3 焊死：portable/system 命令串与 env 组装与现状逐字节一致（embedded 为唯一新形态）', async () => {
    setupSt({ nodeModules: true })

    // system（现状）
    const sysHarness = makeExecHarness(() => 0)
    await makeLifecycle({ deps: sysHarness.deps }).startSt()
    expect(sysHarness.calls[0]?.command).toBe('"C:/fake/node.exe" server.js')
    const sysEnv = sysHarness.calls[0]?.env as Record<string, string>
    expect(sysEnv.BUN_BE_BUN).toBeUndefined()
    expect(sysEnv.PATH).toBe(process.env.PATH) // system 不前置 PATH（现状）

    // portable（现状）：PATH 前置 env 目录，无 BUN_BE_BUN
    const portHarness = makeExecHarness(() => 0)
    await makeLifecycle({ portable: true, deps: portHarness.deps }).startSt()
    expect(portHarness.calls[0]?.command).toBe(`"${join(root, 'env', 'node.exe')}" server.js`)
    const portEnv = portHarness.calls[0]?.env as Record<string, string>
    expect(portEnv.BUN_BE_BUN).toBeUndefined()
    expect(portEnv.PATH.startsWith(join(root, 'env'))).toBe(true)

    // portable 优化参数命令串（现状，D7 仅对 embedded 生效）
    const optHarness = makeExecHarness(() => 0)
    await makeLifecycle({
      portable: true,
      config: makeConfig({ use_optimize_args: true }),
      deps: optHarness.deps,
    }).startSt()
    expect(optHarness.calls[0]?.command).toBe(
      `"${join(root, 'env', 'node.exe')}" server.js --max-old-space-size=4096`,
    )
  })
})

// ---------------------------------------------------------------------------
// Phase 3 · embedded 依赖安装（设计计划 §7：三调用点路由 + 重试链 + bun.lock 消解）
// ---------------------------------------------------------------------------

/** embedded deps 束 + bun.lock 消解注入（默认成功；个别用例覆盖失败路径） */
function embeddedInstallDeps(
  base: StLifecycleDeps,
  bunLock: (stDir: string) => Promise<boolean> = async () => true,
): StLifecycleDeps {
  return { ...embeddedDeps(base), ensureBunLockExcluded: vi.fn(bunLock) }
}

/** embedded Toolchain 全量对象（私有重试链直测用） */
const EMBEDDED_TOOLS: Toolchain = {
  gitExe: null,
  nodeExe: EMBEDDED_EXE,
  npmExe: EMBEDDED_EXE,
  gitDir: null,
  portable: false,
  embedded: true,
}

describe('Phase 3 · embedded 依赖安装路由（设计计划 §7）', () => {
  it('installSt（已安装缺依赖）：embedded → bun install 命令 + bun.lock 消解前置挂接', async () => {
    setupSt() // 无 node_modules → 走依赖安装路径
    const harness = makeExecHarness(() => 0)
    const bunLock = vi.fn(async () => true)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: embeddedInstallDeps(harness.deps, bunLock),
    })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(true)
    expect(harness.calls.length).toBe(1)
    expect(harness.calls[0]?.command).toBe(buildBunInstallCommand(EMBEDDED_EXE))
    expect(harness.calls[0]?.cwd).toBe(join(root, 'SillyTavern'))
    expect(bunLock).toHaveBeenCalledWith(join(root, 'SillyTavern'))
    // 非 embedded 专属命令串全程不出现
    expect(harness.calls.some((call) => call.command.includes('--no-audit'))).toBe(false)
  })

  it('installNpmDependencies：embedded → bun install（§7 单命令设计）+ 消解前置', async () => {
    setupSt()
    const harness = makeExecHarness(() => 0)
    const bunLock = vi.fn(async () => true)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: embeddedInstallDeps(harness.deps, bunLock),
    })

    const result = await lifecycle.installNpmDependencies()
    expect(result.ok).toBe(true)
    expect(harness.calls[0]?.command).toBe(buildBunInstallCommand(EMBEDDED_EXE))
    expect(bunLock).toHaveBeenCalledWith(join(root, 'SillyTavern'))
  })

  it('updateSt embedded（Phase 4）：git 门禁打通 → IsoGitOps 路由，无 spawn git 命令', async () => {
    setupSt()
    const harness = makeExecHarness(() => 0)
    const bunLock = vi.fn(async () => true)
    const pullFastForward = vi.fn(async () => ({ ok: true, message: 'Git更新成功', exitCode: 0 }))
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: {
        ...embeddedInstallDeps(harness.deps, bunLock),
        cleanupGitState: vi.fn(async () => ({ ok: true, message: '不应被调用' })),
        createRepoOps: () =>
          ({
            cloneRelease: vi.fn(),
            fetchOrigin: vi.fn(),
            pullFastForward,
            checkoutTag: vi.fn(),
            statusPorcelain: vi.fn(),
            listTags: vi.fn(),
            currentCommit: vi.fn(),
            setRemote: vi.fn(),
          }) as unknown as StRepoOps,
      },
    })

    const result = await lifecycle.updateSt()
    expect(result.ok).toBe(true)
    expect(pullFastForward).toHaveBeenCalledWith(join(root, 'SillyTavern'))
    // embedded 旁路 cleanup / detached / remote 前置检查（pullFastForward 内部兜底）
    expect(lifecycle['deps'].cleanupGitState).not.toHaveBeenCalled()
    expect(
      harness.calls.some((call) => call.command.includes('git') || call.command.includes('rev-parse')),
    ).toBe(false)
    // pull 成功 → 进入 bun install 链（Phase 3 语义保持）
    expect(harness.calls.some((call) => call.command === buildBunInstallCommand(EMBEDDED_EXE))).toBe(true)
    expect(logs.some((message) => message.includes('跳过Git状态清理与detached HEAD检查'))).toBe(true)
  })

  it('updateSt embedded：pullFastForward 网络失败 → 重试 ≤2 后失败（无 package-lock 恢复链）', async () => {
    setupSt()
    const harness = makeExecHarness(() => 0)
    const pullFastForward = vi.fn(async () => ({
      ok: false,
      message: 'network down',
      exitCode: 1,
    }))
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: {
        ...embeddedInstallDeps(harness.deps),
        runGit: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', ok: true })),
        createRepoOps: () =>
          ({
            pullFastForward,
          }) as unknown as StRepoOps,
      },
    })

    const result = await lifecycle.updateSt()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('重试更新失败')
    expect(pullFastForward).toHaveBeenCalledTimes(3) // 1 初始 + 2 重试
    // embedded 重试不触发 package-lock 恢复链（runGit 不被调用）
    expect(lifecycle['deps'].runGit).not.toHaveBeenCalled()
    expect(logs.some((message) => message.includes('Git更新失败，正在重试... (尝试次数: 1/2)'))).toBe(true)
  })

  it('runNpmInstallWithRetry embedded：重试首步 = install --force（非 cache clean），node_modules 删除链保留', async () => {
    const stDir = setupSt({ nodeModules: true })
    let installCount = 0
    const nodeModulesSeenAtForce: boolean[] = []
    const harness = makeExecHarness((command) => {
      if (command.includes('install --force')) {
        // force 步骤先于 node_modules 删除执行：记录当时目录是否存在
        nodeModulesSeenAtForce.push(existsSync(join(stDir, 'node_modules')))
        return 0
      }
      if (command.includes('install --production')) {
        installCount += 1
        if (installCount <= 2) return 1
        mkdirSync(join(stDir, 'node_modules'), { recursive: true }) // 第三次成功重建
        return 0
      }
      return 0
    })
    const bunLock = vi.fn(async () => true)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: embeddedInstallDeps(harness.deps, bunLock),
    })

    // updateSt 的 git 层经 StRepoOps 路由（Phase 4）——此处仍以注入的 Toolchain
    // 直测私有重试链的 embedded 分支（安装链单测与 git 链单测解耦）
    const carrier = lifecycle as unknown as {
      runNpmInstallWithRetry: (tools: Toolchain, withAutoStart: boolean) => Promise<{ ok: boolean }>
    }
    const result = await carrier.runNpmInstallWithRetry(EMBEDDED_TOOLS, true)

    expect(result.ok).toBe(true)
    expect(installCount).toBe(3) // 1 次初始 + 2 次重试
    const commands = harness.calls.map((call) => call.command)
    expect(commands.filter((command) => command.includes('install --force')).length).toBe(2)
    // 全程无任何 npm 命令串（cache clean / --no-audit 均不得出现）
    expect(commands.some((command) => command.includes('cache clean'))).toBe(false)
    expect(commands.some((command) => command.includes('--no-audit'))).toBe(false)
    // node_modules 删除重试链保留：首次 force 时目录在，删除后第二次 force 时已不在
    expect(nodeModulesSeenAtForce).toEqual([true, false])
    expect(existsSync(join(stDir, 'node_modules'))).toBe(true)
    // 每次主安装前都幂等消解 bun.lock（重试链内复挂，幂等开销可忽略）
    expect(bunLock.mock.calls.length).toBe(3)
  })

  it('runNpmInstallWithRetry portable/system（D3 焊死）：命令串与重试链逐字节不变', async () => {
    const stDir = setupSt({ nodeModules: true })
    let npmInstallCount = 0
    const harness = makeExecHarness((command) => {
      if (command.includes('cache clean')) return 0
      if (command.includes('install --no-audit')) {
        npmInstallCount += 1
        if (npmInstallCount <= 2) return 1
        mkdirSync(join(stDir, 'node_modules'), { recursive: true })
        return 0
      }
      return 0
    })
    const lifecycle = makeLifecycle({ deps: harness.deps }) // system 模式（默认）

    const carrier = lifecycle as unknown as {
      runNpmInstallWithRetry: (
        tools: { npmExe: string | null; embedded: boolean },
        withAutoStart: boolean,
      ) => Promise<{ ok: boolean }>
    }
    const result = await carrier.runNpmInstallWithRetry(
      { npmExe: 'C:/fake/npm.cmd', embedded: false },
      true,
    )

    expect(result.ok).toBe(true)
    const commands = harness.calls.map((call) => call.command)
    // 主安装 = 原 npm 串逐字节；重试首步 = cache clean（非 bun force）
    expect(commands[0]).toBe(buildNpmInstallCommand('C:/fake/npm.cmd'))
    expect(commands.filter((command) => command.includes('cache clean --force')).length).toBe(2)
    expect(commands.some((command) => command.includes('install --force'))).toBe(false)
    expect(commands.some((command) => command.includes('--production'))).toBe(false)
  })

  it('bun.lock 消解失败 → 仅终端警告，安装不阻断（D6 失败自愈语义）', async () => {
    setupSt()
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: embeddedInstallDeps(harness.deps, async () => false),
    })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(true)
    expect(harness.calls[0]?.command).toBe(buildBunInstallCommand(EMBEDDED_EXE))
    expect(logs.some((message) => message.includes('bun.lock Git排除规则写入失败'))).toBe(true)
  })

  it('D3 焊死：portable/system 安装全程不触发 bun.lock 消解，命令串逐字节不变', async () => {
    // system · installSt（已安装缺依赖）
    setupSt()
    const sysHarness = makeExecHarness(() => 0)
    const sysLock = vi.fn(async () => true)
    await makeLifecycle({ deps: { ...sysHarness.deps, ensureBunLockExcluded: sysLock } }).installSt()
    expect(sysHarness.calls[0]?.command).toBe(buildNpmInstallCommand('C:/fake/npm.cmd'))
    expect(sysLock).not.toHaveBeenCalled()

    // portable · installNpmDependencies（no-omit 变体）
    const portHarness = makeExecHarness(() => 0)
    const portLock = vi.fn(async () => true)
    await makeLifecycle({
      portable: true,
      deps: { ...portHarness.deps, ensureBunLockExcluded: portLock },
    }).installNpmDependencies()
    expect(portHarness.calls[0]?.command).toBe(
      buildNpmInstallCommandNoOmit(join(root, 'env', 'npm.cmd')),
    )
    expect(portLock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Phase 4 · IsoGit 路由（设计计划 §8.3：embedded → IsoGitOps；
// portable/system → SpawnGitOps 包装原命令串，D3 逐字节一致）
// ---------------------------------------------------------------------------

/** StRepoOps mock 工厂（按需覆盖个别方法；其余为不应被调用的哨兵） */
function makeRepoOpsMock(overrides: Partial<StRepoOps> = {}): StRepoOps & {
  calls: Record<string, number>
} {
  const calls: Record<string, number> = {}
  const sentinel = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1
    return { ok: false, message: `不应调用 ${name}`, exitCode: 1 }
  }
  const ops: StRepoOps = {
    cloneRelease: async (...args) => {
      void args
      return sentinel('cloneRelease')
    },
    fetchOrigin: async (...args) => {
      void args
      return sentinel('fetchOrigin')
    },
    pullFastForward: async (...args) => {
      void args
      return sentinel('pullFastForward')
    },
    checkoutTag: async (...args) => {
      void args
      return sentinel('checkoutTag')
    },
    statusPorcelain: async () => {
      sentinel('statusPorcelain')
      return ''
    },
    listTags: async () => {
      sentinel('listTags')
      return []
    },
    currentCommit: async () => {
      sentinel('currentCommit')
      return null
    },
    setRemote: async (...args) => {
      void args
      return sentinel('setRemote')
    },
    ...overrides,
  }
  return Object.assign(ops, { calls })
}

describe('Phase 4 · StRepoOps 路由（设计计划 §8.3，D3 零回归）', () => {
  it('installSt embedded：IsoGitOps.cloneRelease 接管（原 gitExe 门禁打通），无 spawn clone', async () => {
    const harness = makeExecHarness(() => 0)
    const cloneRelease = vi.fn(async () => ({ ok: true, message: 'SillyTavern安装完成', exitCode: 0 }))
    const ops = makeRepoOpsMock({ cloneRelease })
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: {
        ...embeddedInstallDeps(harness.deps),
        createRepoOps: () => ops,
      },
    })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(true)
    expect(cloneRelease).toHaveBeenCalledWith(
      'https://github.com/SillyTavern/SillyTavern.git',
      join(root, 'SillyTavern'),
    )
    // clone 经进程内 Git：exec 通道只出现后续 bun install，无任何 git 命令串
    expect(harness.calls.some((call) => call.command.includes('clone'))).toBe(false)
    expect(harness.calls[0]?.command).toBe(buildBunInstallCommand(EMBEDDED_EXE))
  })

  it('installSt portable/system（D3 焊死）：clone 命令串与 cwd 与现状逐字节一致', async () => {
    // system（现状）："<git>" clone <ST_REPO_URL> -b release，cwd = 启动器根；
    // 不注入 createRepoOps → 默认 SpawnGitOps 路由，产出与 Phase 4 前完全相同的命令串
    const sysHarness = makeExecHarness(() => 0)
    await makeLifecycle({ deps: sysHarness.deps }).installSt()
    expect(sysHarness.calls[0]?.command).toBe(buildGitCloneCommand('C:/fake/git.exe'))
    expect(sysHarness.calls[0]?.cwd).toBe(root)

    // portable（现状）
    const portHarness = makeExecHarness(() => 0)
    await makeLifecycle({ portable: true, deps: portHarness.deps }).installSt()
    expect(portHarness.calls[0]?.command).toBe(
      buildGitCloneCommand(join(root, 'env', 'cmd', 'git.exe')),
    )
  })

  it('installSt 失败目录清理语义（D3）：clone 退出码经 exitCode 透传，残留目录清理不回归', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(join(stDir, '.git'), { recursive: true }) // 失败 clone 残留形态
    const harness = makeExecHarness(() => 1)
    const lifecycle = makeLifecycle({ deps: harness.deps })

    const result = await lifecycle.installSt()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('安装失败: git clone进程返回错误码: 1')
    // 仅 .git 的残留目录被清理（← is_failed_clone_folder 语义）
    expect(existsSync(stDir)).toBe(false)
  })

  it('镜像增强（2026-09-21）：clone 失败 → 取证切换镜像并重试一次', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(join(stDir, '.git'), { recursive: true }) // 失败 clone 残留形态
    // 第 1 次进程（clone）失败；切换镜像后的第 2 次（重试）成功
    const harness = makeExecHarness((_command, index) => (index === 1 ? 1 : 0))
    const failover = vi.fn(async (_reason: string) => ({
      switched: true,
      from: 'gh-proxy.org',
      to: 'github.dpik.top',
      latencyMs: 42,
      exhausted: false,
      message: '镜像 gh-proxy.org 不可用，已自动切换至 github.dpik.top（42 ms）',
    }))
    const lifecycle = makeLifecycle({ deps: { ...harness.deps, mirrorFailover: failover } })

    const result = await lifecycle.installSt()
    // 失败原因透传 + 兜底被调用 + 用新镜像重试一次成功
    expect(failover).toHaveBeenCalledTimes(1)
    expect(failover.mock.calls[0]?.[0]).toContain('git clone 失败')
    const clones = harness.calls.filter((call) => call.command.includes(' clone '))
    expect(clones).toHaveLength(2)
    expect(result.ok).toBe(true)
  })

  it('镜像增强：兜底未切换（当前镜像探活正常）时不重试，按原样回报失败', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(join(stDir, '.git'), { recursive: true })
    const harness = makeExecHarness(() => 1)
    const failover = vi.fn(async (_reason: string) => ({
      switched: false,
      from: 'github.dpik.top',
      to: 'github.dpik.top',
      latencyMs: 90,
      exhausted: false,
      message: '镜像 github.dpik.top 探活正常（90 ms），本次失败与镜像无关',
    }))
    const lifecycle = makeLifecycle({ deps: { ...harness.deps, mirrorFailover: failover } })

    const result = await lifecycle.installSt()
    expect(failover).toHaveBeenCalledTimes(1)
    expect(harness.calls.filter((call) => call.command.includes(' clone '))).toHaveLength(1)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('安装失败: git clone进程返回错误码: 1')
  })

  it('updateSt portable/system（D3 焊死）：pull 命令串与前置步骤与现状逐字节一致', async () => {
    setupSt()
    const exec = makeExecHarness(() => 0)
    const git = makeGitHarness((args) => {
      if (args[0] === 'rev-parse') return { stdout: 'release\n' }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${EXPECTED_ST_REMOTE}\n` }
      }
      return { ok: true }
    })
    const cleanup = vi.fn(async () => ({ ok: true, message: 'Git状态清理成功' }))
    // 不注入 createRepoOps → 默认 SpawnGitOps 路由（包装原 executeCommand 命令串）
    const lifecycle = makeLifecycle({
      deps: { ...exec.deps, ...git.deps, cleanupGitState: cleanup },
    })

    const result = await lifecycle.updateSt()
    expect(result.ok).toBe(true)
    // 前置步骤全走原 runGit / cleanup（不经 Ops）
    expect(cleanup).toHaveBeenCalledWith(join(root, 'SillyTavern'))
    expect(git.calls).toContainEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(git.calls).toContainEqual(['remote', 'get-url', 'origin'])
    expect(git.calls).not.toContainEqual(['remote', 'set-url', 'origin', EXPECTED_ST_REMOTE])
    // pull 经 Ops 包装仍产出原命令串 + 原 cwd
    const pullCall = exec.calls.find((call) => call.command === buildGitPullCommand('C:/fake/git.exe'))
    expect(pullCall).toBeDefined()
    expect(pullCall?.cwd).toBe(join(root, 'SillyTavern'))
  })

  it('checkForStUpdate embedded：fetchOrigin + ref 对比（up-to-date / needs-update / check-failed）', async () => {
    setupSt()
    const mk = (
      ops: StRepoOps,
    ): ReturnType<typeof makeLifecycle> =>
      makeLifecycle({
        config: makeConfig({ env_mode: 'embedded' }),
        deps: { ...embeddedDeps({}), createRepoOps: () => ops },
      })

    // up-to-date：HEAD 与 origin/release 同 commit
    const sameOps = makeRepoOpsMock({
      fetchOrigin: async () => ({ ok: true, message: 'ok', exitCode: 0 }),
      currentCommit: async () => 'a'.repeat(40),
      originReleaseCommit: async () => 'a'.repeat(40),
    })
    expect((await mk(sameOps).checkForStUpdate()).status).toBe('up-to-date')

    // needs-update：commit 不一致
    const diffOps = makeRepoOpsMock({
      fetchOrigin: async () => ({ ok: true, message: 'ok', exitCode: 0 }),
      currentCommit: async () => 'a'.repeat(40),
      originReleaseCommit: async () => 'b'.repeat(40),
    })
    expect((await mk(diffOps).checkForStUpdate()).status).toBe('needs-update')

    // fetch 失败 → check-failed
    const failOps = makeRepoOpsMock({
      fetchOrigin: async () => ({ ok: false, message: 'net', exitCode: 1 }),
    })
    expect((await mk(failOps).checkForStUpdate()).status).toBe('check-failed')
    // embedded 无 gitExe 也不再判 no-git（门禁打通）
  })

  it('checkForStUpdate portable/system（D3 焊死）：fetch --all / status -uno / diff 命令串不变', async () => {
    setupSt()
    const exec = makeExecHarness(() => 0)
    const git = makeGitHarness((args) => (args[0] === 'diff' ? { stdout: '' } : {}))
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })

    expect((await lifecycle.checkForStUpdate()).status).toBe('up-to-date')
    const commands = exec.calls.map((call) => call.command)
    expect(commands).toContain('"C:/fake/git.exe" fetch --all')
    expect(commands).toContain('"C:/fake/git.exe" status -uno')
    expect(git.calls).toContainEqual(['diff', 'release..origin/release'])
  })

  it('switchStVersion embedded：porcelain 白名单判定 + checkoutTag + currentCommit 经 Ops', async () => {
    setupSt()
    const checkoutTag = vi.fn(async () => ({ ok: true, message: '成功切换到 tag 1.13.0', exitCode: 0 }))
    const ops = makeRepoOpsMock({
      statusPorcelain: async () => ' M package-lock.json',
      checkoutTag,
      currentCommit: async () => 'abcdef1234567890abcdef1234567890abcdef12',
    })
    const lifecycle = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: { ...embeddedDeps({}), createRepoOps: () => ops },
    })

    const result = await lifecycle.switchStVersion({ version: '1.13.0' }, '1.13.0')
    expect(result.ok).toBe(true)
    expect(checkoutTag).toHaveBeenCalledWith('1.13.0', join(root, 'SillyTavern'))
    expect(logs.some((message) => message.includes('当前commit: abcdef1'))).toBe(true)
    expect(logs.some((message) => message.includes('工作区干净（已自动恢复package-lock.json）'))).toBe(
      false,
    )

    // 非白名单脏文件 → 拒绝且不触 checkoutTag
    const dirtyOps = makeRepoOpsMock({
      statusPorcelain: async () => ' M server.js\n?? other.txt',
    })
    const dirty = makeLifecycle({
      config: makeConfig({ env_mode: 'embedded' }),
      deps: { ...embeddedDeps({}), createRepoOps: () => dirtyOps },
    })
    const dirtyResult = await dirty.switchStVersion({ version: '1.13.0' }, '1.13.0')
    expect(dirtyResult.ok).toBe(false)
    expect(dirtyResult.message).toContain('检测到2个文件有未提交的更改')
    expect(dirtyResult.message).toContain('切换可能丢失更改')
    expect((dirtyOps.calls['checkoutTag'] ?? 0)).toBe(0)
  })

  it('switchStVersion portable/system（D3 焊死）：仍走 deps.checkGitStatus / checkoutStTag 注入面', async () => {
    setupSt()
    const checkout = vi.fn(async () => ({ ok: true, message: '成功切换到 tag 1.13.0' }))
    const ops = makeRepoOpsMock()
    const lifecycle = makeLifecycle({
      deps: {
        checkoutStTag: checkout,
        checkGitStatus: vi.fn(async () => ({ ok: true, message: '工作区干净' })),
        getCurrentCommit: vi.fn(async () => ({
          ok: true,
          commit: 'a'.repeat(40),
          message: 'ok',
        })),
        createRepoOps: () => ops,
      },
    })
    const result = await lifecycle.switchStVersion({ version: '1.13.0' }, '1.13.0')
    expect(result.ok).toBe(true)
    expect(checkout).toHaveBeenCalledWith('1.13.0', join(root, 'SillyTavern'))
    expect(ops.calls).toEqual({}) // spawn 模式零 Ops 调用
  })

  it('updateMirrorSetting embedded：旁路 gitconfig INI 手术，仅 setRemote + config 保存', async () => {
    setupSt()
    const setRemote = vi.fn(async () => ({ ok: true, message: '已将远程地址设置为 ...', exitCode: 0 }))
    const ops = makeRepoOpsMock({ setRemote })
    const config = makeConfig({ env_mode: 'embedded' })
    const lifecycle = makeLifecycle({
      config,
      deps: { ...embeddedDeps({}), createRepoOps: () => ops },
    })

    const result = await lifecycle.updateMirrorSetting('gh-proxy.org')
    expect(result.ok).toBe(true)
    expect(config.get<string>('github.mirror')).toBe('gh-proxy.org')
    expect(setRemote).toHaveBeenCalledWith(
      'https://github.com/SillyTavern/SillyTavern.git',
      join(root, 'SillyTavern'),
    )
    // 无 gitconfig INI 手术（embedded 分支不创建 env/etc/gitconfig）
    expect(existsSync(join(root, 'env', 'etc', 'gitconfig'))).toBe(false)
    expect(existsSync(join(root, 'env'))).toBe(false)
  })

  it('checkStatusFromPorcelain：白名单语义与 checkGitStatus 文案一致', () => {
    expect(checkStatusFromPorcelain('')).toEqual({ ok: true, message: '工作区干净' })
    expect(checkStatusFromPorcelain(' M package-lock.json')).toEqual({
      ok: true,
      message: '工作区干净（已自动恢复package-lock.json）',
    })
    expect(checkStatusFromPorcelain(' M package-lock.json\n?? bun.txt')).toEqual({
      ok: false,
      message: '检测到1个文件有未提交的更改',
    })
    expect(checkStatusFromPorcelain(' M a.txt\n M b.txt\n?? c.txt')).toEqual({
      ok: false,
      message: '检测到3个文件有未提交的更改',
    })
  })
})

describe('私网请求过滤自愈（← 适配 ST private request filter 特性）', () => {
  it('startSt：存量配置（listen 开 + 过滤关）→ spawn 前补开并打日志', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const heal = vi.fn(async () => 'healed' as const)
    const lifecycle = makeLifecycle({
      deps: {
        ...harness.deps,
        stConfig: {
          proxyEnabled: false,
          proxyUrl: '',
          save: () => true,
          ensurePrivateFilterForListen: heal,
          privateAddressAllowedRanges: ['127.0.0.0/8', '::1/128'],
        },
      },
    })

    const result = await lifecycle.startSt()
    expect(result.ok).toBe(true)
    expect(heal).toHaveBeenCalledTimes(1)
    expect(logs.some((m) => m.includes('已自动开启私网请求过滤') && m.includes('127.0.0.0/8'))).toBe(true)
  })

  it('startSt：自愈写入失败 → 不阻断启动，仅警告日志', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      deps: {
        ...harness.deps,
        stConfig: {
          proxyEnabled: false,
          proxyUrl: '',
          save: () => false,
          ensurePrivateFilterForListen: async () => 'save-failed',
        },
      },
    })

    const result = await lifecycle.startSt()
    expect(result.ok).toBe(true)
    expect(harness.calls.length).toBe(1)
    expect(logs.some((m) => m.includes('私网请求过滤自动开启失败'))).toBe(true)
  })

  it('startSt：无需自愈（ok）→ 不打自愈日志', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({
      deps: {
        ...harness.deps,
        stConfig: { proxyEnabled: false, proxyUrl: '', save: () => true, ensurePrivateFilterForListen: async () => 'ok' },
      },
    })
    await lifecycle.startSt()
    expect(logs.some((m) => m.includes('私网请求过滤'))).toBe(false)
  })

  it('restartSt：不经 startSt 的路径同样执行自愈', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const heal = vi.fn(async () => 'healed' as const)
    const lifecycle = makeLifecycle({
      deps: {
        ...harness.deps,
        stConfig: { proxyEnabled: false, proxyUrl: '', save: () => true, ensurePrivateFilterForListen: heal },
      },
    })

    const result = await lifecycle.restartSt()
    expect(result.ok).toBe(true)
    expect(heal).toHaveBeenCalledTimes(1)
  })
})

describe('stopSt（← stop_sillytavern）', () => {
  it('无进程 → 提示；有进程 → stopAllProcesses 并上报日志', async () => {
    const stopAll = vi.fn(async (onEvent?: (message: string) => void) => {
      onEvent?.('正在终止 1 个进程...')
      return true
    })
    const idle = makeLifecycle({
      deps: { stopAllProcesses: stopAll, getActiveProcessesCount: () => 0 },
    })
    expect((await idle.stopSt()).message).toBe('当前没有运行中的进程')
    expect(stopAll).not.toHaveBeenCalled()

    const busy = makeLifecycle({
      deps: { stopAllProcesses: stopAll, getActiveProcessesCount: () => 1 },
    })
    const result = await busy.stopSt()
    expect(result.ok).toBe(true)
    expect(stopAll).toHaveBeenCalledTimes(1)
    expect(logs.some((message) => message.includes('正在终止 1 个进程...'))).toBe(true)
  })
})

describe('restartSt（← restart_sillytavern，仅中文/空格检查）', () => {
  it('路径含中文 → 拒绝重启', async () => {
    setupSt({ nodeModules: true })
    const chineseRoot = mkdtempSync(join(TMP_ROOT, 'stl-重启-'))
    try {
      const harness = makeExecHarness(() => 0)
      const lifecycle = new StLifecycle({
        baseDir: chineseRoot,
        onLog: (message) => logs.push(message),
        deps: {
          ...harness.deps,
          configStore: makeConfig(),
          whichFn: (b) => WHICH_MAP[b] ?? null,
        },
      })
      const result = await lifecycle.restartSt()
      expect(result.ok).toBe(false)
      expect(result.message).toContain('中文字符')
      expect(harness.calls.length).toBe(0)
    } finally {
      rmSync(chineseRoot, { force: true, recursive: true })
    }
  })

  it('停止后重新启动（命令与 cwd 断言）', async () => {
    setupSt({ nodeModules: true })
    const harness = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({ deps: harness.deps })
    const result = await lifecycle.restartSt()
    expect(result.ok).toBe(true)
    expect(harness.calls[0]?.command).toBe('"C:/fake/node.exe" server.js')
    expect(logs.some((message) => message.includes('SillyTavern已重启'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// updateSt（package-lock 冲突恢复 + node_modules 重装重试链）
// ---------------------------------------------------------------------------

describe('updateSt（← update_sillytavern[_with_callback]）', () => {
  it('前置步骤：cleanupGitState → detached HEAD 恢复 → remote set-url → pull', async () => {
    setupSt()
    const exec = makeExecHarness(() => 0)
    const git = makeGitHarness((args) => {
      if (args[0] === 'rev-parse') return { stdout: 'HEAD\n' } // detached
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://gh-proxy.org/https://github.com/SillyTavern/SillyTavern.git\n' }
      }
      return { ok: true }
    })
    const cleanup = vi.fn(async () => ({ ok: true, message: 'Git状态清理成功' }))
    const lifecycle = makeLifecycle({
      deps: { ...exec.deps, ...git.deps, cleanupGitState: cleanup },
    })

    const result = await lifecycle.updateSt()
    expect(result.ok).toBe(true)

    expect(cleanup).toHaveBeenCalledWith(join(root, 'SillyTavern'))
    expect(git.calls).toContainEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(git.calls).toContainEqual(['checkout', '-B', 'release', 'origin/release'])
    expect(git.calls).toContainEqual(['remote', 'get-url', 'origin'])
    expect(git.calls).toContainEqual(['remote', 'set-url', 'origin', EXPECTED_ST_REMOTE])
    expect(exec.calls.some((call) => call.command === buildGitPullCommand('C:/fake/git.exe'))).toBe(true)
  })

  it('package-lock 冲突恢复：pull 失败一次 → checkout package-lock → 重试成功', async () => {
    setupSt()
    let pullCount = 0
    const exec = makeExecHarness((command) => {
      if (command.includes('pull --rebase')) {
        pullCount += 1
        return pullCount === 1 ? 1 : 0
      }
      return 0
    })
    const git = makeGitHarness(() => ({ ok: true }))
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })

    const result = await lifecycle.updateSt()
    expect(result.ok).toBe(true)
    expect(pullCount).toBe(2)
    expect(git.calls.filter((args) => args.join(' ') === 'checkout -- package-lock.json').length).toBe(1)
    expect(logs.some((message) => message.includes('已重置package-lock.json，重新尝试更新...'))).toBe(true)
  })

  it('重试上限：pull 失败 3 次后放弃（≤2 重试）；package-lock 恢复执行 2 次', async () => {
    setupSt()
    let pullCount = 0
    const exec = makeExecHarness((command) => {
      if (command.includes('pull --rebase')) {
        pullCount += 1
        return 1
      }
      return 0
    })
    const git = makeGitHarness(() => ({ ok: true }))
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })

    const result = await lifecycle.updateSt()
    expect(result.ok).toBe(false)
    expect(pullCount).toBe(3) // 1 次初始 + 2 次重试
    expect(git.calls.filter((args) => args.join(' ') === 'checkout -- package-lock.json').length).toBe(2)
  })

  it('package-lock 恢复失败 → 需要手动处理', async () => {
    setupSt()
    const exec = makeExecHarness((command) => (command.includes('pull') ? 1 : 0))
    const git = makeGitHarness((args) =>
      args.join(' ') === 'checkout -- package-lock.json' ? { ok: false, exitCode: 1 } : { ok: true },
    )
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })
    const result = await lifecycle.updateSt()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('无法解决package-lock.json冲突，需要手动处理')
  })

  it('withAutoStart 变体：npm 失败两次后成功（cache clean ×2 + node_modules 删除）', async () => {
    const stDir = setupSt({ nodeModules: true })
    let npmInstallCount = 0
    const exec = makeExecHarness((command) => {
      if (command.includes('cache clean')) return 0
      if (command.includes('install --no-audit')) {
        npmInstallCount += 1
        if (npmInstallCount <= 2) return 1
        // 第三次成功：真实 npm 会重建 node_modules
        mkdirSync(join(stDir, 'node_modules'), { recursive: true })
        return 0
      }
      return 0 // pull / 最终启动
    })
    const git = makeGitHarness(() => ({ ok: true }))
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })

    const result = await lifecycle.updateSt({ withAutoStart: true })
    expect(result.ok).toBe(true)
    expect(npmInstallCount).toBe(3)
    expect(exec.calls.filter((call) => call.command.includes('cache clean --force')).length).toBe(2)
    // 最终成功的 install 重建了 node_modules（中间被删除过）
    expect(existsSync(join(stDir, 'node_modules'))).toBe(true)
    // 最终自动启动
    expect(exec.calls.some((call) => call.command.includes('server.js'))).toBe(true)
  })

  it('普通变体：npm 失败一次即报告失败（无 cache clean 重试，1:1）', async () => {
    setupSt({ nodeModules: true })
    const exec = makeExecHarness((command) => {
      if (command.includes('install --no-audit')) return 1
      return 0
    })
    const git = makeGitHarness(() => ({ ok: true }))
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })

    const result = await lifecycle.updateSt()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('依赖安装失败')
    expect(exec.calls.filter((call) => call.command.includes('cache clean')).length).toBe(0)
  })

  it('SillyTavern 未安装 / 无 git → 拒绝', async () => {
    const exec = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({ deps: exec.deps })
    expect((await lifecycle.updateSt()).message).toBe('SillyTavern未安装')

    setupSt()
    const noGit = makeLifecycle({ deps: { ...exec.deps, whichFn: () => null } })
    expect((await noGit.updateSt()).message).toBe('未找到Git路径，请手动更新SillyTavern')
  })
})

// ---------------------------------------------------------------------------
// checkForStUpdate / checkAndStartSt
// ---------------------------------------------------------------------------

describe('checkForStUpdate（← check_and_start_sillytavern 的判定部分）', () => {
  it('未安装 / 无 git', async () => {
    const exec = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({ deps: exec.deps })
    expect((await lifecycle.checkForStUpdate()).status).toBe('not-installed')

    setupSt()
    const noGit = makeLifecycle({ deps: { ...exec.deps, whichFn: () => null } })
    expect((await noGit.checkForStUpdate()).status).toBe('no-git')
  })

  it('diff 为空 → up-to-date', async () => {
    setupSt()
    const exec = makeExecHarness(() => 0)
    const git = makeGitHarness(() => ({ stdout: '' }))
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })
    expect((await lifecycle.checkForStUpdate()).status).toBe('up-to-date')
    expect(git.calls).toContainEqual(['diff', 'release..origin/release'])
  })

  it('diff 非空 → needs-update；fetch 失败 → check-failed', async () => {
    setupSt()
    const exec = makeExecHarness(() => 0)
    const git = makeGitHarness((args) => (args[0] === 'diff' ? { stdout: 'diff --git a b\n' } : {}))
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })
    expect((await lifecycle.checkForStUpdate()).status).toBe('needs-update')

    const failingFetch = makeExecHarness((command) => (command.includes('fetch --all') ? 1 : 0))
    const failing = makeLifecycle({ deps: { ...failingFetch.deps, ...git.deps } })
    expect((await failing.checkForStUpdate()).status).toBe('check-failed')
  })

  it('checkAndStartSt：up-to-date 直接启动（无 pull）', async () => {
    setupSt({ nodeModules: true })
    const exec = makeExecHarness(() => 0)
    const git = makeGitHarness((args) => (args[0] === 'diff' ? { stdout: '' } : {}))
    const lifecycle = makeLifecycle({ deps: { ...exec.deps, ...git.deps } })
    const result = await lifecycle.checkAndStartSt()
    expect(result.ok).toBe(true)
    expect(exec.calls.some((call) => call.command.includes('server.js'))).toBe(true)
    expect(exec.calls.some((call) => call.command.includes('pull --rebase'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// switchStVersion / installNpmDependencies
// ---------------------------------------------------------------------------

describe('switchStVersion（← switch_st_version）', () => {
  it('运行中 → 拒绝；工作区脏 → 拒绝', async () => {
    setupSt()
    const checkout = vi.fn(async () => ({ ok: true, message: '成功切换到 tag 1.13.0' }))
    const running = makeLifecycle({
      deps: {
        checkoutStTag: checkout,
        hasStServerProcess: () => true,
        checkGitStatus: vi.fn(async () => ({ ok: true, message: '工作区干净' })),
      },
    })
    expect((await running.switchStVersion({ version: '1.13.0' }, '1.13.0')).message).toContain(
      '请先停止SillyTavern后再切换版本',
    )
    expect(checkout).not.toHaveBeenCalled()

    const dirty = makeLifecycle({
      deps: {
        checkoutStTag: checkout,
        hasStServerProcess: () => false,
        checkGitStatus: vi.fn(async () => ({ ok: false, message: '检测到2个文件有未提交的更改' })),
      },
    })
    const dirtyResult = await dirty.switchStVersion({ version: '1.13.0' }, '1.13.0')
    expect(dirtyResult.ok).toBe(false)
    expect(dirtyResult.message).toContain('切换可能丢失更改')
    expect(checkout).not.toHaveBeenCalled()
  })

  it('成功路径：checkoutStTag + 当前 commit 校验', async () => {
    setupSt()
    const checkout = vi.fn(async () => ({ ok: true, message: '成功切换到 tag 1.13.0' }))
    const getCommit = vi.fn(async () => ({
      ok: true,
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      message: '成功获取当前commit',
    }))
    const lifecycle = makeLifecycle({
      deps: {
        checkoutStTag: checkout,
        getCurrentCommit: getCommit,
        checkGitStatus: vi.fn(async () => ({ ok: true, message: '工作区干净' })),
      },
    })
    const result = await lifecycle.switchStVersion({ version: '1.13.0' }, '1.13.0')
    expect(result.ok).toBe(true)
    expect(checkout).toHaveBeenCalledWith('1.13.0', join(root, 'SillyTavern'))
    expect(logs.some((message) => message.includes('当前commit: abcdef1'))).toBe(true)
  })

  it('installNpmDependencies：无 --omit=dev（1:1）', async () => {
    setupSt()
    const exec = makeExecHarness(() => 0)
    const lifecycle = makeLifecycle({ deps: exec.deps })
    const result = await lifecycle.installNpmDependencies()
    expect(result.ok).toBe(true)
    expect(exec.calls[0]?.command).toBe(buildNpmInstallCommandNoOmit('C:/fake/npm.cmd'))
  })
})

// ---------------------------------------------------------------------------
// 镜像管理（← update_mirror_setting）
// ---------------------------------------------------------------------------

describe('updateMirrorSetting（← event.py:1673-1833）', () => {
  function portableEnvFixture(): void {
    const envRoot = join(root, 'env')
    mkdirSync(join(envRoot, 'cmd'), { recursive: true })
    mkdirSync(join(envRoot, 'etc'), { recursive: true })
    writeFileSync(join(envRoot, 'cmd', 'git.exe'), '', 'utf8')
  }

  it('切到镜像：gitconfig 写入 insteadOf，ST remote 同步切回官方', async () => {
    setupSt()
    portableEnvFixture()
    const git = makeGitHarness(() => ({ ok: true }))
    const switchRemote = vi.fn(async () => ({ ok: true, message: '已将远程地址设置为GitHub仓库' }))
    const config = makeConfig()
    const lifecycle = makeLifecycle({
      config,
      portable: true,
      deps: { ...git.deps, switchGitRemote: switchRemote },
    })

    const result = await lifecycle.updateMirrorSetting('gh.llkk.cc')
    expect(result.ok).toBe(true)
    expect(config.get<string>('github.mirror')).toBe('gh.llkk.cc')

    const gitconfigPath = join(root, 'env', 'etc', 'gitconfig')
    expect(existsSync(gitconfigPath)).toBe(true)
    const content = readFileSync(gitconfigPath, 'utf8')
    expect(content).toContain('[url "https://gh.llkk.cc/https://github.com/"]')
    expect(content).toContain('insteadof = https://github.com/')
    expect(switchRemote).toHaveBeenCalledWith('gh.llkk.cc', join(root, 'SillyTavern'))
  })

  it('切回 github：旧镜像映射被移除，其余节保留', async () => {
    setupSt()
    portableEnvFixture()
    const gitconfigPath = join(root, 'env', 'etc', 'gitconfig')
    writeFileSync(
      gitconfigPath,
      '[url "https://gh-proxy.org/https://github.com/"]\ninsteadof = https://github.com/\n\n[core]\nautocrlf = false\n',
      'utf8',
    )
    const git = makeGitHarness(() => ({ ok: true }))
    const config = makeConfig()
    const lifecycle = makeLifecycle({ config, portable: true, deps: git.deps })

    await lifecycle.updateMirrorSetting('github')
    const content = readFileSync(gitconfigPath, 'utf8')
    expect(content).not.toContain('gh-proxy.org')
    expect(content).toContain('[core]')
    expect(content).toContain('autocrlf = false')
  })

  it('无镜像映射时切 github → 无变更跳过写入（remove-then-readd 死路之外的唯一可达路径）', async () => {
    setupSt()
    portableEnvFixture()
    const gitconfigPath = join(root, 'env', 'etc', 'gitconfig')
    writeFileSync(gitconfigPath, '[core]\nautocrlf = false\n', 'utf8')
    const before = readFileSync(gitconfigPath, 'utf8')
    const git = makeGitHarness(() => ({ ok: true }))
    const lifecycle = makeLifecycle({ portable: true, deps: git.deps })
    await lifecycle.updateMirrorSetting('github')
    expect(readFileSync(gitconfigPath, 'utf8')).toBe(before)
    expect(logs.some((message) => message.includes('镜像配置无变更，跳过写入'))).toBe(true)
  })

  // 2026-09-21 镜像增强：自动选优只写 config.json，portable/system 的 git 加速靠
  // gitconfig insteadOf 生效——选优落盘后必须再走一次 updateMirrorSetting（生效口径）
  it('镜像新模型：updateMirrorSetting(host, { auto: true }) 同时落 enabled/mirror/auto 与 insteadOf', async () => {
    setupSt()
    portableEnvFixture()
    const gitconfigPath = join(root, 'env', 'etc', 'gitconfig')
    const git = makeGitHarness(() => ({ ok: true }))
    const switchRemote = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const config = makeConfig()
    const lifecycle = makeLifecycle({
      config,
      portable: true,
      deps: { ...git.deps, switchGitRemote: switchRemote },
    })

    const result = await lifecycle.updateMirrorSetting('github.dpik.top', { auto: true })
    expect(result.ok).toBe(true)
    expect(config.get<boolean>('github.enabled')).toBe(true)
    expect(config.get<string>('github.mirror')).toBe('github.dpik.top')
    expect(config.get<boolean>('github.auto')).toBe(true)
    const content = readFileSync(gitconfigPath, 'utf8')
    expect(content).toContain('[url "https://github.dpik.top/https://github.com/"]')
    expect(content).toContain('insteadof = https://github.com/')
    expect(switchRemote).toHaveBeenCalledWith('github.dpik.top', join(root, 'SillyTavern'))
  })

  it('镜像新模型：切回官方源只翻 enabled，已选 host 保留（切回加速可直接复用）', async () => {
    setupSt()
    portableEnvFixture()
    const gitconfigPath = join(root, 'env', 'etc', 'gitconfig')
    writeFileSync(
      gitconfigPath,
      '[url "https://github.dpik.top/https://github.com/"]\ninsteadof = https://github.com/\n',
      'utf8',
    )
    const git = makeGitHarness(() => ({ ok: true }))
    const config = makeConfig({
      github: {
        enabled: true,
        mirror: 'github.dpik.top',
        auto: true,
        speedtest: { results: {}, failed: [], tested_at: '' },
      },
    })
    const lifecycle = makeLifecycle({ config, portable: true, deps: git.deps })

    const result = await lifecycle.updateMirrorSetting('github')
    expect(result.ok).toBe(true)
    expect(config.get<boolean>('github.enabled')).toBe(false)
    expect(config.get<string>('github.mirror')).toBe('github.dpik.top')
    // 官方源 = 不加速：旧镜像映射必须撤掉，否则仍走镜像（用户以为切回官方了）
    expect(readFileSync(gitconfigPath, 'utf8')).not.toContain('github.dpik.top')
  })

  it('镜像新模型：官方源且 host 非法 → 清空 host（不留脏值给 activeMirrorHost 兜底）', async () => {
    setupSt()
    portableEnvFixture()
    const git = makeGitHarness(() => ({ ok: true }))
    const config = makeConfig({
      github: { enabled: true, mirror: 'not-a-mirror', auto: true, speedtest: { results: {}, failed: [], tested_at: '' } },
    })
    const lifecycle = makeLifecycle({ config, portable: true, deps: git.deps })
    await lifecycle.updateMirrorSetting('github')
    expect(config.get<boolean>('github.enabled')).toBe(false)
    expect(config.get<string>('github.mirror')).toBe('')
  })

  it('重复设置同一镜像 → 先移除后重加触发重写并规范化（1:1：insteadof 命中收集条件）', async () => {
    setupSt()
    portableEnvFixture()
    const gitconfigPath = join(root, 'env', 'etc', 'gitconfig')
    writeFileSync(
      gitconfigPath,
      '[url "https://gh.llkk.cc/https://github.com/"]\ninsteadof = https://github.com/',
      'utf8',
    )
    const git = makeGitHarness(() => ({ ok: true }))
    const lifecycle = makeLifecycle({ portable: true, deps: git.deps })
    await lifecycle.updateMirrorSetting('gh.llkk.cc')
    const after = readFileSync(gitconfigPath, 'utf8')
    expect(after).toBe(
      '[url "https://gh.llkk.cc/https://github.com/"]\ninsteadof = https://github.com/\n\n',
    )
    expect(logs.some((message) => message.includes('移除旧镜像映射'))).toBe(true)
    expect(logs.some((message) => message.includes('添加镜像映射'))).toBe(true)
  })

  it('系统 Git 且未开 patchgit → 不改内部 gitconfig（仅改配置与 ST remote）', async () => {
    setupSt()
    const git = makeGitHarness(() => ({ ok: true }))
    const switchRemote = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const config = makeConfig({ env_mode: 'system', patchgit: false })
    const lifecycle = makeLifecycle({ config, deps: { ...git.deps, switchGitRemote: switchRemote } })
    await lifecycle.updateMirrorSetting('gh-proxy.org')
    expect(existsSync(join(root, 'env'))).toBe(false)
    expect(config.get<string>('github.mirror')).toBe('gh-proxy.org')
    expect(switchRemote).toHaveBeenCalled()
  })

  it('系统 Git 且开启 patchgit → 走 ~/.gitconfig_internal 路径（不抛错）', async () => {
    setupSt()
    const git = makeGitHarness(() => ({ ok: true }))
    const config = makeConfig({ env_mode: 'system', patchgit: true })
    const lifecycle = new StLifecycle({
      baseDir: root,
      onLog: (message) => logs.push(message),
      deps: {
        configStore: config,
        runGit: git.deps.runGit,
        whichFn: () => 'C:/fake/git.exe',
        switchGitRemote: vi.fn(async () => ({ ok: true, message: 'ok' })),
      },
    })
    // gitDir（C:/fake）不存在 → 跳过 gitconfig 写入，但配置与 ST remote 仍更新
    const result = await lifecycle.updateMirrorSetting('gh-proxy.org')
    expect(result.ok).toBe(true)
    expect(config.get<string>('github.mirror')).toBe('gh-proxy.org')
  })
})

describe('gitconfig INI 解析（← configparser optionxform=str）', () => {
  it('解析 → 序列化 round-trip（键名大小写保留、% 转义）', () => {
    const text =
      '[url "https://m/https://github.com/"]\ninsteadOf = https://github.com/\n\n[core]\nautocrlf = false\n'
    const sections = parseGitConfigIni(text)
    expect(sections.length).toBe(2)
    expect(sections[0]?.name).toBe('url "https://m/https://github.com/"')
    expect(sections[0]?.entries[0]?.key).toBe('insteadOf') // 大小写保留
    // Python 写出器在每个节后都补空行（含最后一个节），1:1
    expect(serializeGitConfigIni(sections)).toBe(
      '[url "https://m/https://github.com/"]\ninsteadOf = https://github.com/\n\n[core]\nautocrlf = false\n\n',
    )

    expect(serializeGitConfigIni([{ name: 'a', entries: [{ key: 'k', value: '50%' }] }])).toBe(
      '[a]\nk = 50%%\n\n',
    )
  })

  it('注释行忽略；孤立的键抛错（← MissingSectionHeaderError）', () => {
    expect(parseGitConfigIni('; comment\n[core]\n; x\nk = v\n').length).toBe(1)
    expect(() => parseGitConfigIni('orphan = value\n')).toThrow('Missing section header')
  })

  it('readGitConfigText：utf-8 优先、非法 utf-8 回退不抛错', () => {
    const utf8Path = join(root, 'gc-utf8')
    writeFileSync(utf8Path, '[core]\nautocrlf = false\n', 'utf8')
    expect(readGitConfigText(utf8Path)).toContain('[core]')

    const binaryPath = join(root, 'gc-bin')
    writeFileSync(binaryPath, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]))
    expect(typeof readGitConfigText(binaryPath)).toBe('string')
  })
})
