/**
 * ← src/features/sync/server.py（SyncServer，Flask → node:http 手写路由）
 *
 * 关键工程事实：vitest 进程跑在 Node，生产宿主是 Bun——两侧都完全兼容
 * node:http，故 HTTP 服务器统一用 node:http + 手写路由（一份代码两边能跑）。
 *
 * 安全纪律（与 Python 1:1）：
 * - Bearer token 鉴权：除 GET /health 全部鉴权，crypto.timingSafeEqual
 *   常数时间比较（长度不等直接拒绝，等价 hmac.compare_digest 行为）。
 * - token 生成：crypto.randomBytes(24) → base64url（= secrets.token_urlsafe(24)）。
 * - /file 路径穿越防护：realpath 遏制在 data_path 内。
 * - 只绑 LAN IP：显式 host（Python 语义：host 未指定时取局域网 IP，
 *   绝不 0.0.0.0）。
 *
 * DEVIATION: Python 整包 zip 在内存 BytesIO 中构造后 send_file；
 *   TS 侧 zipSync 同样内存构造后一次性写出（语义等价，响应端流式发送）。
 * DEVIATION: manifest 的 modified 字段用 toISOString()（带 Z 与毫秒），
 *   Python 为本地时区无时区标记；该字段仅用于展示，不参与同步比较。
 */
import * as http from 'node:http'
import { createReadStream } from 'node:fs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import { zipSync } from 'fflate'
import { isDirSync, realpathBestEffort } from '../atomicFs'
import { getLocalIp } from '../network'

export type SyncLogLevel = 'info' | 'success' | 'warning' | 'error'
export type SyncLogCallback = (message: string, level: SyncLogLevel) => void

/** ← manifest 条目（与 Python 字段一一对应） */
export interface ManifestEntry {
  path: string
  size: number
  mtime: number
  modified: string
  is_dir: boolean
}

/** ← secrets.token_urlsafe(24)：24 字节随机 → base64url（无填充） */
export function generateSyncToken(): string {
  return randomBytes(24).toString('base64url')
}

/** ← hmac.compare_digest(provided, expected)：长度不等直接 false */
export function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * ← werkzeug 访问日志时间格式 '%d/%b/%Y %H:%M:%S'
 *（Python 平台本地化月份缩写按 C locale 英文输出）。
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatAccessLogTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${pad(date.getDate())}/${MONTHS[date.getMonth()]}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export interface SyncServerOptions {
  /** SillyTavern 数据目录（默认自动探测） */
  dataPath?: string
  port?: number
  /** 监听地址；未指定时自动获取局域网 IP（只绑 LAN，绝不 0.0.0.0） */
  host?: string
  authToken?: string
  /** 访问/生命周期日志回调（← set_ui_log_callback） */
  log?: SyncLogCallback
  /** 局域网 IP 获取（默认 network 服务；测试注入） */
  getLanIp?: () => Promise<string | null>
  /** 是否校验数据目录存在（默认 true；测试空目录场景可关） */
  requireDataPath?: boolean
  now?: () => Date
}

interface WalkEntry {
  file: string
  filePath: string
}

/** ← os.walk + 隐藏目录过滤（原地修改 dirs 语义） */
function walkFiles(root: string, skipHiddenDirs: boolean): WalkEntry[] {
  const results: WalkEntry[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(fullPath).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (skipHiddenDirs && entry.startsWith('.')) continue
        stack.push(fullPath)
      } else {
        results.push({ file: entry, filePath: fullPath })
      }
    }
  }
  return results
}

export class SyncServer {
  readonly port: number
  readonly host: string
  readonly dataPath: string
  readonly authToken: string

  running = false
  private httpServer: http.Server | null = null
  private log: SyncLogCallback
  private readonly now: () => Date

  constructor(options: SyncServerOptions = {}) {
    this.port = options.port ?? 9999
    // 如果没有指定 host，由调用方先解析局域网 IP 再构造（见 createSyncServer）
    this.host = options.host ?? '192.168.1.100'
    this.dataPath = options.dataPath ?? findDataPath()
    this.authToken = options.authToken ?? generateSyncToken()
    this.log = options.log ?? ((message) => console.log(message))
    this.now = options.now ?? (() => new Date())

    // Validate data path
    if ((options.requireDataPath ?? true) && !isDirSync(this.dataPath)) {
      throw new Error(`数据目录不存在: ${this.dataPath}`)
    }

    this.log('数据同步服务已初始化', 'info')
    this.log(`数据路径: ${this.dataPath}`, 'info')
    this.log(`监听地址: ${this.host}:${this.port}`, 'info')
    this.log('注意: 服务器仅在局域网内监听，确保安全性', 'info')
  }

  /** ← set_ui_log_callback */
  setUiLogCallback(callback: SyncLogCallback): void {
    this.log = callback
  }

  // -------------------------------------------------------------------------
  // 路由（← _setup_routes）
  // -------------------------------------------------------------------------

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(payload)
  }

  /** ← before_request require_authentication */
  private isAuthorized(req: http.IncomingMessage): boolean {
    const authorization = req.headers.authorization ?? ''
    const spaceIndex = authorization.indexOf(' ')
    const scheme = spaceIndex === -1 ? authorization : authorization.slice(0, spaceIndex)
    const providedToken = spaceIndex === -1 ? '' : authorization.slice(spaceIndex + 1)
    if (scheme.toLowerCase() !== 'bearer' || !providedToken) return false
    return tokenEquals(providedToken, this.authToken)
  }

  /** 访问日志（← CustomRequestHandler.log_request） */
  private accessLog(req: http.IncomingMessage, status: number): void {
    try {
      const clientIp = req.socket.remoteAddress ?? '-'
      const method = req.method ?? '-'
      const path = req.url ?? '/'
      const userAgent = req.headers['user-agent'] ?? '-'
      const referer = req.headers.referer ?? '-'
      const timestamp = formatAccessLogTime(this.now())
      // 格式：IP - - [timestamp] "METHOD path" status "User-Agent" "Referer"
      const logMessage =
        `${clientIp} - - [${timestamp}] "${method} ${path}" ${status} ` +
        `"${userAgent}" "${referer}"`
      // 移除 ANSI 转义码（如有）
      const clean = logMessage.replace(/\x1b\[[0-9;]*m/g, '')
      this.log(`HTTP请求: ${clean}`, 'info')
    } catch {
      // 自定义请求日志失败不影响请求
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/'
    const parsed = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`)
    const pathname = parsed.pathname

    // GET /health：发现端点，唯一免鉴权路由
    if (pathname === '/health') {
      this.sendJson(res, 200, {
        status: 'healthy',
        timestamp: this.now().toISOString(),
        auth_required: true,
      })
      return
    }

    // Bearer 鉴权（其余全部端点）
    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { success: false, error: 'Authentication required' })
      return
    }

    if (req.method !== 'GET') {
      this.sendJson(res, 405, { success: false, error: 'Method Not Allowed' })
      return
    }

    if (pathname === '/manifest') {
      try {
        const manifest = this.generateManifest()
        this.sendJson(res, 200, {
          success: true,
          manifest,
          total_files: manifest.length,
          generated_at: this.now().toISOString(),
        })
      } catch (err) {
        this.sendJson(res, 500, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (pathname === '/zip') {
      try {
        const zipBuffer = this.createZip()
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zipBuffer.length,
        })
        res.end(zipBuffer)
      } catch (err) {
        this.sendJson(res, 500, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (pathname === '/file') {
      await this.handleFile(parsed, res)
      return
    }

    if (pathname === '/info') {
      this.sendJson(res, 200, {
        success: true,
        server_info: {
          port: this.port,
          host: this.host,
          running: this.running,
          total_size: this.calculateTotalSize(),
          file_count: this.generateManifest().length,
        },
      })
      return
    }

    this.sendJson(res, 404, { success: false, error: 'Not Found' })
  }

  /** ← /file 路由（含路径穿越防护） */
  private async handleFile(parsed: URL, res: http.ServerResponse): Promise<void> {
    const filePath = parsed.searchParams.get('path')
    if (!filePath) {
      this.sendJson(res, 400, { success: false, error: 'Missing path parameter' })
      return
    }

    try {
      // Security check - prevent directory traversal
      const base = realpathBestEffort(this.dataPath)
      const fullPath = realpathBestEffort(resolve(this.dataPath, filePath))

      if (fullPath !== base && !fullPath.startsWith(base + sep)) {
        this.sendJson(res, 403, { success: false, error: 'Access denied' })
        return
      }

      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(fullPath)
      } catch {
        this.sendJson(res, 404, { success: false, error: 'File not found' })
        return
      }

      if (!stat.isFile()) {
        this.sendJson(res, 400, { success: false, error: `Not a file: ${filePath}` })
        return
      }

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
      })
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const stream = createReadStream(fullPath)
        stream.on('error', rejectPromise)
        res.on('close', () => {
          stream.destroy()
          resolvePromise()
        })
        stream.on('end', resolvePromise)
        stream.pipe(res)
      })
    } catch (err) {
      this.sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // -------------------------------------------------------------------------
  // 数据生成（← _generate_manifest / _create_zip / _calculate_total_size）
  // -------------------------------------------------------------------------

  /** ← _generate_manifest：隐藏目录/隐藏文件/.tmp 跳过，路径归一为正斜杠 */
  generateManifest(): ManifestEntry[] {
    const manifest: ManifestEntry[] = []
    for (const { file, filePath } of walkFiles(this.dataPath, true)) {
      if (file.startsWith('.') || file.endsWith('.tmp')) continue
      const relativePath = relative(this.dataPath, filePath).replace(/\\/g, '/')
      try {
        const statInfo = statSync(filePath)
        manifest.push({
          path: relativePath,
          size: statInfo.size,
          mtime: statInfo.mtimeMs / 1000,
          modified: new Date(statInfo.mtimeMs).toISOString(),
          is_dir: false,
        })
      } catch {
        // Skip files that can't be accessed
      }
    }
    return manifest
  }

  /** ← _create_zip：fflate 打包（保持相对路径与 mtime，正斜杠分隔） */
  createZip(): Uint8Array {
    const files: Record<string, [Uint8Array, { mtime: Date }]> = {}
    for (const { file, filePath } of walkFiles(this.dataPath, true)) {
      if (file.startsWith('.') || file.endsWith('.tmp')) continue
      const relativePath = relative(this.dataPath, filePath).replace(/\\/g, '/')
      try {
        // ← zipfile.write(file_path, relative_path)：deflate + 保留 mtime
        files[relativePath] = [readFileSync(filePath), { mtime: new Date(statSync(filePath).mtimeMs) }]
      } catch {
        // Skip files that can't be accessed
      }
    }
    return zipSync(files)
  }

  /** ← _calculate_total_size：全部文件累计（不跳隐藏） */
  calculateTotalSize(): number {
    let totalSize = 0
    for (const { filePath } of walkFiles(this.dataPath, false)) {
      try {
        totalSize += statSync(filePath).size
      } catch {
        // continue
      }
    }
    return totalSize
  }

  // -------------------------------------------------------------------------
  // 生命周期（← start / stop）
  // -------------------------------------------------------------------------

  /** 启动 HTTP 服务器（node:http 显式绑定 host → 只在该网卡监听） */
  async start(): Promise<void> {
    if (this.running) {
      this.log('数据同步服务已在运行', 'warning')
      return
    }
    this.running = true

    const server = http.createServer((req, res) => {
      res.on('finish', () => {
        this.accessLog(req, res.statusCode)
      })
      this.handle(req, res).catch(() => {
        if (!res.headersSent) {
          this.sendJson(res, 500, { success: false, error: 'Internal Server Error' })
        } else {
          res.destroy()
        }
      })
    })
    this.httpServer = server

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(this.port, this.host, () => {
        server.removeListener('error', rejectPromise)
        resolvePromise()
      })
    })

    const shareUrl = `http://${this.host}:${this.actualPort()}#token=${this.authToken}`
    this.log(`数据同步服务已启动在后台: ${shareUrl}`, 'success')
    this.log('可用接口:', 'info')
    this.log('  GET /health      - 健康检查', 'info')
    this.log('  GET /manifest    - 获取文件清单', 'info')
    this.log('  GET /zip         - 下载所有数据(ZIP)', 'info')
    this.log('  GET /file?path=  - 下载指定文件', 'info')
    this.log('  GET /info        - 服务器信息', 'info')
  }

  /** 实际监听端口（port=0 随机分配时用于测试） */
  actualPort(): number {
    const address = this.httpServer?.address()
    if (address && typeof address === 'object') return address.port
    return this.port
  }

  /** 分享 URL（token 放 fragment，不随请求发送） */
  getShareUrl(): string {
    return `http://${this.host}:${this.actualPort()}#token=${this.authToken}`
  }

  /** ← stop：优雅关闭（close + closeAllConnections） */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    const server = this.httpServer
    this.httpServer = null
    if (server) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(), 5000)
        // Node 18.2+：强制断开 keep-alive 连接，等价 werkzeug shutdown
        server.closeAllConnections?.()
        server.close(() => {
          clearTimeout(timer)
          resolvePromise()
        })
      })
    }
    this.log('数据同步服务已停止', 'info')
  }
}

/** ← _find_data_path（server 版：仅存在性检查） */
export function findDataPath(): string {
  const possiblePaths = [
    join(process.cwd(), 'SillyTavern', 'data', 'default-user'),
    join(process.cwd(), 'data', 'default-user'),
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'SillyTavern', 'data', 'default-user'),
    join('.', 'SillyTavern', 'data', 'default-user'),
  ]
  for (const path of possiblePaths) {
    if (isDirSync(path)) return path
  }
  return join(process.cwd(), 'SillyTavern', 'data', 'default-user')
}

/**
 * 工厂：host 未指定时先解析局域网 IP 再构造
 *（Python 构造函数内同步取 IP；TS 的 os.networkInterfaces 版本为异步，
 *  故拆成异步工厂，语义一致：取不到则回退 192.168.1.100）。
 */
export async function createSyncServer(options: SyncServerOptions = {}): Promise<SyncServer> {
  let host = options.host
  if (!host) {
    const lanIp = await getLocalIp()
    host = lanIp ?? '192.168.1.100'
  }
  return new SyncServer({ ...options, host })
}
