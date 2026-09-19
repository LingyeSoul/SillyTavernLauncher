/**
 * ← client.py 语义等价测试：token fragment 解析（不随 URL 发送）、
 * 全量 ZIP 同步（流下载 → 解压 → mtime 保留）、增量同步（mtime diff +
 * 删除多余文件）、Zip-Slip 防护（恶意服务器）、备份/恢复。
 * 全部使用真实 node:http 服务器 + fetch。
 */
import * as http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SyncServer } from '../services/sync/server'
import {
  SyncClient,
  dosDateTimeToEpoch,
  formatBackupTimestamp,
  formatSize,
  generateLocalManifest,
  readZipMtimes,
} from '../services/sync/client'

const TOKEN = 'client-test-token'
const SOURCE_MTIME = 1609459200 // 2021-01-01 00:00:00（本地偶数秒，规避 DOS 2s 截断）

let root: string
let dataDir: string
let localDir: string
let backupRoot: string
let server: SyncServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'stlsynccli'))
  dataDir = join(root, 'server-data')
  localDir = join(root, 'local-data')
  backupRoot = join(root, 'backup')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), '{"v":1}', 'utf8')
  mkdirSync(join(dataDir, 'chats'), { recursive: true })
  writeFileSync(join(dataDir, 'chats', 'room.json'), '{"m":[]}', 'utf8')
  utimesSync(join(dataDir, 'settings.json'), SOURCE_MTIME, SOURCE_MTIME)
  utimesSync(join(dataDir, 'chats', 'room.json'), SOURCE_MTIME, SOURCE_MTIME)

  server = new SyncServer({
    dataPath: dataDir,
    host: '127.0.0.1',
    port: 0,
    authToken: TOKEN,
    log: () => undefined,
  })
  await server.start()
})

afterEach(async () => {
  await server.stop()
  rmSync(root, { force: true, recursive: true })
})

function makeClient(): SyncClient {
  return new SyncClient(`http://127.0.0.1:${server.actualPort()}#token=${TOKEN}`, localDir, {
    backupRoot,
    log: () => undefined,
  })
}

describe('URL 与 token fragment（← __init__）', () => {
  it('token 从 fragment 提取，serverUrl 不含 fragment/query（← Python 安全用例）', () => {
    const client = new SyncClient('http://192.168.1.2:9999#token=test-token', join(root, 'd1'), {
      backupRoot,
      log: () => undefined,
    })
    expect(client.serverUrl).toBe('http://192.168.1.2:9999')
    expect(client.authToken).toBe('test-token')
  })

  it('尾斜杠剥除、无 token 为空、URL 编码 token 解码', () => {
    const slash = new SyncClient('http://192.168.1.2:9999/#token=abc', join(root, 'd2'), {
      backupRoot,
      log: () => undefined,
    })
    expect(slash.serverUrl).toBe('http://192.168.1.2:9999')
    expect(slash.authToken).toBe('abc')

    const none = new SyncClient('http://192.168.1.2:9999', join(root, 'd3'), {
      backupRoot,
      log: () => undefined,
    })
    expect(none.authToken).toBe('')

    const encoded = new SyncClient('http://h:1#token=a%20b', join(root, 'd4'), {
      backupRoot,
      log: () => undefined,
    })
    expect(encoded.authToken).toBe('a b')
  })

  it('非 HTTP(S) URL 抛错', () => {
    expect(() => new SyncClient('ftp://host:1', join(root, 'd5'), { backupRoot, log: () => undefined })).toThrow(
      '同步服务器地址必须是有效的 HTTP(S) URL',
    )
    expect(() => new SyncClient('not a url', join(root, 'd6'), { backupRoot, log: () => undefined })).toThrow()
  })
})

describe('全量 ZIP 同步（← sync_full_zip）', () => {
  it('下载 → 解压 → mtime 保留', async () => {
    const client = makeClient()
    const ok = await client.syncFullZip({ backup: false })
    expect(ok).toBe(true)
    expect(readFileSync(join(localDir, 'settings.json'), 'utf8')).toBe('{"v":1}')
    expect(readFileSync(join(localDir, 'chats', 'room.json'), 'utf8')).toBe('{"m":[]}')
    const localStat = statSync(join(localDir, 'settings.json'))
    expect(Math.abs(localStat.mtimeMs / 1000 - SOURCE_MTIME)).toBeLessThanOrEqual(2)
  })

  it('备份现有数据（← _backup_existing_data）', async () => {
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'old.txt'), 'old', 'utf8')
    const client = makeClient()
    const ok = await client.syncFullZip({ backup: true })
    expect(ok).toBe(true)
    expect(existsSync(backupRoot)).toBe(true)
    // 旧文件被 zip 内容覆盖性合并（copytree+extractall 语义：不先清空）
    expect(existsSync(join(localDir, 'old.txt'))).toBe(true)
    expect(existsSync(join(localDir, 'settings.json'))).toBe(true)
  })

  it('下载失败时恢复备份（← _restore_backup）', async () => {
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'keep.txt'), 'keep', 'utf8')
    // 恶意服务器：health 正常但 /zip 500
    const badServer = http.createServer((req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', auth_required: true }))
        return
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'boom' }))
    })
    await new Promise<void>((resolve) => badServer.listen(0, '127.0.0.1', resolve))
    const address = badServer.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const client = new SyncClient(`http://127.0.0.1:${port}#token=${TOKEN}`, localDir, {
      backupRoot,
      log: () => undefined,
    })
    const ok = await client.syncFullZip({ backup: true })
    expect(ok).toBe(false)
    // 恢复后本地数据仍在
    expect(readFileSync(join(localDir, 'keep.txt'), 'utf8')).toBe('keep')
    // 备份目录存在
    expect(existsSync(backupRoot)).toBe(true)
    await new Promise<void>((resolve) => badServer.close(() => resolve()))
  })
})

describe('Zip-Slip 防护（恶意服务器，← _extract_zip_with_progress）', () => {
  it('不安全 entry 跳过，其余正常解压', async () => {
    const evilZip = zipSync({
      'safe.txt': strToU8('safe'),
      '../escaped.txt': strToU8('evil'),
      'inner/ok.txt': strToU8('ok'),
    })
    const evilServer = http.createServer((req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', auth_required: true }))
        return
      }
      if (url.startsWith('/zip')) {
        res.writeHead(200, { 'Content-Type': 'application/zip' })
        res.end(evilZip)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => evilServer.listen(0, '127.0.0.1', resolve))
    const address = evilServer.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const logs: string[] = []
    const client = new SyncClient(`http://127.0.0.1:${port}#token=${TOKEN}`, localDir, {
      backupRoot,
      log: (message) => logs.push(message),
    })
    const ok = await client.syncFullZip({ backup: false })
    expect(ok).toBe(true)
    expect(readFileSync(join(localDir, 'safe.txt'), 'utf8')).toBe('safe')
    expect(readFileSync(join(localDir, 'inner', 'ok.txt'), 'utf8')).toBe('ok')
    expect(existsSync(join(localDir, '..', 'escaped.txt'))).toBe(false)
    expect(logs.some((message) => message.includes('跳过不安全的 ZIP 条目'))).toBe(true)
    await new Promise<void>((resolve) => evilServer.close(() => resolve()))
  })
})

describe('增量同步（← sync_incremental）', () => {
  it('全量同步后增量无差异（mtime 相等 → 数据已是最新）', async () => {
    const client = makeClient()
    expect(await client.syncFullZip({ backup: false })).toBe(true)
    const logs: string[] = []
    const again = new SyncClient(`http://127.0.0.1:${server.actualPort()}#token=${TOKEN}`, localDir, {
      backupRoot,
      log: (message) => logs.push(message),
    })
    expect(await again.syncIncremental()).toBe(true)
    expect(logs.some((message) => message.includes('数据已是最新'))).toBe(true)
  })

  it('远端更新 → 下载新内容并保留 mtime；远端删除 → 本地删除', async () => {
    const client = makeClient()
    expect(await client.syncFullZip({ backup: false })).toBe(true)

    // 服务器端更新 settings.json（内容 + 新 mtime）并删除 chats/room.json、新增 new.txt
    const newerMtime = SOURCE_MTIME + 3600
    writeFileSync(join(dataDir, 'settings.json'), '{"v":2}', 'utf8')
    utimesSync(join(dataDir, 'settings.json'), newerMtime, newerMtime)
    rmSync(join(dataDir, 'chats', 'room.json'))
    writeFileSync(join(dataDir, 'new.txt'), 'new', 'utf8')
    utimesSync(join(dataDir, 'new.txt'), newerMtime, newerMtime)

    expect(await client.syncIncremental()).toBe(true)
    expect(readFileSync(join(localDir, 'settings.json'), 'utf8')).toBe('{"v":2}')
    expect(Math.abs(statSync(join(localDir, 'settings.json')).mtimeMs / 1000 - newerMtime)).toBeLessThanOrEqual(2)
    expect(existsSync(join(localDir, 'chats', 'room.json'))).toBe(false)
    expect(readFileSync(join(localDir, 'new.txt'), 'utf8')).toBe('new')
  })

  it('本地多余文件被删除（远端 manifest 不含 → files_to_delete）', async () => {
    const client = makeClient()
    expect(await client.syncFullZip({ backup: false })).toBe(true)
    writeFileSync(join(localDir, 'extra.txt'), 'extra', 'utf8')
    expect(await client.syncIncremental()).toBe(true)
    expect(existsSync(join(localDir, 'extra.txt'))).toBe(false)
  })

  it('sync 自动模式：健康检查失败返回 false', async () => {
    const client = new SyncClient('http://127.0.0.1:1#token=x', localDir, {
      backupRoot,
      log: () => undefined,
      timeoutSec: 1,
    })
    expect(await client.sync()).toBe(false)
  })
})

describe('manifest 与工具（← get_local_manifest / _format_size）', () => {
  it('本地 manifest：正斜杠路径、跳过隐藏/.tmp', () => {
    writeFileSync(join(dataDir, '.h'), 'x', 'utf8')
    const manifest = generateLocalManifest(dataDir)
    const paths = manifest.map((m) => m.path)
    expect(paths).toContain('settings.json')
    expect(paths).toContain('chats/room.json')
    expect(paths).not.toContain('.h')
  })

  it('formatSize（← _format_size）', () => {
    expect(formatSize(0)).toBe('0B')
    expect(formatSize(512)).toBe('512.0B')
    expect(formatSize(2048)).toBe('2.0KB')
    expect(formatSize(1024 * 1024 * 1.5)).toBe('1.5MB')
    expect(formatSize(3 * 1024 ** 3)).toBe('3.0GB')
  })

  it('formatBackupTimestamp：YYYYMMDD_HHMMSS', () => {
    expect(formatBackupTimestamp(new Date(2026, 8, 19, 8, 7, 9))).toBe('20260919_080709')
  })
})

describe('ZIP 中央目录 mtime 解析（← zipfile mtime 保留的支撑）', () => {
  it('readZipMtimes 返回 entry → epoch；DOS 解码与本地时区一致', () => {
    const date = new Date(2021, 0, 1, 12, 30, 40)
    const zipped = zipSync({ 'a.txt': [strToU8('x'), { mtime: date }] })
    const mtimes = readZipMtimes(zipped)
    expect(mtimes.get('a.txt')).toBeDefined()
    expect(mtimes.get('a.txt')).toBe(date.getTime() / 1000)
  })

  it('dosDateTimeToEpoch 边界（1980-01-01）', () => {
    // 1980-01-01 00:00:00 → date=0x21, time=0
    expect(dosDateTimeToEpoch(0x21, 0)).toBe(new Date(1980, 0, 1, 0, 0, 0).getTime() / 1000)
  })

  it('服务器 zip 与 readZipMtimes 往返（端到端 mtime 一致性）', async () => {
    const response = await fetch(`http://127.0.0.1:${server.actualPort()}/zip`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    const buffer = new Uint8Array(await response.arrayBuffer())
    const mtimes = readZipMtimes(buffer)
    expect(Math.abs((mtimes.get('settings.json') ?? 0) - SOURCE_MTIME)).toBeLessThanOrEqual(2)
    expect(unzipSync(buffer)['settings.json']).toBeDefined()
  })
})
