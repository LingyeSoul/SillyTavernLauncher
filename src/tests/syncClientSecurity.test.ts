/**
 * 同步客户端安全回归（Windows ↔ Termux 同一协议契约）：
 * - safeDataPath：远程 manifest path 不得穿越/绝对路径/反斜杠/驱动器前缀/符号链接；
 * - 远端 manifest 形状校验：重复路径、文件/目录前缀冲突、非法 size/mtime/sha256；
 * - 下载完整性：Content-Length 与流式字节双上限、sha256 比对、失败半成品清理；
 * - 空远端清单守卫：默认拒绝清空本地数据，allowEmptyRemote 显式放行；
 * - 增量删除/下载前备份，备份失败中止且不触碰数据。
 *
 * 使用真实本地 node:http 服务器 + 真实 fetch/pipeline（不用 fetch 假实现掩盖链路），
 * 不访问外部网络；每个用例的数据目录都是独立临时目录。
 */
import * as http from 'node:http'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SyncClient, safeDataPath } from '../services/sync/client'

const REMOTE_MTIME = 1_700_000_000

let root: string
let localDir: string
let backupRoot: string
let escapedPath: string
let openServers: Array<{ close: () => Promise<void> }>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stlsyncsec'))
  // localDir = root/work/local-data；`../../escaped.txt` 恰好落到 root/escaped.txt
  localDir = join(root, 'work', 'local-data')
  backupRoot = join(root, 'backup')
  escapedPath = join(root, 'escaped.txt')
  openServers = []
  mkdirSync(localDir, { recursive: true })
})

afterEach(async () => {
  for (const server of openServers) {
    await server.close()
  }
  rmSync(root, { recursive: true, force: true })
})

function makeClient(baseUrl: string, logs: string[] = []): SyncClient {
  return new SyncClient(`${baseUrl}#token=security-test`, localDir, {
    backupRoot,
    log: (message) => logs.push(message),
  })
}

interface StubServer {
  baseUrl: string
  requests: string[]
}

async function startStubServer(
  handler: (url: URL, res: http.ServerResponse) => void,
): Promise<StubServer> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub.local')
    requests.push(`${url.pathname}${url.search}`)
    handler(url, res)
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    server.close()
    throw new Error('测试服务器未能分配端口')
  }
  openServers.push({
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  })
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests }
}

function sendManifest(res: http.ServerResponse, manifest: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      success: true,
      manifest,
      total_files: manifest.length,
      generated_at: new Date().toISOString(),
    }),
  )
}

function remoteEntry(
  path: string,
  content: Uint8Array,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    path,
    size: content.byteLength,
    mtime: REMOTE_MTIME,
    modified: new Date(REMOTE_MTIME * 1000).toISOString(),
    is_dir: false,
    sha256: createHash('sha256').update(content).digest('hex'),
    ...overrides,
  }
}

describe('safeDataPath：远端路径遏制', () => {
  it('合法相对路径映射到数据目录内', () => {
    const mapped = safeDataPath(localDir, 'chats/room.json')
    expect(relative(localDir, mapped)).toBe(join('chats', 'room.json'))
  })

  it('拒绝穿越/反斜杠/绝对路径/驱动器前缀/空段/NUL/非字符串', () => {
    const badPaths: unknown[] = [
      '../../escaped.txt',
      '..\\escaped.txt',
      '/etc/passwd',
      'C:\\Windows\\evil.txt',
      'C:evil.txt',
      'a//b.txt',
      'a/./b.txt',
      'a\0b.txt',
      '',
      42,
      null,
    ]
    for (const badPath of badPaths) {
      expect(() => safeDataPath(localDir, badPath), `应拒绝 ${String(badPath)}`).toThrow()
    }
  })

  it('数据目录内的符号链接路径段被拒绝（junction 在 Windows 同样计为符号链接）', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
    symlinkSync(outside, join(localDir, 'link'), 'junction')

    expect(() => safeDataPath(localDir, 'link/secret.txt')).toThrow(/符号链接/)
  })
})

describe('远端 manifest 形状校验', () => {
  it('../../ 穿越路径的清单被拒，数据目录外不落盘且不请求 /file', async () => {
    const payload = Buffer.from('pwned')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [remoteEntry('../../escaped.txt', payload)])
        return
      }
      if (url.pathname === '/file') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(payload)
        return
      }
      res.writeHead(404)
      res.end()
    })

    const client = makeClient(stub.baseUrl)
    expect(await client.syncIncremental({ backup: false })).toBe(false)
    expect(existsSync(escapedPath)).toBe(false)
    expect(stub.requests.some((request) => request.startsWith('/file'))).toBe(false)
  })

  it('重复路径被拒绝', async () => {
    const content = Buffer.from('dup')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [
          remoteEntry('dup.txt', content),
          remoteEntry('dup.txt', content),
        ])
        return
      }
      res.writeHead(404)
      res.end()
    })
    expect(await makeClient(stub.baseUrl).getRemoteManifest()).toBeNull()
  })

  it('文件与目录前缀冲突被拒绝', async () => {
    const content = Buffer.from('x')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [
          remoteEntry('folder', content),
          remoteEntry('folder/child.txt', content),
        ])
        return
      }
      res.writeHead(404)
      res.end()
    })
    expect(await makeClient(stub.baseUrl).getRemoteManifest()).toBeNull()
  })

  it('非法 size / mtime / sha256 的条目被拒绝', async () => {
    const content = Buffer.from('x')
    const invalidEntries: Array<[string, Record<string, unknown>]> = [
      ['size 非整数', remoteEntry('bad-size.txt', content, { size: 1.5 })],
      ['mtime 非有限数', remoteEntry('bad-mtime.txt', content, { mtime: 'yesterday' })],
      ['sha256 非 64 位 hex', remoteEntry('bad-sha.txt', content, { sha256: 'zz' })],
    ]
    for (const [label, entry] of invalidEntries) {
      const stub = await startStubServer((url, res) => {
        if (url.pathname === '/manifest') {
          sendManifest(res, [entry])
          return
        }
        res.writeHead(404)
        res.end()
      })
      expect(await makeClient(stub.baseUrl).getRemoteManifest(), label).toBeNull()
    }
  })
})

describe('下载完整性与半成品清理', () => {
  it('Content-Length 或流式字节超过清单 size 时失败，且不留下半成品', async () => {
    const declared = Buffer.from('abcd')
    const oversized = Buffer.from('0123456789')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [
          remoteEntry('header-too-big.bin', declared),
          remoteEntry('stream-too-big.bin', declared),
        ])
        return
      }
      if (url.pathname === '/file') {
        const target = url.searchParams.get('path')
        if (target === 'header-too-big.bin') {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(oversized.length),
          })
          res.end(oversized)
          return
        }
        if (target === 'stream-too-big.bin') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
          res.write(oversized.subarray(0, 6))
          res.end(oversized.subarray(6))
          return
        }
      }
      res.writeHead(404)
      res.end()
    })

    const logs: string[] = []
    const client = makeClient(stub.baseUrl, logs)
    expect(await client.syncIncremental({ backup: false })).toBe(false)
    expect(existsSync(join(localDir, 'header-too-big.bin'))).toBe(false)
    expect(existsSync(join(localDir, 'stream-too-big.bin'))).toBe(false)
    expect(readdirSync(localDir).filter((name) => name.endsWith('.part.tmp'))).toEqual([])
    expect(
      logs.some((message) => message.includes('超过清单大小') || message.includes('超过清单声明大小')),
    ).toBe(true)
  })

  it('sha256 不匹配时失败，半成品被删且原有本地文件保持原样', async () => {
    const content = Buffer.from('hello')
    const wrongSha256 = createHash('sha256').update('other').digest('hex')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [remoteEntry('greeting.txt', content, { sha256: wrongSha256 })])
        return
      }
      if (url.pathname === '/file') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(content.length),
        })
        res.end(content)
        return
      }
      res.writeHead(404)
      res.end()
    })

    writeFileSync(join(localDir, 'greeting.txt'), 'KEEP!', 'utf8')
    expect(await makeClient(stub.baseUrl).syncIncremental({ backup: true })).toBe(false)
    expect(readFileSync(join(localDir, 'greeting.txt'), 'utf8')).toBe('KEEP!')
    expect(readdirSync(localDir).filter((name) => name.endsWith('.part.tmp'))).toEqual([])
  })
})

describe('sync 到增量的传参（backup 不得丢失）', () => {
  it('preferZip=false 且 backup=true 时，sync 触发的增量同步同样生成备份', async () => {
    writeFileSync(join(localDir, 'stale.txt'), 'stale', 'utf8')
    const fresh = Buffer.from('fresh')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', auth_required: true }))
        return
      }
      if (url.pathname === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            server_info: {
              port: 0,
              host: '127.0.0.1',
              running: false,
              total_size: fresh.length,
              file_count: 1,
            },
          }),
        )
        return
      }
      if (url.pathname === '/manifest') {
        sendManifest(res, [remoteEntry('fresh.txt', fresh)])
        return
      }
      if (url.pathname === '/file') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fresh.length),
        })
        res.end(fresh)
        return
      }
      res.writeHead(404)
      res.end()
    })

    expect(await makeClient(stub.baseUrl).sync({ preferZip: false, backup: true })).toBe(true)
    expect(readFileSync(join(localDir, 'fresh.txt'), 'utf8')).toBe('fresh')

    const backupDirs = readdirSync(backupRoot)
    expect(backupDirs).toHaveLength(1)
    expect(readFileSync(join(backupRoot, backupDirs[0] as string, 'stale.txt'), 'utf8')).toBe('stale')
  })
})

describe('空远端清单守卫与备份门控', () => {
  it('远端清单为空时拒绝删除本地文件，并提示使用 ZIP 全量同步', async () => {
    writeFileSync(join(localDir, 'keep.txt'), 'keep', 'utf8')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [])
        return
      }
      res.writeHead(404)
      res.end()
    })

    const logs: string[] = []
    const client = makeClient(stub.baseUrl, logs)
    expect(await client.syncIncremental({ backup: true })).toBe(false)
    expect(readFileSync(join(localDir, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(backupRoot)).toBe(false)
    expect(logs.some((message) => message.includes('拒绝清空本地数据'))).toBe(true)
    expect(logs.some((message) => message.includes('ZIP 全量同步'))).toBe(true)
    expect(stub.requests.some((request) => request.startsWith('/file'))).toBe(false)
  })

  it('空清单拒绝后不得自动回退到 ZIP（否则守卫被全量替换绕过）', async () => {
    writeFileSync(join(localDir, 'keep.txt'), 'keep', 'utf8')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', auth_required: true }))
        return
      }
      if (url.pathname === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            server_info: { port: 0, host: '127.0.0.1', running: false, total_size: 0, file_count: 0 },
          }),
        )
        return
      }
      if (url.pathname === '/manifest') {
        sendManifest(res, [])
        return
      }
      if (url.pathname === '/zip') {
        // 空 ZIP：若发生自动回退，客户端会以它整体替换本地数据
        res.writeHead(200, { 'Content-Type': 'application/zip' })
        res.end(Buffer.alloc(0))
        return
      }
      res.writeHead(404)
      res.end()
    })

    const logs: string[] = []
    expect(
      await makeClient(stub.baseUrl, logs).sync({ preferZip: false, backup: true }),
    ).toBe(false)
    expect(readFileSync(join(localDir, 'keep.txt'), 'utf8')).toBe('keep')
    expect(stub.requests.some((request) => request.startsWith('/zip'))).toBe(false)
    expect(logs.some((message) => message.includes('拒绝自动回退'))).toBe(true)
  })

  it('allowEmptyRemote=true 时显式放行清空，且清空前生成备份', async () => {
    writeFileSync(join(localDir, 'keep.txt'), 'keep', 'utf8')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [])
        return
      }
      res.writeHead(404)
      res.end()
    })

    const client = makeClient(stub.baseUrl)
    expect(await client.syncIncremental({ backup: true, allowEmptyRemote: true })).toBe(true)
    expect(existsSync(join(localDir, 'keep.txt'))).toBe(false)

    const backupDirs = readdirSync(backupRoot)
    expect(backupDirs).toHaveLength(1)
    expect(
      readFileSync(join(backupRoot, backupDirs[0] as string, 'keep.txt'), 'utf8'),
    ).toBe('keep')
  })

  it('增量删除/下载前生成备份，备份内容是同步前快照', async () => {
    writeFileSync(join(localDir, 'stale.txt'), 'stale', 'utf8')
    const fresh = Buffer.from('fresh')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [remoteEntry('fresh.txt', fresh)])
        return
      }
      if (url.pathname === '/file') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fresh.length),
        })
        res.end(fresh)
        return
      }
      res.writeHead(404)
      res.end()
    })

    expect(await makeClient(stub.baseUrl).syncIncremental({ backup: true })).toBe(true)
    expect(existsSync(join(localDir, 'stale.txt'))).toBe(false)
    expect(readFileSync(join(localDir, 'fresh.txt'), 'utf8')).toBe('fresh')

    const backupDirs = readdirSync(backupRoot)
    expect(backupDirs).toHaveLength(1)
    const backupDir = join(backupRoot, backupDirs[0] as string)
    expect(readFileSync(join(backupDir, 'stale.txt'), 'utf8')).toBe('stale')
    expect(existsSync(join(backupDir, 'fresh.txt'))).toBe(false)
  })

  it('备份失败时中止增量同步，删除与下载都不发生', async () => {
    writeFileSync(join(localDir, 'stale.txt'), 'stale', 'utf8')
    // 让备份根路径无法创建（同名普通文件）→ mkdir 失败 → 必须中止且不碰数据
    writeFileSync(backupRoot, 'not a directory', 'utf8')
    const fresh = Buffer.from('fresh')
    const stub = await startStubServer((url, res) => {
      if (url.pathname === '/manifest') {
        sendManifest(res, [remoteEntry('fresh.txt', fresh)])
        return
      }
      if (url.pathname === '/file') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(fresh)
        return
      }
      res.writeHead(404)
      res.end()
    })

    const logs: string[] = []
    expect(await makeClient(stub.baseUrl, logs).syncIncremental({ backup: true })).toBe(false)
    expect(readFileSync(join(localDir, 'stale.txt'), 'utf8')).toBe('stale')
    expect(existsSync(join(localDir, 'fresh.txt'))).toBe(false)
    expect(stub.requests.some((request) => request.startsWith('/file'))).toBe(false)
    expect(logs.some((message) => message.includes('已中止增量同步'))).toBe(true)
  })
})
