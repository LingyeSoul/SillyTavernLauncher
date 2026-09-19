/**
 * ← tests/test_extension_manager.py（ExtensionManagerSecurityTests）语义等价移植 + 扩展：
 * 名称正则注入拒绝、realpath 遏制、git 参数列表执行（绝不 shell）、
 * ZIP 安装（manifest 结构/自定义名/Zip-Slip）、镜像改写、扫描/移动/改名/复制/删除。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXTENSION_NAME_RE,
  ExtensionManager,
  __resetExtensionManagerForTests,
  getExtensionManager,
  isPathUnder,
  safeExtensionPath,
  validateExtensionName,
  type GitRunnerResult,
} from '../services/extensions'
import { realpathBestEffort } from '../services/atomicFs'

let baseDir: string
let gitRunnerCalls: { args: string[]; cwd: string }[]

/** git 执行 mock：记录参数；按脚本预设副作用（创建目标目录） */
function makeGitRunner(script: (args: string[]) => GitRunnerResult | void): {
  run: (args: string[], cwd: string) => Promise<GitRunnerResult>
} {
  return {
    run: async (args, cwd) => {
      gitRunnerCalls.push({ args, cwd })
      const result = script(args)
      return result ?? { ok: true, exitCode: 0, stdout: '', stderr: '' }
    },
  }
}

function makeManager(options: Partial<ConstructorParameters<typeof ExtensionManager>[0]> = {}): ExtensionManager {
  return new ExtensionManager({
    baseDir,
    getMirror: () => 'github',
    gitRunner: async (args, cwd) => {
      gitRunnerCalls.push({ args, cwd })
      return { ok: true, exitCode: 0, stdout: '', stderr: '' }
    },
    ...options,
  })
}

/** ST 已安装的目录骨架（_check_st_installed 需要 package.json + server.js） */
function setupInstalledSt(): void {
  const stDir = join(baseDir, 'SillyTavern')
  mkdirSync(join(stDir, 'public/scripts/extensions/third-party'), { recursive: true })
  mkdirSync(join(stDir, 'data/default-user/extensions'), { recursive: true })
  writeFileSync(join(stDir, 'package.json'), '{}', 'utf8')
  writeFileSync(join(stDir, 'server.js'), '// st', 'utf8')
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'stlext'))
  gitRunnerCalls = []
})

afterEach(() => {
  rmSync(baseDir, { force: true, recursive: true })
})

describe('名称正则（← EXTENSION_NAME_RE，1:1）', () => {
  it('拒绝路径与 shell 元字符（← test_extension_name_rejects_path_and_shell_metacharacters）', () => {
    for (const name of ['../outside', 'nested/name', 'name & whoami', 'name"bad']) {
      expect(() => validateExtensionName(name)).toThrow()
    }
  })

  it('接受字母数字下划线短横线', () => {
    expect(validateExtensionName('  safe-Name_1  ')).toBe('safe-Name_1')
    expect(EXTENSION_NAME_RE.test('a-b_C9')).toBe(true)
  })
})

describe('realpath 遏制（← _safe_extension_path）', () => {
  it('合法名称落在受管目录内（← test_safe_extension_path_stays_under_managed_directory）', () => {
    const result = safeExtensionPath(baseDir, 'safe-name_1')
    expect(result).toBe(join(realpathBestEffort(baseDir), 'safe-name_1'))
  })

  it('目标不存在时同样可用（安装场景，词法消除 ..）', () => {
    const result = safeExtensionPath(baseDir, 'not-yet-created')
    expect(isPathUnder(realpathBestEffort(baseDir), result)).toBe(true)
    expect(existsSync(result)).toBe(false)
  })
})

describe('git 安装（← install_from_git）', () => {
  it('不安全的自定义名称在校验阶段被拒绝，不触达 git（← Python 安全用例）', async () => {
    setupInstalledSt()
    const runner = makeGitRunner(() => undefined)
    const manager = makeManager({ gitRunner: runner.run })
    const result = await manager.installFromGit(
      'https://github.com/example/repository.git',
      'global',
      '../outside',
    )
    expect(result.ok).toBe(false)
    expect(gitRunnerCalls.length).toBe(0)
  })

  it('参数列表执行 clone，绝不 shell 拼接（← test_git_install_uses_argument_list_without_shell）', async () => {
    setupInstalledSt()
    const manager = makeManager({
      gitRunner: async (args) => {
        gitRunnerCalls.push({ args, cwd: baseDir })
        // 模拟 clone 成功创建有效扩展
        const target = args[args.length - 1] as string
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'manifest.json'), '{"display_name":"Repo"}', 'utf8')
        return { ok: true, exitCode: 0, stdout: '', stderr: '' }
      },
    })
    const result = await manager.installFromGit(
      'https://github.com/example/repository.git',
      'global',
      'safe-name',
    )
    expect(result.ok).toBe(true)
    expect(gitRunnerCalls.length).toBe(1)
    const args = gitRunnerCalls[0]?.args ?? []
    expect(args.slice(0, 4)).toEqual(['clone', '--depth', '1', '--'])
    expect(args[4]).toBe('https://github.com/example/repository.git')
    // 目标必须落在全局扩展目录内
    const target = args[5] ?? ''
    expect(isPathUnder(realpathBestEffort(manager.getGlobalExtPath()), target)).toBe(true)
    expect(basename(target)).toBe('safe-name')
  })

  it('clone 成功但缺少 manifest/index.js 时清理并报错', async () => {
    setupInstalledSt()
    const manager = makeManager({
      gitRunner: async (args) => {
        gitRunnerCalls.push({ args, cwd: baseDir })
        mkdirSync(args[args.length - 1] as string, { recursive: true })
        writeFileSync(join(args[args.length - 1] as string, 'readme.md'), 'x', 'utf8')
        return { ok: true, exitCode: 0, stdout: '', stderr: '' }
      },
    })
    const result = await manager.installFromGit(
      'https://github.com/example/invalid.git',
      'global',
      'invalid-ext',
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('不是有效的 SillyTavern 扩展')
    expect(existsSync(join(manager.getGlobalExtPath(), 'invalid-ext'))).toBe(false)
  })

  it('URL 安全校验：拒绝 ssh 协议、带凭据、无主机名（← urlsplit 语义 1:1）', async () => {
    setupInstalledSt()
    const manager = makeManager()
    for (const bad of [
      'git@github.com:example/repo.git',
      'https://user:pass@example.com/repo.git',
      'ftp://example.com/repo',
      'file:///C:/repo',
      'not a url',
    ]) {
      const result = await manager.installFromGit(bad, 'global')
      expect(result.ok).toBe(false)
      expect(result.message).toContain('无效的仓库 URL')
    }
    expect(gitRunnerCalls.length).toBe(0)
  })

  it('已存在同名扩展时拒绝', async () => {
    setupInstalledSt()
    const manager = makeManager()
    const existing = join(manager.getGlobalExtPath(), 'exists')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'index.js'), '// x', 'utf8')
    const result = await manager.installFromGit(
      'https://github.com/example/exists.git',
      'global',
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('扩展已存在')
  })
})

describe('镜像改写（← _apply_github_mirror）', () => {
  it('gh-proxy.org 前置 GitHub/raw URL', () => {
    const manager = makeManager({ getMirror: () => 'gh-proxy.org' })
    expect(manager.applyGithubMirror('https://github.com/a/b')).toBe(
      'https://gh-proxy.org/https://github.com/a/b',
    )
    expect(manager.applyGithubMirror('https://raw.githubusercontent.com/a/b/c')).toBe(
      'https://gh-proxy.org/https://raw.githubusercontent.com/a/b/c',
    )
  })

  it('gh.llkk.cc 前置；非 GitHub URL 与 github 镜像原样返回', () => {
    const llkk = makeManager({ getMirror: () => 'gh.llkk.cc' })
    expect(llkk.applyGithubMirror('http://github.com/a/b')).toBe(
      'https://gh.llkk.cc/http://github.com/a/b',
    )
    expect(llkk.applyGithubMirror('https://example.com/a')).toBe('https://example.com/a')

    const github = makeManager({ getMirror: () => 'github' })
    expect(github.applyGithubMirror('https://github.com/a/b')).toBe('https://github.com/a/b')
  })

  it('GitHub URL 必须出现在开头（re.match 语义）', () => {
    const manager = makeManager({ getMirror: () => 'gh-proxy.org' })
    expect(manager.applyGithubMirror('https://evil.com/?u=https://github.com/a/b')).toBe(
      'https://evil.com/?u=https://github.com/a/b',
    )
  })
})

describe('ZIP 安装（← install_from_zip）', () => {
  it('单层目录 zip：使用内层目录名安装', () => {
    setupInstalledSt()
    const manager = makeManager()
    const zipPath = join(baseDir, 'my-ext-main.zip')
    writeFileSync(
      zipPath,
      zipSync({
        'my-ext/manifest.json': Buffer.from('{"display_name":"My Ext","version":"1.0"}', 'utf8'),
        'my-ext/index.js': Buffer.from('// entry', 'utf8'),
      }),
    )
    const result = manager.installFromZip(zipPath, 'global')
    expect(result.ok).toBe(true)
    const installed = join(manager.getGlobalExtPath(), 'my-ext')
    expect(existsSync(join(installed, 'manifest.json'))).toBe(true)
    expect(existsSync(join(installed, 'index.js'))).toBe(true)
  })

  it('自定义名称安装', () => {
    setupInstalledSt()
    const manager = makeManager()
    const zipPath = join(baseDir, 'anything.zip')
    writeFileSync(
      zipPath,
      zipSync({ 'index.js': Buffer.from('// entry', 'utf8') }),
    )
    const result = manager.installFromZip(zipPath, 'user', 'custom-name')
    expect(result.ok).toBe(true)
    expect(existsSync(join(manager.getUserExtPath(), 'custom-name', 'index.js'))).toBe(true)
  })

  it('Zip-Slip：越界 entry 被拒绝，不落盘（遏制检查）', () => {
    setupInstalledSt()
    const manager = makeManager()
    const zipPath = join(baseDir, 'evil.zip')
    writeFileSync(
      zipPath,
      zipSync({
        'evil-ext/index.js': Buffer.from('// x', 'utf8'),
        '../escaped.txt': Buffer.from('evil', 'utf8'),
      }),
    )
    const result = manager.installFromZip(zipPath, 'global')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('ZIP 包含不安全的路径')
    expect(existsSync(join(manager.getGlobalExtPath(), 'escaped.txt'))).toBe(false)
    expect(existsSync(join(baseDir, 'escaped.txt'))).toBe(false)
  })

  it('非 ZIP 文件与不存在文件被拒绝', () => {
    setupInstalledSt()
    const manager = makeManager()
    const notZip = join(baseDir, 'not.zip')
    writeFileSync(notZip, Buffer.from('plain text, definitely not zip'))
    expect(manager.installFromZip(notZip, 'global').message).toContain('无效的文件格式')
    expect(manager.installFromZip(join(baseDir, 'missing.zip'), 'global').message).toContain(
      'ZIP 文件不存在',
    )
  })

  it('文件名提取：去扩展名 + 去 main/master/latest 后缀', () => {
    const manager = makeManager()
    expect(manager.extractNameFromZipFilename('my-ext-main.zip')).toBe('my-ext')
    expect(manager.extractNameFromZipFilename('My_Ext_master.ZIP')).toBe('My_Ext')
    expect(manager.extractNameFromZipFilename('plain.zip')).toBe('plain')
    expect(manager.extractNameFromZipFilename('ext-latest-1.2.zip')).toBe('ext-latest-1.2')
  })
})

describe('扫描与目录操作（← scan_extensions / move / rename / duplicate / delete）', () => {
  it('扫描：有效/无效/隐藏目录、manifest 加载、排序', () => {
    setupInstalledSt()
    const manager = makeManager()
    const globalDir = manager.getGlobalExtPath()
    mkdirSync(join(globalDir, 'Beta'), { recursive: true })
    writeFileSync(join(globalDir, 'Beta/manifest.json'), '{"display_name":"B","version":"2","author":"me"}', 'utf8')
    mkdirSync(join(globalDir, 'alpha'), { recursive: true })
    writeFileSync(join(globalDir, 'alpha/index.js'), '// x', 'utf8')
    mkdirSync(join(globalDir, 'broken'), { recursive: true })
    mkdirSync(join(globalDir, '.hidden'), { recursive: true })
    writeFileSync(join(globalDir, '.hidden/index.js'), '// x', 'utf8')

    const extensions = manager.scanExtensions('global')
    expect(extensions.map((e) => e.name)).toEqual(['alpha', 'Beta', 'broken'])
    expect(extensions[0]?.isValid).toBe(true)
    expect(extensions[0]?.manifest).toBeNull()
    const beta = extensions[1]
    expect(beta?.isValid).toBe(true)
    expect(beta?.manifest?.display_name).toBe('B')
    expect(extensions[2]?.isValid).toBe(false)
    expect(extensions[2]?.errorMsg).toContain('缺少 manifest.json 或 index.js')
  })

  it('getAllExtensions 返回两类', () => {
    setupInstalledSt()
    const manager = makeManager()
    const all = manager.getAllExtensions()
    expect(all.global).toEqual([])
    expect(all.user).toEqual([])
  })

  it('SillyTavern 未安装时扫描返回空列表', () => {
    const manager = makeManager()
    expect(manager.scanExtensions('global')).toEqual([])
  })

  it('移动：全局 → 用户', () => {
    setupInstalledSt()
    const manager = makeManager()
    mkdirSync(join(manager.getGlobalExtPath(), 'mover'), { recursive: true })
    writeFileSync(join(manager.getGlobalExtPath(), 'mover/index.js'), '// x', 'utf8')
    const [ext] = manager.scanExtensions('global')
    const result = manager.moveExtension(ext as never, 'user')
    expect(result.ok).toBe(true)
    expect(existsSync(join(manager.getUserExtPath(), 'mover/index.js'))).toBe(true)
    expect(existsSync(join(manager.getGlobalExtPath(), 'mover'))).toBe(false)
  })

  it('改名与复制（含遏制校验）', () => {
    setupInstalledSt()
    const manager = makeManager()
    mkdirSync(join(manager.getUserExtPath(), 'orig'), { recursive: true })
    writeFileSync(join(manager.getUserExtPath(), 'orig/index.js'), '// x', 'utf8')
    const [ext] = manager.scanExtensions('user')

    expect(manager.renameExtension(ext as never, '../escape').ok).toBe(false)
    expect(manager.renameExtension(ext as never, 'orig').ok).toBe(false)
    expect(manager.renameExtension(ext as never, 'renamed').ok).toBe(true)
    expect(existsSync(join(manager.getUserExtPath(), 'renamed/index.js'))).toBe(true)

    const [renamed] = manager.scanExtensions('user')
    expect(manager.duplicateExtension(renamed as never, 'global').ok).toBe(true)
    expect(existsSync(join(manager.getGlobalExtPath(), 'renamed/index.js'))).toBe(true)
    expect(existsSync(join(manager.getUserExtPath(), 'renamed/index.js'))).toBe(true)
  })

  it('删除：路径不在声明的受管目录中时拒绝', () => {
    setupInstalledSt()
    const manager = makeManager()
    const result = manager.deleteExtension({
      name: 'evil',
      path: join(baseDir, 'elsewhere'),
      extType: 'global',
      manifest: null,
      isValid: true,
      errorMsg: '',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('删除扩展失败')
  })

  it('删除：正常删除受管扩展', () => {
    setupInstalledSt()
    const manager = makeManager()
    mkdirSync(join(manager.getUserExtPath(), 'gone'), { recursive: true })
    writeFileSync(join(manager.getUserExtPath(), 'gone/index.js'), '// x', 'utf8')
    const [ext] = manager.scanExtensions('user')
    expect(manager.deleteExtension(ext as never).ok).toBe(true)
    expect(existsSync(join(manager.getUserExtPath(), 'gone'))).toBe(false)
  })
})

describe('isZipFile 魔数检查（← zipfile.is_zipfile 等价）', () => {
  it('接受 fflate 生成的 zip，拒绝普通文件', () => {
    const manager = makeManager()
    const good = join(baseDir, 'good.zip')
    writeFileSync(good, zipSync({ 'a.txt': Buffer.from('x', 'utf8') }))
    expect(manager.isZipFile(good)).toBe(true)
    const bad = join(baseDir, 'bad.zip')
    writeFileSync(bad, Buffer.from('nope'))
    expect(manager.isZipFile(bad)).toBe(false)
  })
})

describe('真实 fflate 往返（与 sync server 共用管线）', () => {
  it('zipSync → unzipSync 内容一致', () => {
    const zipped = zipSync({ 'dir/file.txt': Buffer.from('hello 中文', 'utf8') })
    const unzipped = unzipSync(zipped)
    expect(Buffer.from(unzipped['dir/file.txt'] as Uint8Array).toString('utf8')).toBe('hello 中文')
  })
})

// ---------------------------------------------------------------------------
// 单例 getExtensionManager：晚到的 log 选项生效（Bug#7：first-wins 吞日志）
// ---------------------------------------------------------------------------

describe('getExtensionManager 单例（晚到 log 选项）', () => {
  afterEach(() => {
    __resetExtensionManagerForTests()
  })

  it('先以无 log 创建，再传 log → 后续操作日志进新回调', () => {
    setupInstalledSt()
    // 首次创建（无 log，模拟视图先到）；随后对话框传入 log
    const first = getExtensionManager({ baseDir })
    const messages: string[] = []
    const second = getExtensionManager({ baseDir, log: (message) => messages.push(message) })
    expect(second).toBe(first)

    mkdirSync(join(second.getUserExtPath(), 'late-log'), { recursive: true })
    writeFileSync(join(second.getUserExtPath(), 'late-log/index.js'), '// x', 'utf8')
    const [ext] = second.scanExtensions('user')
    expect(second.deleteExtension(ext as never).ok).toBe(true)
    expect(messages.some((message) => message.includes('已删除扩展: late-log'))).toBe(true)
  })
})
