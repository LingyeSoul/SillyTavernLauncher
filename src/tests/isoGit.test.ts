/**
 * IsoGit 服务测试（Embedded-All 设计计划 §8，Phase 4）——全部离线：
 * - fetch 桥接插件契约：body 异步迭代器收集、响应流转迭代器、响应头小写化、
 *   TLS 失败回退重试一次（mock fetch 注入，不打网络）；
 * - 镜像 URL 前缀（D6）；
 * - porcelain 合成（statusMatrix 映射表）；
 * - SpawnGitOps 命令串逐字节一致（D3）；
 * - IsoGitOps 本地操作与系统 git 的 porcelain 等价性（真实本地仓库，无网络——
 *   即设计计划 Phase 0 遗留的等价性冒烟，收编为常驻回归用例）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHttpRequest, StatusRow } from 'isomorphic-git'
import {
  IsoGitOps,
  applyStMirrorPrefix,
  createIsoFetchPlugin,
  createSpawnGitOps,
  synthesizePorcelain,
  type SpawnCommandExecutor,
} from '../services/isoGit'
import { runGit } from '../services/git'

const GIT = { gitExecutable: 'git' } as const

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'stl-iso-'))
})

afterEach(() => {
  rmSync(workDir, { force: true, recursive: true })
})

// ---------------------------------------------------------------------------
// fetch 桥接插件契约（mock fetch 注入，不打网络）
// ---------------------------------------------------------------------------

/** 构造异步迭代器（模拟 isomorphic-git 的请求 body 形态） */
function asyncIterOf(chunks: Uint8Array[]): AsyncIterableIterator<Uint8Array> {
  let index = 0
  return {
    async next() {
      if (index >= chunks.length) return { value: undefined, done: true as const }
      const value = chunks[index]
      index += 1
      return { value, done: false as const }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

function fakeResponse(options: {
  status?: number
  headers?: Record<string, string>
  body?: Uint8Array[]
}): Response {
  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of options.body ?? []) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(bodyStream, {
    status: options.status ?? 200,
    headers: new Headers(options.headers ?? {}),
  })
}

/** TLS 信任链错误（httpClient.isTlsVerifyError 的匹配形态之一） */
function tlsVerifyError(): Error {
  return Object.assign(new Error('unable to verify the first certificate'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  })
}

describe('fetch 桥接插件（F5/F6 契约）', () => {
  it('请求 body 异步迭代器收集为单个 Uint8Array（Content-Length 语义）', async () => {
    const seenBodies: Array<Uint8Array | undefined> = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBodies.push(init?.body as Uint8Array | undefined)
      return fakeResponse({ body: [new Uint8Array([0x00, 0x01])] })
    })
    const plugin = createIsoFetchPlugin({ fetchImpl })
    const request: GitHttpRequest = {
      url: 'https://example.com/repo.git/info/refs?service=git-upload-pack',
      method: 'POST',
      body: asyncIterOf([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5]),
        new Uint8Array([]), // 空分块应被跳过
      ]),
    }
    await plugin.request(request)
    expect(seenBodies).toHaveLength(1)
    expect(Array.from(seenBodies[0] ?? [])).toEqual([1, 2, 3, 4, 5])
  })

  it('请求 body 数组形态（iso 1.42.2 实际传入 `body: [packbuffer]`）同样收集合并', async () => {
    const seenBodies: Array<Uint8Array | undefined> = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBodies.push(init?.body as Uint8Array | undefined)
      return fakeResponse({ body: [new Uint8Array([0x00])] })
    })
    const plugin = createIsoFetchPlugin({ fetchImpl })
    await plugin.request({
      url: 'https://example.com/repo.git/git-upload-pack',
      method: 'POST',
      // 运行时真实形态：Uint8Array 数组（.d.ts 声明滞后；桥接层两者兼容）
      body: [new Uint8Array([9, 9]), new Uint8Array([8])] as unknown as AsyncIterableIterator<Uint8Array>,
    })
    expect(Array.from(seenBodies[0] ?? [])).toEqual([9, 9, 8])
  })

  it('响应 body ReadableStream 转异步迭代器：分块顺序与拼接内容一致', async () => {
    const plugin = createIsoFetchPlugin({
      fetchImpl: async () =>
        fakeResponse({
          body: [new Uint8Array([10, 11]), new Uint8Array([12]), new Uint8Array([13, 14, 15])],
        }),
    })
    const response = await plugin.request({ url: 'https://example.com/x', method: 'GET' })
    const collected: number[] = []
    for await (const chunk of response.body ?? []) {
      collected.push(...chunk)
    }
    expect(collected).toEqual([10, 11, 12, 13, 14, 15])
  })

  it('响应头小写化 + 状态码/状态文案透传', async () => {
    const plugin = createIsoFetchPlugin({
      fetchImpl: async () =>
        fakeResponse({ status: 404, headers: { 'Content-Type': 'text/plain', 'X-Custom': 'V' } }),
    })
    const response = await plugin.request({ url: 'https://example.com/x' })
    expect(response.statusCode).toBe(404)
    expect(response.headers).toEqual({ 'content-type': 'text/plain', 'x-custom': 'V' })
  })

  it('TLS 校验失败 → 系统证书库 ca 注入重试恰好一次（tls: { ca } 形态）', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init: init ?? {} })
      if (calls.length === 1) throw tlsVerifyError()
      return fakeResponse({ body: [new Uint8Array([9])] })
    })
    const plugin = createIsoFetchPlugin({
      fetchImpl: fetchImpl as never,
      caProvider: async () => '-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----',
    })
    const response = await plugin.request({ url: 'https://github.com/x.git', method: 'GET' })
    expect(response.statusCode).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // 第二次调用携带 Bun 私有 tls.ca 扩展
    const tls = calls[1]?.init['tls'] as { ca?: string } | undefined
    expect(tls?.ca).toContain('BEGIN CERTIFICATE')
    // 第一次调用无 tls 注入
    expect(calls[0]?.init['tls']).toBeUndefined()
  })

  it('非 TLS 错误不重试，原样上抛（fetchImpl 仅一次调用）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND')
    })
    const plugin = createIsoFetchPlugin({ fetchImpl: fetchImpl as never })
    await expect(plugin.request({ url: 'https://x' })).rejects.toThrow('ENOTFOUND')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('TLS 回退也失败 → TlsInterceptError 语义上抛（httpClient 现有策略复用）', async () => {
    const plugin = createIsoFetchPlugin({
      fetchImpl: async () => {
        throw tlsVerifyError()
      },
      caProvider: async () => null, // 导出失败（非 Windows 恒 null 形态）
    })
    await expect(plugin.request({ url: 'https://x' })).rejects.toThrow('网络证书校验失败')
  })
})

// ---------------------------------------------------------------------------
// 镜像 URL 前缀（D6：与 extensions.applyGithubMirror 同构）
// ---------------------------------------------------------------------------

describe('applyStMirrorPrefix（D6 内存前缀）', () => {
  const ST_URL = 'https://github.com/SillyTavern/SillyTavern.git'
  it('github → 原样；已知镜像 → 前缀拼接', () => {
    expect(applyStMirrorPrefix(ST_URL, 'github')).toBe(ST_URL)
    expect(applyStMirrorPrefix(ST_URL, 'gh-proxy.org')).toBe(`https://gh-proxy.org/${ST_URL}`)
    expect(applyStMirrorPrefix(ST_URL, 'gh.llkk.cc')).toBe(`https://gh.llkk.cc/${ST_URL}`)
  })
  it('非 GitHub 域与未知镜像名 → 原样返回（不加速）', () => {
    expect(applyStMirrorPrefix('https://example.com/x.git', 'gh-proxy.org')).toBe(
      'https://example.com/x.git',
    )
    expect(applyStMirrorPrefix(ST_URL, 'unknown.mirror')).toBe(ST_URL)
  })
})

// ---------------------------------------------------------------------------
// porcelain 合成（statusMatrix → git status --porcelain 映射表）
// ---------------------------------------------------------------------------

describe('synthesizePorcelain（映射表）', () => {
  it('核心形态：干净 / 修改未暂存 / 修改已暂存 / 未跟踪 / 删除未暂存 / 新增已暂存', () => {
    const matrix: StatusRow[] = [
      ['a.txt', 1, 1, 1], // 干净 → 不输出
      ['b.txt', 1, 2, 1], // 修改未暂存 → ' M'
      ['c.txt', 1, 2, 2], // 修改已暂存 → 'M '
      ['d.txt', 0, 2, 0], // 未跟踪 → '??'
      ['e.txt', 1, 0, 1], // 删除未暂存 → ' D'
      ['f.txt', 0, 2, 2], // 新增已暂存 → 'A '
      ['g.txt', 1, 2, 3], // 修改 + 二次修改 → 'MM'
    ]
    // 输出分区对齐 git：跟踪区（路径序）在前，未跟踪在后
    expect(synthesizePorcelain(matrix)).toEqual([
      ' M b.txt',
      'M  c.txt',
      ' D e.txt',
      'A  f.txt',
      'MM g.txt',
      '?? d.txt',
    ])
  })

  it('输出分区排序：跟踪区（路径序）在前，未跟踪（??，路径序）在后——对齐 git', () => {
    const matrix: StatusRow[] = [
      ['z.txt', 1, 2, 1], // 跟踪区
      ['B.txt', 0, 2, 0], // 未跟踪
      ['a.txt', 0, 2, 0], // 未跟踪
    ]
    expect(synthesizePorcelain(matrix)).toEqual([' M z.txt', '?? B.txt', '?? a.txt'])
  })

  it('输出按路径字节序排序（对齐 git porcelain 顺序）', () => {
    const matrix: StatusRow[] = [
      ['z.txt', 0, 2, 0],
      ['B.txt', 0, 2, 0],
      ['a.txt', 0, 2, 0],
    ]
    expect(synthesizePorcelain(matrix)).toEqual(['?? B.txt', '?? a.txt', '?? z.txt'])
  })
})

// ---------------------------------------------------------------------------
// SpawnGitOps（D3：命令串逐字节一致）
// ---------------------------------------------------------------------------

describe('createSpawnGitOps（D3 命令串焊死）', () => {
  function harness(exec: SpawnCommandExecutor): { ops: ReturnType<typeof createSpawnGitOps>; calls: Array<{ command: string; cwd: string }> } {
    const calls: Array<{ command: string; cwd: string }> = []
    const wrapped: SpawnCommandExecutor = async (command, cwd) => {
      calls.push({ command, cwd })
      return exec(command, cwd)
    }
    return { ops: createSpawnGitOps({ gitExe: 'C:/fake/git.exe', execCommand: wrapped }), calls }
  }

  it('cloneRelease：与 buildGitCloneCommand 逐字节一致，cwd 为目标目录父级', async () => {
    const { ops, calls } = harness(async () => 0)
    const result = await ops.cloneRelease(
      'https://github.com/SillyTavern/SillyTavern.git',
      join(workDir, 'SillyTavern'),
    )
    expect(result.ok).toBe(true)
    expect(calls).toEqual([
      {
        command:
          '"C:/fake/git.exe" clone https://github.com/SillyTavern/SillyTavern.git -b release',
        cwd: workDir,
      },
    ])
  })

  it('pullFastForward / fetchOrigin：与 buildGitPullCommand / fetch --all 逐字节一致', async () => {
    const { ops, calls } = harness(async () => 0)
    await ops.pullFastForward(join(workDir, 'SillyTavern'))
    await ops.fetchOrigin(join(workDir, 'SillyTavern'))
    expect(calls.map((call) => call.command)).toEqual([
      '"C:/fake/git.exe" pull --rebase --autostash',
      '"C:/fake/git.exe" fetch --all',
    ])
    expect(calls.every((call) => call.cwd === join(workDir, 'SillyTavern'))).toBe(true)
  })

  it('进程创建失败（exitCode=null）与退出码失败透传', async () => {
    const nullOps = createSpawnGitOps({ gitExe: 'g', execCommand: async () => null })
    expect(await nullOps.fetchOrigin(workDir)).toEqual({
      ok: false,
      message: '创建git进程失败',
      exitCode: null,
    })
    const failOps = createSpawnGitOps({ gitExe: 'g', execCommand: async () => 128 })
    const result = await failOps.fetchOrigin(workDir)
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(128)
  })
})

// ---------------------------------------------------------------------------
// IsoGitOps 本地操作：与系统 git 的 porcelain 等价性（真实本地仓库，无网络）
// ---------------------------------------------------------------------------

/** 初始化本地仓库（release 分支 + 2 个提交），返回仓库目录 */
async function initLocalRepo(): Promise<string> {
  const repoDir = join(workDir, 'SillyTavern')
  mkdirSync(repoDir, { recursive: true })
  await runGit(['init', '-b', 'release'], repoDir, GIT)
  await runGit(['config', 'user.email', 'test@example.com'], repoDir, GIT)
  await runGit(['config', 'user.name', 'Test'], repoDir, GIT)
  await runGit(['config', 'commit.gpgsign', 'false'], repoDir, GIT)
  writeFileSync(join(repoDir, 'a.txt'), 'v1\n', 'utf8')
  writeFileSync(join(repoDir, 'package-lock.json'), '{"lock":1}\n', 'utf8')
  await runGit(['add', '.'], repoDir, GIT)
  await runGit(['commit', '-m', 'c1'], repoDir, GIT)
  writeFileSync(join(repoDir, 'a.txt'), 'v2\n', 'utf8')
  await runGit(['add', '.'], repoDir, GIT)
  await runGit(['commit', '-m', 'c2'], repoDir, GIT)
  return repoDir
}

async function realPorcelain(repoDir: string): Promise<string> {
  const result = await runGit(['status', '--porcelain'], repoDir, GIT)
  // 只剥结尾换行——trim() 会吃掉首行的 XY 前导空格，掩盖形态差异
  return result.stdout.replace(/\n$/, '')
}

describe('IsoGitOps.statusPorcelain ↔ 系统 git status --porcelain 等价性（Phase 0 遗留冒烟收编）', () => {
  const ops = () => new IsoGitOps({ onLog: () => undefined })

  it('干净工作区：两侧均为空', async () => {
    const repoDir = await initLocalRepo()
    expect(await ops().statusPorcelain(repoDir)).toBe('')
    expect(await realPorcelain(repoDir)).toBe('')
  })

  it('修改已跟踪文件：两侧同为 " M a.txt"', async () => {
    const repoDir = await initLocalRepo()
    writeFileSync(join(repoDir, 'a.txt'), 'user edited\n', 'utf8')
    expect(await ops().statusPorcelain(repoDir)).toBe(' M a.txt')
    expect(await realPorcelain(repoDir)).toBe(' M a.txt')
  })

  it('新增未跟踪文件：两侧同为 "?? new.txt"（含 bun.lock 场景）', async () => {
    const repoDir = await initLocalRepo()
    writeFileSync(join(repoDir, 'new.txt'), 'x\n', 'utf8')
    writeFileSync(join(repoDir, 'bun.lock'), 'lockfile\n', 'utf8')
    const expected = '?? bun.lock\n?? new.txt'
    expect(await ops().statusPorcelain(repoDir)).toBe(expected)
    expect(await realPorcelain(repoDir)).toBe(expected)
  })

  it('bun.lock 写入 .git/info/exclude 后：两侧同时恢复干净（F4 消解等价）', async () => {
    const repoDir = await initLocalRepo()
    writeFileSync(join(repoDir, 'bun.lock'), 'lockfile\n', 'utf8')
    mkdirSync(join(repoDir, '.git', 'info'), { recursive: true })
    writeFileSync(join(repoDir, '.git', 'info', 'exclude'), 'bun.lock\n', 'utf8')
    expect(await ops().statusPorcelain(repoDir)).toBe('')
    expect(await realPorcelain(repoDir)).toBe('')
  })

  it('混合修改 + 未跟踪：与真 git 输出逐行一致（跟踪区前、未跟踪后的分区顺序）', async () => {
    const repoDir = await initLocalRepo()
    writeFileSync(join(repoDir, 'a.txt'), 'edited\n', 'utf8')
    writeFileSync(join(repoDir, 'zz-new.txt'), 'n\n', 'utf8')
    writeFileSync(join(repoDir, 'aa-new.txt'), 'n\n', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 1100)) // 跨 racy 窗口
    const expected = ' M a.txt\n?? aa-new.txt\n?? zz-new.txt'
    expect(await ops().statusPorcelain(repoDir)).toBe(expected)
    expect(await realPorcelain(repoDir)).toBe(expected)
  })

  it('暂存新文件（A）与删除已跟踪文件（D）形态一致', async () => {
    const repoDir = await initLocalRepo()
    writeFileSync(join(repoDir, 'staged.txt'), 's\n', 'utf8')
    await runGit(['add', 'staged.txt'], repoDir, GIT)
    rmSync(join(repoDir, 'a.txt'))
    const expected = ' D a.txt\nA  staged.txt' // 按路径字节序
    expect(await ops().statusPorcelain(repoDir)).toBe(expected)
    expect(await realPorcelain(repoDir)).toBe(expected)
  })

  it('仅 package-lock.json 被修改：两侧形态一致（白名单判定输入等价）', async () => {
    const repoDir = await initLocalRepo()
    writeFileSync(join(repoDir, 'package-lock.json'), '{"lock":22}\n', 'utf8')
    expect(await ops().statusPorcelain(repoDir)).toBe(' M package-lock.json')
    expect(await realPorcelain(repoDir)).toBe(' M package-lock.json')
  })

  it('racy 修补（未来 mtime 顶除）：同秒同尺寸改写立即确定性检出——两侧等价', async () => {
    const repoDir = await initLocalRepo()
    writeFileSync(join(repoDir, 'package-lock.json'), '{"lock":2}\n', 'utf8') // 与原内容同字节数
    // 背景（iso 1.42.2 上游缺口）：compareStats 秒级 stat + 同尺寸 → 复用暂存 oid，
    // 且误判不随时间自愈；真 git 按 racy-git.txt 强制重哈希。statusPorcelain 的
    // 修补 = listFiles 枚举 + mtime 顶到未来 +5s（与索引历史 stat 必差 ≥1 秒），
    // 同秒写入的改写也立即按真实内容重哈希——无需等待。
    expect(await ops().statusPorcelain(repoDir)).toBe(' M package-lock.json')
    expect(await realPorcelain(repoDir)).toBe(' M package-lock.json')
  })
})

describe('IsoGitOps 本地读操作（listTags / currentCommit / checkoutTag 脏检查）', () => {
  const ops = (): IsoGitOps => new IsoGitOps({ onLog: () => undefined })

  it('listTags 与 git tag -l 一致；currentCommit 与 rev-parse HEAD 一致', async () => {
    const repoDir = await initLocalRepo()
    await runGit(['tag', '1.13.0'], repoDir, GIT)
    await runGit(['tag', 'v1.14.0'], repoDir, GIT)
    expect(await ops().listTags(repoDir)).toEqual(['1.13.0', 'v1.14.0'])
    const head = await runGit(['rev-parse', 'HEAD'], repoDir, GIT)
    expect(await ops().currentCommit(repoDir)).toBe(head.stdout.trim())
  })

  it('checkoutTag：脏工作区拒绝；tag 名注入拒绝；白名单内放行并切到 tag（离线，对象已在本地）', async () => {
    const repoDir = await initLocalRepo()
    await runGit(['tag', '1.13.0'], repoDir, GIT)
    writeFileSync(join(repoDir, 'a.txt'), 'v3\n', 'utf8') // 移动 HEAD 后 tag 指向旧提交
    await runGit(['add', '.'], repoDir, GIT)
    await runGit(['commit', '-m', 'c3'], repoDir, GIT)

    // 脏工作区（非白名单）→ 拒绝
    writeFileSync(join(repoDir, 'a.txt'), 'dirty\n', 'utf8')
    const dirty = await ops().checkoutTag('1.13.0', repoDir)
    expect(dirty.ok).toBe(false)
    expect(dirty.message).toContain('未提交的更改')

    // 白名单内（仅 package-lock.json 修改）→ 放行
    writeFileSync(join(repoDir, 'a.txt'), 'v3\n', 'utf8')
    writeFileSync(join(repoDir, 'package-lock.json'), '{"lock":9}\n', 'utf8')
    const allowed = await ops().checkoutTag('1.13.0', repoDir)
    expect(allowed.ok).toBe(true)
    // 切换后 HEAD 指向 tag commit（detached），工作区与 tag 一致（package-lock 已覆盖恢复）
    const head = await runGit(['rev-parse', 'HEAD'], repoDir, GIT)
    const tagCommit = await runGit(['rev-parse', '1.13.0'], repoDir, GIT)
    expect(head.stdout.trim()).toBe(tagCommit.stdout.trim())
    expect(await realPorcelain(repoDir)).toBe('')

    // 注入拒绝
    const evil = await ops().checkoutTag('../evil', repoDir)
    expect(evil.ok).toBe(false)
    expect(evil.message).toContain('无效的 tag 名称格式')
  })
})

describe('IsoGitOps 镜像前缀接线（构造参数 getMirror）', () => {
  it('fetchOrigin 经镜像 URL 抓取（mock fetch 断言 URL，不打网络）', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      // 返回空 body 的 200 → isomorphic-git 会报协议错误，但 URL 断言已达成
      return fakeResponse({ body: [] })
    })
    const repoDir = await initLocalRepo()
    await runGit(['remote', 'add', 'origin', 'https://github.com/SillyTavern/SillyTavern.git'], repoDir, GIT)
    const ops = new IsoGitOps({
      fetchImpl: fetchImpl as never,
      caProvider: async () => null,
      getMirror: () => 'gh-proxy.org',
      onLog: () => undefined,
    })
    const result = await ops.fetchOrigin(repoDir)
    expect(result.ok).toBe(false) // 协议错误（空响应）→ 失败是预期
    expect(urls.length).toBeGreaterThan(0)
    expect(urls[0]).toBe(
      'https://gh-proxy.org/https://github.com/SillyTavern/SillyTavern.git/info/refs?service=git-upload-pack',
    )
  })
})
