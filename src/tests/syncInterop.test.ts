/**
 * 互操作回归测试 — 锁定双端同步协议契约（Windows 桌面端 ↔ Termux 端）。
 * ← Termux 仓库 tests/syncInterop.test.ts 的镜像视角：对端模拟"Windows 形状"，
 *   本端模拟"Termux 形状"，各自内嵌对端消费端契约，不跨仓库 import
 *   （对端路径在 CI 不可复现，且会随对端工作区漂移；契约锁的意义正是
 *   任一端要改协议就必须双端同步改这份镜像）。
 *
 * 种子数据刻意覆盖三个历史断点（2026-10-16 用户报障"无法与 Termux 版同步"）：
 *   - 子目录：ZIP 无目录条目 + 客户端解压路径（Termux 端曾因不建父目录 ENOENT）
 *   - CJK 文件名：/file 响应头（Termux 端曾因 Content-Disposition 非 ASCII 抛 500）
 *   - manifest sha256：Termux 客户端强制校验 64 位 hex 且须与内容一致（本端曾缺失）
 */
import * as http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SyncServer } from '../services/sync/server'
import { SyncClient } from '../services/sync/client'

const TOKEN = 'interop-test-token'
/** Termux 客户端的 sha256 校验正则（sync_client 同款），契约镜像 */
const TERMUX_SHA256_RE = /^[0-9a-fA-F]{64}$/

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0xff, 0xfe])

let root: string
let dataDir: string
let server: SyncServer
let baseUrl: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'stlinterop'))
  dataDir = join(root, 'server-data')
  mkdirSync(join(dataDir, 'chats', '子目录', 'deep'), { recursive: true })
  mkdirSync(join(dataDir, 'files', 'avatars'), { recursive: true })
  mkdirSync(join(dataDir, '.hiddendir'), { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), '{"theme":"dark"}', 'utf8')
  writeFileSync(join(dataDir, 'chats', '对话1.jsonl'), '{"msg":"你好"}\n', 'utf8')
  writeFileSync(join(dataDir, 'chats', '子目录', 'deep', '文件 2.txt'), '深层文件', 'utf8')
  writeFileSync(join(dataDir, 'files', 'avatars', '头像 x.png'), PNG_BYTES)
  // 过滤契约种子：隐藏文件/目录与 .tmp（双端过滤规则已对齐，均不参与同步）
  writeFileSync(join(dataDir, '.hidden.json'), 'server-secret', 'utf8')
  writeFileSync(join(dataDir, 'temp.tmp'), 'temp', 'utf8')
  writeFileSync(join(dataDir, '.hiddendir', 'inner.txt'), 'inner', 'utf8')

  server = new SyncServer({
    dataPath: dataDir,
    host: '127.0.0.1',
    port: 0,
    authToken: TOKEN,
    log: () => undefined,
  })
  await server.start()
  baseUrl = `http://127.0.0.1:${server.actualPort()}`
})

afterEach(async () => {
  await server.stop()
  rmSync(root, { force: true, recursive: true })
})

const authed = (path: string): { headers: Record<string, string> } => ({
  headers: { Authorization: `Bearer ${TOKEN}` },
})

describe('ZIP 全量：子目录 + CJK 文件名 + 二进制 + 孤儿清除（Windows 端全链路）', () => {
  it('深层子目录与非 ASCII 路径完整落盘，远端已删的孤儿文件被事务式替换清除', async () => {
    const destination = join(root, 'local-data')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'orphan-deleted.json'), 'stale', 'utf8')

    const client = new SyncClient(`${baseUrl}#token=${TOKEN}`, destination, {
      backupRoot: join(root, 'backup'),
      log: () => undefined,
    })
    expect(await client.syncFullZip({ backup: false })).toBe(true)

    expect(readFileSync(join(destination, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(destination, 'chats', '对话1.jsonl'), 'utf8')).toBe('{"msg":"你好"}\n')
    expect(readFileSync(join(destination, 'chats', '子目录', 'deep', '文件 2.txt'), 'utf8')).toBe('深层文件')
    expect(Buffer.compare(readFileSync(join(destination, 'files', 'avatars', '头像 x.png')), PNG_BYTES)).toBe(0)
    // 事务式整体替换：本地 == 远端镜像，孤儿与被过滤项一律不残留
    expect(existsSync(join(destination, 'orphan-deleted.json'))).toBe(false)
    expect(existsSync(join(destination, '.hidden.json'))).toBe(false)
    expect(existsSync(join(destination, 'temp.tmp'))).toBe(false)
  })
})

describe('Termux 消费端契约：manifest 必带合法 sha256 且与内容一致', () => {
  it('每条 manifest 携带 64 位 hex sha256，且等于 /file 实际内容的摘要（Termux 客户端逐文件校验）', async () => {
    const manifestResponse = await fetch(`${baseUrl}/manifest`, authed('/manifest'))
    expect(manifestResponse.status).toBe(200)
    const json = (await manifestResponse.json()) as {
      manifest: Array<{ path: string; sha256: string }>
    }
    const paths = json.manifest.map((m) => m.path).sort()
    expect(paths).toEqual(
      ['chats/子目录/deep/文件 2.txt', 'chats/对话1.jsonl', 'files/avatars/头像 x.png', 'settings.json'],
    )
    for (const item of json.manifest) {
      expect(item.sha256, `manifest[${item.path}].sha256 格式`).toMatch(TERMUX_SHA256_RE)
      const fileResponse = await fetch(
        `${baseUrl}/file?path=${encodeURIComponent(item.path)}`,
        authed('/file'),
      )
      expect(fileResponse.status).toBe(200)
      const body = Buffer.from(await fileResponse.arrayBuffer())
      expect(
        createHash('sha256').update(body).digest('hex'),
        `manifest[${item.path}].sha256 与内容一致`,
      ).toBe(item.sha256)
    }
  })
})

describe('Termux 消费端契约：ZIP 条目形状（无目录条目 + CJK 名称）', () => {
  it('/zip 条目集合与 manifest 完全一致，无目录条目，CJK 名称完整还原', async () => {
    const manifestResponse = await fetch(`${baseUrl}/manifest`, authed('/manifest'))
    const { manifest } = (await manifestResponse.json()) as { manifest: Array<{ path: string }> }
    const manifestPaths = manifest.map((m) => m.path).sort()

    const zipResponse = await fetch(`${baseUrl}/zip`, authed('/zip'))
    const buffer = new Uint8Array(await zipResponse.arrayBuffer())
    const entries = unzipSync(buffer)
    const names = Object.keys(entries).sort()

    // 双端 ZIP 均不生成目录条目（解压端按需 mkdir），manifest 与 ZIP 必须同集，
    // 否则全量与增量的结果互相漂移
    expect(names.some((name) => name.endsWith('/'))).toBe(false)
    expect(names).toEqual(manifestPaths)
    expect(Buffer.from(entries['chats/对话1.jsonl'] as Uint8Array).toString('utf8')).toBe('{"msg":"你好"}\n')
  })
})

describe('Termux 形状服务器 → Windows 客户端增量（对端修复后形态）', () => {
  /**
   * Termux 形状模拟服务器：manifest 必带 sha256（修复后必供）；
   * /file 响应带 RFC 5987 Content-Disposition（Termux 端修复后形态），
   * 验证 Windows 客户端对该头容忍且 CJK 路径逐文件下载成功。
   */
  function termuxShapedServer(
    files: Record<string, Buffer>,
  ): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return (req, res) => {
      const url = new URL(req.url ?? '/', 'http://termux.local')
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString(), auth_required: true }))
        return
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: '需要有效的同步认证令牌' }))
        return
      }
      if (url.pathname === '/manifest') {
        const manifest = Object.entries(files).map(([p, data]) => ({
          path: p,
          size: data.length,
          mtime: 1_700_000_000,
          modified: new Date(1_700_000_000_000).toISOString(),
          is_dir: false,
          sha256: createHash('sha256').update(data).digest('hex'),
        }))
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(JSON.stringify({ success: true, manifest, total_files: manifest.length, generated_at: new Date().toISOString() }))
        return
      }
      if (url.pathname === '/file') {
        const name = url.searchParams.get('path') ?? ''
        const data = files[name]
        if (!data) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ success: false, error: '文件不存在' }))
          return
        }
        // Termux 端修复后：filename* 百分号编码 + ASCII 回退名
        const asciiFallback = name.split('/').pop() ?? 'sync-file'
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': data.length,
          'Content-Disposition': `attachment; filename="${asciiFallback.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(asciiFallback)}`,
        })
        res.end(data)
        return
      }
      res.writeHead(404)
      res.end()
    }
  }

  it('CJK 文件名逐文件下载成功，且第二轮 sha256 比较零下载', async () => {
    const files: Record<string, Buffer> = {
      'settings.json': Buffer.from('{}'),
      'chats/对话1.jsonl': Buffer.from('你好\n'),
    }
    const shaped = http.createServer(termuxShapedServer(files))
    await new Promise<void>((resolve) => shaped.listen(0, '127.0.0.1', resolve))
    const address = shaped.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const destination = join(root, 'shaped-recv')

    try {
      const client = new SyncClient(`http://127.0.0.1:${port}#token=${TOKEN}`, destination, {
        backupRoot: join(root, 'backup'),
        log: () => undefined,
      })
      expect(await client.syncIncremental()).toBe(true)
      expect(readFileSync(join(destination, 'chats', '对话1.jsonl'), 'utf8')).toBe('你好\n')

      // 第二轮：内容未变（sha256 相等）→ 不重复下载（mtime 精度/时区差异不再引发误判）
      const logs: string[] = []
      const again = new SyncClient(`http://127.0.0.1:${port}#token=${TOKEN}`, destination, {
        backupRoot: join(root, 'backup'),
        log: (message) => logs.push(message),
      })
      expect(await again.syncIncremental()).toBe(true)
      expect(logs.some((message) => message.includes('数据已是最新'))).toBe(true)
    } finally {
      await new Promise<void>((resolve) => shaped.close(() => resolve()))
    }
  })
})
