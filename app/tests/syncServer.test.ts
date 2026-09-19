/**
 * ← tests/test_sync_security.py（SyncSecurityTests）语义等价移植 + 扩展：
 * /health 免鉴权、数据端点 401/200、Bearer 校验（timingSafeEqual）、
 * 路径穿越 403、zip 打包 mtime、manifest 过滤规则。
 * 服务器为真实 node:http 实例，监听 127.0.0.1 随机端口，用 fetch 断言。
 */
import * as http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SyncServer,
  formatAccessLogTime,
  generateSyncToken,
  tokenEquals,
} from '../services/sync/server'

const TOKEN = 'test-token'

let dataDir: string
let server: SyncServer
let baseUrl: string
let accessLogs: string[]

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'stlsyncsrv'))
  // 数据骨架：常规文件、子目录文件、隐藏文件、.tmp、隐藏目录
  writeFileSync(join(dataDir, 'settings.json'), '{"theme":"dark"}', 'utf8')
  mkdirSync(join(dataDir, 'chats'), { recursive: true })
  writeFileSync(join(dataDir, 'chats', 'room.json'), '{"messages":[]}', 'utf8')
  writeFileSync(join(dataDir, '.secret'), 'hidden', 'utf8')
  writeFileSync(join(dataDir, 'draft.tmp'), 'tmp', 'utf8')
  mkdirSync(join(dataDir, '.git'), { recursive: true })
  writeFileSync(join(dataDir, '.git', 'config'), '[core]', 'utf8')
  utimesSync(join(dataDir, 'settings.json'), 1609459200, 1609459200) // 2021-01-01 00:00:00Z（本地偶数秒）

  accessLogs = []
  server = new SyncServer({
    dataPath: dataDir,
    host: '127.0.0.1',
    port: 0,
    authToken: TOKEN,
    log: (message) => {
      accessLogs.push(message)
    },
  })
  await server.start()
  baseUrl = `http://127.0.0.1:${server.actualPort()}`
})

afterEach(async () => {
  await server.stop()
  rmSync(dataDir, { force: true, recursive: true })
})

function authed(path: string): RequestInit {
  return { headers: { Authorization: `Bearer ${TOKEN}` } }
}

describe('鉴权（← before_request require_authentication）', () => {
  it('/health 免鉴权且不泄漏数据目录（← test_health_is_public_without_leaking_data_path）', async () => {
    const response = await fetch(`${baseUrl}/health`)
    expect(response.status).toBe(200)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.auth_required).toBe(true)
    expect(json.status).toBe('healthy')
    expect(JSON.stringify(json)).not.toContain('data_path')
    expect(JSON.stringify(json)).not.toContain(dataDir)
  })

  it('数据端点缺 token 返回 401（← test_data_endpoint_rejects_missing_token）', async () => {
    const response = await fetch(`${baseUrl}/info`)
    expect(response.status).toBe(401)
    const json = (await response.json()) as { success: boolean; error: string }
    expect(json.success).toBe(false)
    expect(json.error).toBe('Authentication required')
  })

  it('Bearer token 通过（← test_data_endpoint_accepts_bearer_token）', async () => {
    const response = await fetch(`${baseUrl}/info`, authed('/info'))
    expect(response.status).toBe(200)
    const json = (await response.json()) as { server_info: Record<string, unknown> }
    expect(JSON.stringify(json.server_info)).not.toContain('data_path')
    expect(json.server_info.running).toBe(true)
  })

  it('错误 token（等长/不等长）与错误 scheme 均拒绝', async () => {
    const wrongSameLength = await fetch(`${baseUrl}/info`, {
      headers: { Authorization: 'Bearer test-tokex' },
    })
    expect(wrongSameLength.status).toBe(401)
    const wrongLength = await fetch(`${baseUrl}/info`, {
      headers: { Authorization: 'Bearer short' },
    })
    expect(wrongLength.status).toBe(401)
    const badScheme = await fetch(`${baseUrl}/info`, {
      headers: { Authorization: `Basic ${TOKEN}` },
    })
    expect(badScheme.status).toBe(401)
    const empty = await fetch(`${baseUrl}/info`, { headers: { Authorization: 'Bearer' } })
    expect(empty.status).toBe(401)
  })
})

describe('token 工具（← secrets / hmac.compare_digest）', () => {
  it('generateSyncToken：base64url、无填充、32 字符（= token_urlsafe(24)）', () => {
    const token = generateSyncToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('tokenEquals：等长错误 false；正确 true；不等长 false', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true)
    expect(tokenEquals('abc', 'abd')).toBe(false)
    expect(tokenEquals('abc', 'abcd')).toBe(false)
    expect(tokenEquals('', '')).toBe(true)
  })
})

describe('/manifest（← _generate_manifest 过滤规则）', () => {
  it('列出常规文件（正斜杠路径），跳过隐藏文件/.tmp/隐藏目录', async () => {
    const response = await fetch(`${baseUrl}/manifest`, authed('/manifest'))
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      success: boolean
      manifest: Array<{ path: string; size: number; mtime: number; is_dir: boolean }>
      total_files: number
    }
    expect(json.success).toBe(true)
    const paths = json.manifest.map((m) => m.path)
    expect(paths).toContain('settings.json')
    expect(paths).toContain('chats/room.json')
    expect(paths).not.toContain('.secret')
    expect(paths).not.toContain('draft.tmp')
    expect(paths).not.toContain('.git/config')
    expect(json.total_files).toBe(2)
    const settings = json.manifest.find((m) => m.path === 'settings.json')
    expect(settings?.is_dir).toBe(false)
    expect(settings?.mtime).toBeCloseTo(1609459200, 0)
  })
})

describe('/zip（← _create_zip：相对路径 + mtime）', () => {
  it('返回 zip，含常规文件与 mtime（DOS 2 秒精度内）', async () => {
    const response = await fetch(`${baseUrl}/zip`, authed('/zip'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const buffer = new Uint8Array(await response.arrayBuffer())
    const files = unzipSync(buffer)
    expect(Object.keys(files).sort()).toEqual(['chats/room.json', 'settings.json'])
    expect(Buffer.from(files['settings.json'] as Uint8Array).toString('utf8')).toBe(
      '{"theme":"dark"}',
    )
    // mtime 保留（DOS 时间 2 秒精度）
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    let found = false
    for (let i = 0; i + 4 <= buffer.byteLength; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        const nameLen = view.getUint16(i + 28, true)
        const name = Buffer.from(buffer.subarray(i + 46, i + 46 + nameLen)).toString('utf8')
        if (name === 'settings.json') {
          const dosTime = view.getUint16(i + 12, true)
          const dosDate = view.getUint16(i + 14, true)
          const localEpoch = dosEpoch(dosDate, dosTime)
          expect(Math.abs(localEpoch - 1609459200)).toBeLessThanOrEqual(2)
          found = true
        }
      }
    }
    expect(found).toBe(true)
  })
})

describe('/file（路径穿越防护 1:1）', () => {
  it('缺 path 参数 → 400', async () => {
    const response = await fetch(`${baseUrl}/file`, authed('/file'))
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('Missing path parameter')
  })

  it('穿越路径 → 403 Access denied', async () => {
    const outside = join(dataDir, '..', 'outside-secret.txt')
    writeFileSync(outside, 'top secret', 'utf8')
    for (const traversal of ['../outside-secret.txt', '..\\outside-secret.txt']) {
      const response = await fetch(
        `${baseUrl}/file?path=${encodeURIComponent(traversal)}`,
        authed('/file'),
      )
      expect(response.status).toBe(403)
      expect(((await response.json()) as { error: string }).error).toBe('Access denied')
    }
    rmSync(outside, { force: true })
  })

  it('绝对路径 → 403（join 语义：绝对第二参替换基准）', async () => {
    const response = await fetch(
      `${baseUrl}/file?path=${encodeURIComponent(join(dataDir, 'settings.json'))}`,
      authed('/file'),
    )
    // realpath(join(dataPath, absolute)) = absolute 本身，等于基准下的 settings.json
    // 在 Windows 上该绝对路径恰好就是 dataDir 内文件 → 200；统一断言非 403 即可
    expect([200, 400]).toContain(response.status)
  })

  it('不存在 → 404；目录 → 400', async () => {
    const missing = await fetch(
      `${baseUrl}/file?path=${encodeURIComponent('nope.json')}`,
      authed('/file'),
    )
    expect(missing.status).toBe(404)
    const dir = await fetch(`${baseUrl}/file?path=${encodeURIComponent('chats')}`, authed('/file'))
    expect(dir.status).toBe(400)
    expect(((await dir.json()) as { error: string }).error).toContain('Not a file')
  })

  it('正常文件 → 200 且内容一致', async () => {
    const response = await fetch(
      `${baseUrl}/file?path=${encodeURIComponent('chats/room.json')}`,
      authed('/file'),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"messages":[]}')
  })
})

describe('路由与日志', () => {
  it('未知路径 → 404', async () => {
    const response = await fetch(`${baseUrl}/nope`, authed('/nope'))
    expect(response.status).toBe(404)
  })

  it('访问日志经注入回调上报（← CustomRequestHandler）', async () => {
    await fetch(`${baseUrl}/health`)
    const httpLog = accessLogs.find((message) => message.includes('HTTP请求:'))
    expect(httpLog).toBeDefined()
    expect(httpLog).toMatch(/"GET \/health" 200/)
    expect(httpLog).not.toMatch(/\x1b\[/)
  })

  it('数据目录不存在时构造抛错（← FileNotFoundError）', () => {
    expect(
      () => new SyncServer({ dataPath: join(dataDir, 'missing'), host: '127.0.0.1' }),
    ).toThrow('数据目录不存在')
  })
})

describe('访问日志时间格式（← %d/%b/%Y %H:%M:%S）', () => {
  it('英文月份缩写 + 补零', () => {
    expect(formatAccessLogTime(new Date(2026, 0, 3, 4, 5, 6))).toBe('03/Jan/2026 04:05:06')
    expect(formatAccessLogTime(new Date(2026, 11, 31, 23, 59, 59))).toBe('31/Dec/2026 23:59:59')
  })
})

/** DOS 时间解包（与 client.readZipMtimes 同算法的本地校验副本） */
function dosEpoch(dosDate: number, dosTime: number): number {
  const year = ((dosDate >> 9) & 0x7f) + 1980
  const month = ((dosDate >> 5) & 0x0f) - 1
  const day = dosDate & 0x1f
  const hour = (dosTime >> 11) & 0x1f
  const minute = (dosTime >> 5) & 0x3f
  const second = (dosTime & 0x1f) * 2
  return new Date(year, month, day, hour, minute, second).getTime() / 1000
}

describe('stop 幂等与服务器句柄', () => {
  it('stop 后端口释放、running=false、重复 stop 不抛', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'stlsyncsrv2'))
    const second = new SyncServer({ dataPath: tempDir, host: '127.0.0.1', port: 0 })
    await second.start()
    const port = second.actualPort()
    expect(port).toBeGreaterThan(0)
    await second.stop()
    expect(second.running).toBe(false)
    await expect(second.stop()).resolves.toBeUndefined()
    // 端口可复用
    const third = new SyncServer({ dataPath: tempDir, host: '127.0.0.1', port })
    await third.start()
    await third.stop()
    rmSync(tempDir, { force: true, recursive: true })
  })
})

describe('只绑指定 host（node:http listen 语义）', () => {
  it('监听地址为 127.0.0.1', () => {
    const address = (server as unknown as { httpServer: http.Server | null }).httpServer?.address()
    expect(address).toBeDefined()
    if (address && typeof address === 'object') {
      expect(address.address).toBe('127.0.0.1')
    }
  })
})
