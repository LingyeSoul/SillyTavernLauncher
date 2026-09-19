/**
 * ← event.py 编排语义等价测试：命令构造正确性（mock processManager/git
 * 断言调用参数与重试链）、install/start/stop/restart、update 的
 * package-lock 冲突恢复 ≤2 重试与 node_modules 重装重试链、
 * checkAndStart、版本切换、镜像 insteadOf 管理（utf-8 容错读写）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../services/configStore'
import {
  EXPECTED_ST_REMOTE,
  StLifecycle,
  buildGitCloneCommand,
  buildGitPullCommand,
  buildNpmCacheCleanCommand,
  buildNpmInstallCommand,
  buildNpmInstallCommandNoOmit,
  buildStStartCommand,
  normalizeProxyServer,
  parseGitConfigIni,
  readGitConfigText,
  readWindowsRegistryProxy,
  serializeGitConfigIni,
  validatePathForNpm,
  type StLifecycleDeps,
} from '../services/stLifecycle'
import type { ExecuteProcessOptions } from '../services/processManager'
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

let root: string
let configPath: string
let logs: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stllife'))
  configPath = join(root, 'config.json')
  logs = []
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

function makeConfig(initial: Record<string, unknown> = {}): ConfigStore {
  const store = new ConfigStore(configPath, root)
  store.set('use_sys_env', true)
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

/** executeProcessAsync mock：按命令脚本化退出码（null = 进程创建失败） */
function makeExecHarness(
  script: (command: string, index: number) => number | null,
): { deps: StLifecycleDeps; calls: ExecuteProcessOptions[] } {
  const calls: ExecuteProcessOptions[] = []
  const fn = async (options: ExecuteProcessOptions): Promise<ProcessInfo | null> => {
    calls.push(options)
    const code = script(options.command, calls.length)
    if (code === null) return null
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
    ...(parts.deps ?? {}),
  }
  if (parts.portable) {
    config.set('use_sys_env', false)
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
    const chineseRoot = mkdtempSync(join(tmpdir(), 'stl-重启-'))
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
    const config = makeConfig({ use_sys_env: true, patchgit: false })
    const lifecycle = makeLifecycle({ config, deps: { ...git.deps, switchGitRemote: switchRemote } })
    await lifecycle.updateMirrorSetting('gh-proxy.org')
    expect(existsSync(join(root, 'env'))).toBe(false)
    expect(config.get<string>('github.mirror')).toBe('gh-proxy.org')
    expect(switchRemote).toHaveBeenCalled()
  })

  it('系统 Git 且开启 patchgit → 走 ~/.gitconfig_internal 路径（不抛错）', async () => {
    setupSt()
    const git = makeGitHarness(() => ({ ok: true }))
    const config = makeConfig({ use_sys_env: true, patchgit: true })
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
