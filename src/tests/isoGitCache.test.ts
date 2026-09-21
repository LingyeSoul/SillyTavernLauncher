/**
 * 版本页数据源的缓存接线门禁（2026-09-21 版本页「未安装」实测根因）。
 *
 * 背景：isomorphic-git 的每个命令各收一个 cache 对象，不传即每次调用新建空 cache
 * ——每次对象读取都要整读并解析 pack 索引（ST 仓库 .idx 2.46MB）+ 整读 pack 文件。
 * 实测单次 tag 解析 295ms × 103 个 tag = 29s，叠加全历史回溯共 40s+ 才出数；期间
 * 「当前版本」恒空 → 版本页头部误显「未安装」。操作内共享后同组调用 0.5s。
 *
 * 同时锁死生命周期另一头：缓存里是 pack 缓冲与解压对象（ST 仓库实测常驻 440MB
 * ArrayBuffer），读操作全部结束必须释放——否则启动器进程长期钉住数百 MB。
 *
 * 断言策略（AGENTS：性能门禁用结构性断言，不用耗时断言）：包装真 isomorphic-git，
 * 记录对象读取类调用收到的 cache 参数——不依赖机器性能，也不会因机器快而漏判。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGit } from '../services/git'

const GIT = { gitExecutable: 'git' } as const

/** 记录到的对象读取类调用（仅应用代码的直接调用；iso 内部调用不经导出包装） */
const recorded: Array<{ fn: string; cache: unknown }> = []

vi.mock('isomorphic-git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('isomorphic-git')>()
  const wrap = <A, R>(name: string, fn: (args: A) => Promise<R>) => {
    return async (args: A): Promise<R> => {
      recorded.push({ fn: name, cache: (args as { cache?: unknown }).cache })
      return fn(args)
    }
  }
  return {
    ...actual,
    readObject: wrap('readObject', actual.readObject),
    readCommit: wrap('readCommit', actual.readCommit),
    readTag: wrap('readTag', actual.readTag),
    log: wrap('log', actual.log),
    statusMatrix: wrap('statusMatrix', actual.statusMatrix),
    listFiles: wrap('listFiles', actual.listFiles),
  }
})

const { currentVersionEmbedded, getStTagsEmbedded } = await import('../services/isoGit')

let workDir: string

beforeEach(() => {
  recorded.length = 0
  workDir = mkdtempSync(join(tmpdir(), 'stl-isocache-'))
})

afterEach(() => {
  rmSync(workDir, { force: true, recursive: true })
})

/** 本地仓库：HEAD 领先一个带 tag 的提交（对象打一次 pack，走 packfile 索引路径） */
async function initRepo(): Promise<string> {
  const repoDir = join(workDir, 'SillyTavern')
  mkdirSync(repoDir, { recursive: true })
  await runGit(['init', '-b', 'release'], repoDir, GIT)
  await runGit(['config', 'user.email', 'test@example.com'], repoDir, GIT)
  await runGit(['config', 'user.name', 'Test'], repoDir, GIT)
  await runGit(['config', 'commit.gpgsign', 'false'], repoDir, GIT)
  writeFileSync(join(repoDir, 'README.md'), 'v1\n', 'utf8')
  await runGit(['add', '.'], repoDir, GIT)
  await runGit(['commit', '-m', 'c1'], repoDir, GIT)
  await runGit(['tag', '1.14.0'], repoDir, GIT)
  writeFileSync(join(repoDir, 'README.md'), 'v2\n', 'utf8')
  await runGit(['add', '.'], repoDir, GIT)
  await runGit(['commit', '-m', 'c2'], repoDir, GIT) // HEAD 在 tag 之后
  // 打包对象：packfile 索引缓存只在读打包对象时产生（松散对象不走索引）
  await runGit(['repack', '-a', '-d', '-q'], repoDir, GIT)
  return repoDir
}

/** 记录里出现过的 cache 实例集合（同一实例 = 共享，多实例 = 各自重读 pack 索引） */
function cacheInstances(): Set<unknown> {
  return new Set(recorded.map((call) => call.cache))
}

describe('isoReadCache：操作内共享、操作结束释放、并发共用一份', () => {
  it('单次版本读取内的对象读取共享同一 cache 实例（不共享 = 每次重读 pack 索引）', async () => {
    const repoDir = await initRepo()

    const current = await currentVersionEmbedded(repoDir)
    expect(current.version).toBe('1.14.0')
    expect(recorded.length, '版本读取必须发生对象读取（否则用例失效）').toBeGreaterThanOrEqual(2)
    for (const call of recorded) {
      expect(call.cache, `${call.fn} 未携带共享 cache（每次调用会重读 pack 索引）`).not.toBeUndefined()
    }
    expect(cacheInstances().size, '单次读取内必须只有一个 cache 实例').toBe(1)

    recorded.length = 0
    const tags = await getStTagsEmbedded(repoDir)
    expect(tags.ok).toBe(true)
    expect(recorded.length).toBeGreaterThan(0)
    expect(cacheInstances().size, '版本列表读取内必须只有一个 cache 实例').toBe(1)
  })

  it('并发读操作共用同一实例；全部结束即释放（pack 缓冲不常驻进程）', async () => {
    const repoDir = await initRepo()

    // 版本页挂载两路并行：共用一份 pack 缓冲（各持一份 = 双份内存）
    const [current, tags] = await Promise.all([
      currentVersionEmbedded(repoDir),
      getStTagsEmbedded(repoDir),
    ])
    expect(current.version).toBe('1.14.0')
    expect(tags.ok).toBe(true)
    expect(cacheInstances().size).toBe(1)

    // 操作全部结束 → 缓存归零（下一次读取重新建：读到的仍是内容寻址的新 pack）
    const cache = recorded.at(-1)?.cache as Record<string | symbol, unknown>
    expect(Reflect.ownKeys(cache).length, '最后一个读操作结束须释放缓存').toBe(0)

    recorded.length = 0
    const again = await currentVersionEmbedded(repoDir)
    expect(again.version).toBe('1.14.0')
    expect(cacheInstances().size).toBe(1)
    expect(Reflect.ownKeys(recorded.at(-1)?.cache as object).length).toBe(0)
  })
})
