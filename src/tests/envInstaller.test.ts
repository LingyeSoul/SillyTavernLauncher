/**
 * envInstaller 单测（零网络：fetchImpl 全程注入替身）：
 * - 下载源 URL 构建（镜像前缀改写 / Node 双源排序）纯函数直测；
 * - planEnvInstall 探测计划映射（whichFn 注入）；
 * - parseExpectedSha256 的 SHASUMS256.txt 解析；
 * - extractZipToDir：MinGit 扁平布局 / Node 顶层目录剥离 / Zip-Slip 拒绝 / 前缀失配拒绝；
 * - installEnvComponents 离线全链路：git+node 落地 env/、SHA 不匹配换源重试、
 *   git 全源失败不阻断 node（部分成功终态）、装后校验器失败上抛。
 *
 * 下载源 URL 与真实包布局的事实核验见 scripts 侧 2026-10-05 实测记录
 * （services/envInstaller.ts 头注释），此处只锁纯逻辑。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import {
  ENV_INSTALL_GIT_VERSION,
  ENV_INSTALL_NODE_VERSION,
  extractZipToDir,
  installEnvComponents,
  minGitDownloadUrls,
  nodeDownloadSources,
  parseExpectedSha256,
  planEnvInstall,
  type EnvInstallProgress,
} from '../services/envInstaller'

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const GIT_ZIP_NAME = `MinGit-${ENV_INSTALL_GIT_VERSION}-64-bit.zip`
const NODE_ZIP_NAME = `node-v${ENV_INSTALL_NODE_VERSION}-win-x64.zip`
const NODE_PREFIX = `node-v${ENV_INSTALL_NODE_VERSION}-win-x64`

/** MinGit 真实包布局（2026-10-05 实测：cmd/git.exe 扁平落根） */
const GIT_ZIP_ENTRIES: Record<string, Uint8Array> = {
  'cmd/git.exe': enc('git-exe'),
  'cmd/git-receive-pack.exe': enc('grp'),
  'etc/gitconfig': enc('[core]\n'),
}

/** Node 官方 zip 布局（唯一顶层目录 node-vX-win-x64/，剥离后落 env/ 根） */
const NODE_ZIP_ENTRIES: Record<string, Uint8Array> = {
  [`${NODE_PREFIX}/`]: new Uint8Array(0),
  [`${NODE_PREFIX}/node.exe`]: enc('node-exe'),
  [`${NODE_PREFIX}/npm.cmd`]: enc('npm-cmd'),
  [`${NODE_PREFIX}/node_modules/npm/index.js`]: enc('npm-index'),
}

function sha256hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 构造带 Content-Length 的 zip Response（downloadToFile 走真实流式读取路径） */
function zipResponse(entries: Record<string, Uint8Array>): Response {
  const buf = zipSync(entries)
  return new Response(buf, { status: 200, headers: { 'Content-Length': String(buf.length) } })
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-envinst-'))
})

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true })
})

// ---------------------------------------------------------------------------
// 下载源 URL 构建（纯函数）
// ---------------------------------------------------------------------------

describe('下载源 URL 构建', () => {
  it('MinGit：官方源（未启用镜像）只有 GitHub 原始 URL', () => {
    const urls = minGitDownloadUrls('github')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe(
      `https://github.com/git-for-windows/git/releases/download/` +
        `v${ENV_INSTALL_GIT_VERSION}.windows.1/${GIT_ZIP_NAME}`,
    )
  })

  it('MinGit：镜像 host 生效时镜像前缀优先、GitHub 兜底', () => {
    const urls = minGitDownloadUrls('gh-proxy.com')
    expect(urls).toHaveLength(2)
    expect(urls[0]).toBe(`https://gh-proxy.com/${urls[1]}`)
    expect(urls[1]).toContain('github.com/git-for-windows/git/releases/download/')
  })

  it('Node：官方优先时 nodejs.org 在前、npmmirror 兜底；zip 与 SHASUMS 同源配对', () => {
    const sources = nodeDownloadSources(false)
    expect(sources).toHaveLength(2)
    expect(sources[0].zipUrl).toBe(`https://nodejs.org/dist/v${ENV_INSTALL_NODE_VERSION}/${NODE_ZIP_NAME}`)
    expect(sources[0].shasumsUrl).toBe(`https://nodejs.org/dist/v${ENV_INSTALL_NODE_VERSION}/SHASUMS256.txt`)
    expect(sources[1].zipUrl).toBe(`https://npmmirror.com/mirrors/node/v${ENV_INSTALL_NODE_VERSION}/${NODE_ZIP_NAME}`)
    expect(sources[1].shasumsUrl).toBe(`https://npmmirror.com/mirrors/node/v${ENV_INSTALL_NODE_VERSION}/SHASUMS256.txt`)
  })

  it('Node：镜像优先（GitHub 镜像开启的国内网络信号）时 npmmirror 在前', () => {
    const sources = nodeDownloadSources(true)
    expect(sources[0].zipUrl).toContain('npmmirror.com')
    expect(sources[1].zipUrl).toContain('nodejs.org')
  })
})

// ---------------------------------------------------------------------------
// 探测计划与 SHASUMS 解析
// ---------------------------------------------------------------------------

describe('planEnvInstall', () => {
  it('which 全空：git/node 均缺失并带探测失败消息', () => {
    const plan = planEnvInstall(() => null)
    expect(plan.git.missing).toBe(true)
    expect(plan.git.message).toBe('Git is not installed on system')
    expect(plan.node.missing).toBe(true)
    expect(plan.node.message).toBe('Node.js is not installed on system')
  })

  it('node 可用（注入测试宿主 node.exe）、git 缺失：仅 git 进安装计划', () => {
    const plan = planEnvInstall((binary) => (binary === 'node' ? process.execPath : null))
    expect(plan.git.missing).toBe(true)
    expect(plan.node.missing).toBe(false)
  })
})

describe('parseExpectedSha256', () => {
  const hash = 'a'.repeat(64)
  it('标准两空格分隔条目可解析', () => {
    const text = `${'b'.repeat(64)}  other.zip\n${hash}  ${NODE_ZIP_NAME}\n`
    expect(parseExpectedSha256(text, NODE_ZIP_NAME)).toBe(hash)
  })

  it('二进制标记 * 前缀兼容（shasum -b 格式）', () => {
    const text = `${hash} *${NODE_ZIP_NAME}\n`
    expect(parseExpectedSha256(text, NODE_ZIP_NAME)).toBe(hash)
  })

  it('无对应条目返回 null', () => {
    expect(parseExpectedSha256(`${'b'.repeat(64)}  other.zip\n`, NODE_ZIP_NAME)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 解压（布局 / 剥离 / Zip-Slip）
// ---------------------------------------------------------------------------

describe('extractZipToDir', () => {
  /** 写盘→读盘闭环，与生产路径一致（downloadToFile 落盘后才解压） */
  const writeZip = (entries: Record<string, Uint8Array>): string => {
    const zipPath = join(tempDir, 'fixture.zip')
    writeFileSync(zipPath, zipSync(entries))
    return zipPath
  }

  it('MinGit 扁平布局：cmd/git.exe 直落 env/ 根', () => {
    const target = join(tempDir, 'env')
    extractZipToDir(writeZip(GIT_ZIP_ENTRIES), target)
    expect(readFileSync(join(target, 'cmd', 'git.exe'), 'utf8')).toBe('git-exe')
    expect(readFileSync(join(target, 'etc', 'gitconfig'), 'utf8')).toBe('[core]\n')
  })

  it('Node 布局：剥离唯一顶层目录，node.exe/npm.cmd 落 env/ 根', () => {
    const target = join(tempDir, 'env')
    extractZipToDir(
      writeZip(NODE_ZIP_ENTRIES),
      target,
      `${NODE_PREFIX}/`,
    )
    expect(readFileSync(join(target, 'node.exe'), 'utf8')).toBe('node-exe')
    expect(readFileSync(join(target, 'npm.cmd'), 'utf8')).toBe('npm-cmd')
    expect(readFileSync(join(target, 'node_modules', 'npm', 'index.js'), 'utf8')).toBe('npm-index')
    // 顶层目录本身不得残留成空壳目录层级（entry 已剥离）
    expect(existsSync(join(target, NODE_PREFIX))).toBe(false)
  })

  it('Zip-Slip：越界 entry（../）拒绝并抛错，不写出目标目录外', () => {
    const zipPath = writeZip({ '../evil.txt': enc('evil') })
    const target = join(tempDir, 'env')
    expect(() => extractZipToDir(zipPath, target)).toThrow('不安全的路径')
    expect(existsSync(join(tempDir, 'evil.txt'))).toBe(false)
  })

  it('stripPrefix 失配：entry 缺少预期顶层前缀时抛错（版本结构防错配）', () => {
    const zipPath = writeZip({ 'other-root/file.txt': enc('x') })
    expect(() => extractZipToDir(zipPath, join(tempDir, 'env'), `${NODE_PREFIX}/`)).toThrow(
      '结构与预期不符',
    )
  })
})

// ---------------------------------------------------------------------------
// 安装全链路（fetchImpl 注入替身，零网络）
// ---------------------------------------------------------------------------

describe('installEnvComponents', () => {
  const nodeBuf = zipSync(NODE_ZIP_ENTRIES)
  const nodeShasumsText = `${sha256hex(nodeBuf)}  ${NODE_ZIP_NAME}\n`

  /** 标准替身：Git/Node zip 与 SHASUMS 全部可服务；记录请求序到 log */
  function makeServingFetch(log?: string[]): (
    url: string,
  ) => Promise<Response> {
    return async (url: string) => {
      log?.push(url)
      if (url.endsWith(GIT_ZIP_NAME)) return zipResponse(GIT_ZIP_ENTRIES)
      if (url.endsWith(NODE_ZIP_NAME)) return zipResponse(NODE_ZIP_ENTRIES)
      if (url.endsWith('SHASUMS256.txt')) return new Response(nodeShasumsText, { status: 200 })
      return new Response('not found', { status: 404 })
    }
  }

  it('git + node 全链路：下载→SHA 校验→解压落地 env/→done，进度含各阶段', async () => {
    const envRoot = join(tempDir, 'env')
    const events: EnvInstallProgress[] = []
    const result = await installEnvComponents(['git', 'node'], (p) => events.push(p), {
      envRoot,
      mirrorHost: 'github',
      nodeMirrorFirst: false,
      fetchImpl: makeServingFetch(),
      verifier: () => null,
    })

    expect(result.ok).toBe(true)
    expect(result.installed).toEqual(['git', 'node'])
    // 布局断言：MinGit 扁平 + Node 剥离顶层目录
    expect(readFileSync(join(envRoot, 'cmd', 'git.exe'), 'utf8')).toBe('git-exe')
    expect(readFileSync(join(envRoot, 'node.exe'), 'utf8')).toBe('node-exe')
    expect(readFileSync(join(envRoot, 'npm.cmd'), 'utf8')).toBe('npm-cmd')

    const nodeEvents = events.filter((e) => e.component === 'node')
    expect(nodeEvents.map((e) => e.phase)).toContain('verify')
    for (const c of ['git', 'node'] as const) {
      const last = events.filter((e) => e.component === c).at(-1)
      expect(last?.phase).toBe('done')
    }
  })

  it('SHA256 失配 → 弃源换下一个候选源重试成功', async () => {
    const log: string[] = []
    const wrongShasums = `${'0'.repeat(64)}  ${NODE_ZIP_NAME}\n`
    const fetchImpl = async (url: string): Promise<Response> => {
      log.push(url)
      if (url.endsWith(NODE_ZIP_NAME)) return zipResponse(NODE_ZIP_ENTRIES)
      if (url.includes('npmmirror.com') && url.endsWith('SHASUMS256.txt')) {
        return new Response(wrongShasums, { status: 200 })
      }
      if (url.endsWith('SHASUMS256.txt')) return new Response(nodeShasumsText, { status: 200 })
      return new Response('not found', { status: 404 })
    }

    const result = await installEnvComponents(['node'], undefined, {
      envRoot: join(tempDir, 'env'),
      mirrorHost: 'github',
      nodeMirrorFirst: true, // npmmirror 在前：首个 SHA 坏，官方源兜底
      fetchImpl,
      verifier: () => null,
    })

    expect(result.ok).toBe(true)
    expect(result.installed).toEqual(['node'])
    // 确实发生过换源：镜像源 zip 与官方源 zip 都被请求
    const zipHits = log.filter((u) => u.endsWith(NODE_ZIP_NAME))
    expect(zipHits).toHaveLength(2)
    expect(zipHits[0]).toContain('npmmirror.com')
    expect(zipHits[1]).toContain('nodejs.org')
  })

  it('git 全源失败不阻断 node：部分成功终态，失败信息可读', async () => {
    const result = await installEnvComponents(['git', 'node'], undefined, {
      envRoot: join(tempDir, 'env'),
      mirrorHost: 'gh-proxy.com', // git 两候选 URL 全部 500
      nodeMirrorFirst: false,
      fetchImpl: async (url) => {
        if (url.endsWith(GIT_ZIP_NAME)) return new Response('boom', { status: 500 })
        if (url.endsWith(NODE_ZIP_NAME)) return zipResponse(NODE_ZIP_ENTRIES)
        if (url.endsWith('SHASUMS256.txt')) return new Response(nodeShasumsText, { status: 200 })
        return new Response('not found', { status: 404 })
      },
      verifier: () => null,
    })

    expect(result.ok).toBe(false)
    expect(result.installed).toEqual(['node'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].component).toBe('git')
    expect(result.failures[0].message).toContain('HTTP 500')
    // node 仍落地
    expect(existsSync(join(tempDir, 'env', 'node.exe'))).toBe(true)
  })

  it('装后校验失败：verifier 错误消息成为该组件失败原因', async () => {
    const result = await installEnvComponents(['node'], undefined, {
      envRoot: join(tempDir, 'env'),
      mirrorHost: 'github',
      nodeMirrorFirst: false,
      fetchImpl: makeServingFetch(),
      verifier: (component) => (component === 'node' ? 'npm.cmd 缺失' : null),
    })

    expect(result.ok).toBe(false)
    expect(result.failures[0].message).toBe('npm.cmd 缺失')
    expect(result.message).toContain('npm.cmd 缺失')
  })
})
