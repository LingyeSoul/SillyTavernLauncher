/**
 * ← tests/test_git_utils.py（GitCommandSecurityTests）语义等价移植 + 扩展：
 * 真实 repo fixture（mkdtemp）、注入校验、tag 过滤排序、状态检查、
 * 远程切换、merge 冲突清理。全部走 runGit 数组参数（绝不 shell 拼接）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMIT_HASH_RE,
  GIT_SCHANNEL_FALLBACK_ARGS,
  TAG_NAME_RE,
  checkGitStatus,
  checkoutStTag,
  checkoutStVersion,
  cleanupGitState,
  getCurrentCommit,
  getStTags,
  isGitSslFailure,
  runGit,
  switchGitRemote,
  type GitExecutor,
} from '../services/git'

const GIT = { gitExecutable: 'git' } as const

let repoDir: string

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'stl-git-'))
})

afterEach(() => {
  rmSync(repoDir, { force: true, recursive: true })
})

/** 初始化测试仓库：release 分支 + 若干提交 */
async function initRepo(): Promise<void> {
  await runGit(['init', '-b', 'release'], repoDir, GIT)
  await runGit(['config', 'user.email', 'test@example.com'], repoDir, GIT)
  await runGit(['config', 'user.name', 'Test'], repoDir, GIT)
  await runGit(['config', 'commit.gpgsign', 'false'], repoDir, GIT)
}

async function commitFile(name: string, content: string, message: string): Promise<string> {
  writeFileSync(join(repoDir, name), content, 'utf8')
  await runGit(['add', name], repoDir, GIT)
  const result = await runGit(['commit', '-m', message], repoDir, GIT)
  expect(result.ok).toBe(true)
  const head = await runGit(['rev-parse', 'HEAD'], repoDir, GIT)
  return head.stdout.trim()
}

describe('注入正则（← _COMMIT_HASH_RE / _TAG_NAME_RE）', () => {
  it('commit hash 白名单', () => {
    expect(COMMIT_HASH_RE.test('abc1234')).toBe(true)
    expect(COMMIT_HASH_RE.test('a'.repeat(40))).toBe(true)
    expect(COMMIT_HASH_RE.test('ABC1234')).toBe(false) // 大写拒绝
    expect(COMMIT_HASH_RE.test('abc; rm -rf /')).toBe(false)
    expect(COMMIT_HASH_RE.test('../../etc/passwd')).toBe(false)
    expect(COMMIT_HASH_RE.test('abc12')).toBe(false) // 少于 7 位
  })

  it('tag 名白名单（斜杠不在白名单，天然拒绝路径穿越）', () => {
    expect(TAG_NAME_RE.test('1.13.0')).toBe(true)
    expect(TAG_NAME_RE.test('v1.13.0-beta.1')).toBe(true)
    expect(TAG_NAME_RE.test('../evil')).toBe(false)
    expect(TAG_NAME_RE.test('..\\evil')).toBe(false)
    expect(TAG_NAME_RE.test('a b')).toBe(false)
    expect(TAG_NAME_RE.test('a;calc.exe')).toBe(false)
  })
})

describe('runGit（← run_git_command，数组参数、绝不 shell）', () => {
  it('提交信息携带 shell 元字符也按字面量处理', async () => {
    await initRepo()
    // 若发生 shell 拼接，下面的消息会被拆分/执行导致提交失败或内容变化
    const nasty = 'a; b & c | d `e` $(f) >out <in'
    const hash = await commitFile('safe.txt', '1', nasty)
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    const log = await runGit(['log', '-1', '--pretty=format:%s'], repoDir, GIT)
    expect(log.stdout.trim()).toBe(nasty)
  })

  it('cwd 不存在时返回失败而不抛出', async () => {
    const result = await runGit(['status'], join(repoDir, 'nope'), GIT)
    expect(result.ok).toBe(false)
  })
})

describe('runGit SSL 回退（Windows 系统证书库 / schannel）', () => {
  const SSL_STDERR =
    "fatal: unable to access 'https://github.com/SillyTavern/SillyTavern.git/': " +
    'SSL certificate problem: unable to get local issuer certificate'

  it('isGitSslFailure：openssl 后端的证书信任链失败特征', () => {
    expect(isGitSslFailure(SSL_STDERR)).toBe(true)
    expect(isGitSslFailure('fatal: unable to access https://x/: server certificate verification failed. CAfile')).toBe(true)
    expect(isGitSslFailure("fatal: unable to access 'https://x/': SSL certificate problem: self-signed certificate in certificate chain")).toBe(true)
    expect(isGitSslFailure('error: pathspec did not match')).toBe(false)
    expect(isGitSslFailure('')).toBe(false)
  })

  it('证书失败 → 追加 schannel 参数重试一次并返回重试结果', async () => {
    const calls: string[][] = []
    const executor: GitExecutor = async (cmd, _cwd) => {
      calls.push(cmd)
      if (cmd.includes('http.sslBackend=schannel')) {
        return { exitCode: 0, stdout: 'refs', stderr: '', ok: true }
      }
      return { exitCode: 1, stdout: '', stderr: SSL_STDERR, ok: false }
    }
    const result = await runGit(['ls-remote', 'origin'], repoDir, { ...GIT, executor })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
    // 回退参数必须夹在 git 与子命令之间（git -c k=v ls-remote）
    expect(calls[1]?.slice(0, GIT_SCHANNEL_FALLBACK_ARGS.length + 1)).toEqual([
      'git',
      ...GIT_SCHANNEL_FALLBACK_ARGS,
    ])
    expect(calls[1]?.slice(GIT_SCHANNEL_FALLBACK_ARGS.length + 1)).toEqual(['ls-remote', 'origin'])
  })

  it('非证书失败不触发重试', async () => {
    const executor: GitExecutor = vi.fn(async () => ({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: 'origin' does not appear to be a git repository",
      ok: false,
    }))
    const result = await runGit(['fetch', 'origin'], repoDir, { ...GIT, executor })
    expect(result.ok).toBe(false)
    expect(executor).toHaveBeenCalledTimes(1)
  })
})

describe('getStTags（← get_st_tags）', () => {
  it('≥1.13.0 语义化版本过滤、v 前缀归一、最新版排序', async () => {
    await initRepo()
    const c1 = await commitFile('a.txt', '1', 'c1')
    await runGit(['tag', '1.12.9'], repoDir, GIT) // 低于 1.13.0 → 排除
    const c2 = await commitFile('a.txt', '2', 'c2')
    await runGit(['tag', '1.13.0'], repoDir, GIT)
    const c3 = await commitFile('a.txt', '3', 'c3')
    await runGit(['tag', 'v1.14.2'], repoDir, GIT)
    const c4 = await commitFile('a.txt', '4', 'c4')
    await runGit(['tag', 'v1.15.0'], repoDir, GIT)
    await runGit(['tag', 'junk-tag'], repoDir, GIT) // 非语义化 → 排除
    await runGit(['tag', '1.13.0-beta.1'], repoDir, GIT)

    const result = await getStTags(repoDir, GIT)
    expect(result.ok).toBe(true)
    const versions = result.data?.versions ?? {}
    // 注意（Python 语义一致）：version_gte_1_13_0 对完整版本串 split('.')，
    // 预发布 tag（如 1.13.0-beta.1）第三段为 "0-beta" 无法取整 → 被排除。
    expect(Object.keys(versions).sort()).toEqual(['1.13.0', '1.14.2', '1.15.0'].sort())
    expect(result.data?.latest).toBe('1.15.0')
    expect(versions['1.13.0']).toMatchObject({ commit: c2, tag_name: '1.13.0' })
    expect(versions['1.14.2']).toMatchObject({ commit: c3, tag_name: 'v1.14.2' })
    expect(versions['1.15.0']).toMatchObject({ commit: c4, tag_name: 'v1.15.0' })
    for (const v of Object.values(versions)) {
      expect(v.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(v.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
    void c1
  })

  it('非 git 目录返回失败消息', async () => {
    mkdirSync(repoDir, { recursive: true })
    const result = await getStTags(repoDir, GIT)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('SillyTavern目录不是Git仓库')
  })
})

describe('checkoutStVersion（← checkout_st_version）', () => {
  it('恶意 commit hash 在执行任何 git 命令前被拒绝', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    for (const evil of ['abc; rm -rf /', '../../etc/passwd', 'HEAD~1', 'ABCDEF123']) {
      const result = await checkoutStVersion(evil, repoDir, GIT)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('无效的 commit hash 格式')
    }
    // HEAD 未被移动
    const head = await runGit(['rev-parse', 'HEAD'], repoDir, GIT)
    expect(head.ok).toBe(true)
  })

  it('在 release 分支上 reset 到旧 commit，保持分支不变', async () => {
    await initRepo()
    const first = await commitFile('a.txt', 'v1', 'c1')
    await commitFile('a.txt', 'v2', 'c2')

    const result = await checkoutStVersion(first, repoDir, GIT)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('release分支上')

    const head = await runGit(['rev-parse', 'HEAD'], repoDir, GIT)
    expect(head.stdout.trim()).toBe(first)
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir, GIT)
    expect(branch.stdout.trim()).toBe('release')
    // 文件内容回到 v1
    expect(readFileSync(join(repoDir, 'a.txt'), 'utf8')).toBe('v1')
  })

  it('工作区有非 package-lock 改动时先 stash', async () => {
    await initRepo()
    const first = await commitFile('a.txt', 'v1', 'c1')
    await commitFile('a.txt', 'v2', 'c2')
    // stash push 默认不含未跟踪文件——先提交再修改，才是 stash 场景
    await commitFile('dirty.txt', 'clean', 'add dirty')
    writeFileSync(join(repoDir, 'dirty.txt'), 'user data', 'utf8')

    const result = await checkoutStVersion(first, repoDir, GIT)
    expect(result.ok).toBe(true)
    // stash 中保存了一条记录
    const stash = await runGit(['stash', 'list'], repoDir, GIT)
    expect(stash.stdout).toContain('版本切换前保存')
    // 工作区回到干净状态
    const status = await checkGitStatus(repoDir, GIT)
    expect(status.ok).toBe(true)
  })

  it('不存在的 commit 返回带建议的错误', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    const result = await checkoutStVersion('1234567890abcdef1234567890abcdef12345678', repoDir, GIT)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('在远程仓库中不存在')
  })
})

describe('checkoutStTag（← checkout_st_tag）', () => {
  it('恶意 tag 名被正则拒绝', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    for (const evil of ['../evil', 'a b', 'a;b', 'x|y']) {
      const result = await checkoutStTag(evil, repoDir, GIT)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('无效的 tag 名称格式')
    }
  })

  it('切换到存在的 tag，HEAD 指向 tag commit', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    const tagged = await commitFile('a.txt', '2', 'c2')
    await runGit(['tag', '1.13.0'], repoDir, GIT)
    await commitFile('a.txt', '3', 'c3')

    const result = await checkoutStTag('1.13.0', repoDir, GIT)
    expect(result.ok).toBe(true)
    const head = await runGit(['rev-parse', 'HEAD'], repoDir, GIT)
    expect(head.stdout.trim()).toBe(tagged)
  })

  it('不存在的 tag 返回提示', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    const result = await checkoutStTag('9.9.9', repoDir, GIT)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('不存在')
  })
})

describe('checkGitStatus（← check_git_status）', () => {
  it('干净工作区', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    const result = await checkGitStatus(repoDir, GIT)
    expect(result).toEqual({ ok: true, message: '工作区干净' })
  })

  it('普通文件改动 → 不干净', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    writeFileSync(join(repoDir, 'a.txt'), 'changed', 'utf8')
    const result = await checkGitStatus(repoDir, GIT)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('1个文件')
  })

  it('仅 package-lock.json 改动 → 自动恢复并报告干净', async () => {
    await initRepo()
    await commitFile('package-lock.json', '{"lock":1}', 'lock')
    writeFileSync(join(repoDir, 'package-lock.json'), '{"lock":2}', 'utf8')
    const result = await checkGitStatus(repoDir, GIT)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('已自动恢复package-lock.json')
    expect(readFileSync(join(repoDir, 'package-lock.json'), 'utf8')).toBe('{"lock":1}')
  })
})

describe('getCurrentCommit（← get_current_commit）', () => {
  it('返回 40 位完整 hash', async () => {
    await initRepo()
    const hash = await commitFile('a.txt', '1', 'c1')
    const result = await getCurrentCommit(repoDir, GIT)
    expect(result.ok).toBe(true)
    expect(result.commit).toBe(hash)
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('switchGitRemote（← switch_git_remote）', () => {
  it('远程统一设置为 GitHub 原始仓库', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    await runGit(['remote', 'add', 'origin', 'https://example.com/mirror.git'], repoDir, GIT)

    const result = await switchGitRemote('gh-proxy.org', repoDir, GIT)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('gh-proxy.org镜像')
    const url = await runGit(['remote', 'get-url', 'origin'], repoDir, GIT)
    expect(url.stdout.trim()).toBe('https://github.com/SillyTavern/SillyTavern.git')
  })

  it('目录不存在与非 git 目录分别返回对应消息', async () => {
    const missing = await switchGitRemote('github', join(repoDir, 'missing'), GIT)
    expect(missing).toEqual({ ok: false, message: 'SillyTavern目录不存在' })
    // repoDir 由 mkdtemp 创建（存在但非 git 仓库）
    const notRepo = await switchGitRemote('github', repoDir, GIT)
    expect(notRepo).toEqual({ ok: false, message: 'SillyTavern目录不是Git仓库' })
  })
})

describe('cleanupGitState（← cleanup_git_state）', () => {
  it('真实 merge 冲突：中止 merge、reset --hard、标志文件清空', async () => {
    await initRepo()
    writeFileSync(join(repoDir, 'conflict.txt'), 'base\n', 'utf8')
    await runGit(['add', 'conflict.txt'], repoDir, GIT)
    await runGit(['commit', '-m', 'base'], repoDir, GIT)

    await runGit(['checkout', '-b', 'feature'], repoDir, GIT)
    writeFileSync(join(repoDir, 'conflict.txt'), 'feature\n', 'utf8')
    await runGit(['commit', '-am', 'feature change'], repoDir, GIT)

    await runGit(['checkout', 'release'], repoDir, GIT)
    writeFileSync(join(repoDir, 'conflict.txt'), 'main\n', 'utf8')
    await runGit(['commit', '-am', 'main change'], repoDir, GIT)

    const merge = await runGit(['merge', 'feature'], repoDir, GIT)
    expect(merge.ok).toBe(false)
    expect(existsSync(join(repoDir, '.git', 'MERGE_HEAD'))).toBe(true)

    const result = await cleanupGitState(repoDir, GIT)
    expect(result.ok).toBe(true)
    expect(result.message).toBe('Git状态清理成功')
    expect(existsSync(join(repoDir, '.git', 'MERGE_HEAD'))).toBe(false)
    const status = await runGit(['status', '--porcelain'], repoDir, GIT)
    expect(status.stdout.trim()).toBe('')
  })

  it('干净仓库与不存在目录的短路返回', async () => {
    expect(await cleanupGitState(join(repoDir, 'missing'), GIT)).toEqual({
      ok: true,
      message: 'SillyTavern目录不存在，无需清理',
    })
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    expect(await cleanupGitState(repoDir, GIT)).toEqual({
      ok: true,
      message: 'Git状态干净，无需清理',
    })
  })

  it('伪造的 MERGE_HEAD 由清理流程移除（reset --hard 同样清理 merge 状态文件）', async () => {
    await initRepo()
    await commitFile('a.txt', '1', 'c1')
    writeFileSync(join(repoDir, '.git', 'MERGE_HEAD'), '0'.repeat(40), 'utf8')
    const result = await cleanupGitState(repoDir, GIT)
    // 现代 git 中 merge --abort 报错后，reset --hard 也会移除 MERGE_HEAD，
    // 验证步骤通过——与 Python 实现在同一 git 版本下行为一致。
    expect(result.ok).toBe(true)
    expect(existsSync(join(repoDir, '.git', 'MERGE_HEAD'))).toBe(false)
  })
})
