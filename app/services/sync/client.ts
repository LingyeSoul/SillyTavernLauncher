/**
 * ← src/features/sync/client.py（SyncClient，requests.Session → fetch）
 *
 * 安全纪律（与 Python 1:1）：
 * - token 从 URL fragment 解析（http://host:port#token=...），
 *   绝不出现在请求 URL / query 中，仅放入 Authorization: Bearer 头。
 * - ZIP 解压逐 entry realpath 遏制（Zip-Slip），越界条目跳过并记录。
 * - 网络请求全部带超时（AbortSignal.timeout 语义，DEVIATION：fetch 无法
 *   分离连接/读取超时，用总超时 = 2×timeout 秒，对应 Python (t, 2t) 上界）。
 *
 * DEVIATION: fflate unzipSync 不暴露条目 mtime，另以中央目录解析器读取
 *   DOS 时间戳，解压后 utimes 回写——保持 Python zipfile.extractall 的
 *   mtime 保留语义（否则全量同步后增量会全量重下载）。
 * DEVIATION: requests.Session 连接池无 fetch 等价；close() 保留为空操作
 *   兼容调用方。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createWriteStream } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { unzipSync } from 'fflate'
import { isDirSync, realpathBestEffort } from '../atomicFs'
import type { ManifestEntry } from './server'

export type FetchImpl = typeof fetch

export interface SyncClientOptions {
  /** 请求超时（秒），默认 30 */
  timeoutSec?: number
  /** 备份根目录（默认 <cwd>/backup） */
  backupRoot?: string
  /** 日志回调（Python print 的等价物） */
  log?: (message: string) => void
  /** fetch 实现（测试注入） */
  fetchImpl?: FetchImpl
}

// ---------------------------------------------------------------------------
// 超时信号组合（外部取消 + 总超时）
// ---------------------------------------------------------------------------

export function createTimeoutSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时: 超过 ${timeoutMs} ms`)), timeoutMs)
  const onExternalAbort = (): void => {
    clearTimeout(timer)
    controller.abort(external?.reason)
  }
  if (external) {
    if (external.aborted) {
      clearTimeout(timer)
      controller.abort(external.reason)
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true })
    }
  }
  // 信号结束联动清理（避免悬挂 timer）
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }, { once: true })
  return controller.signal
}

// ---------------------------------------------------------------------------
// ZIP 中央目录 mtime 解析（DOS 时间戳 → epoch 秒）
// ---------------------------------------------------------------------------

/** DOS 日期/时间（各 16 位）→ Unix epoch 秒（本地时区，与 zipfile 一致） */
export function dosDateTimeToEpoch(dosDate: number, dosTime: number): number {
  const year = ((dosDate >> 9) & 0x7f) + 1980
  const month = ((dosDate >> 5) & 0x0f) - 1
  const day = dosDate & 0x1f
  const hour = (dosTime >> 11) & 0x1f
  const minute = (dosTime >> 5) & 0x3f
  const second = (dosTime & 0x1f) * 2
  // Date 构造器按本地时区解释分量 ← datetime(y,m,d,...).timestamp()
  const date = new Date(year, month, day, hour, minute, second)
  const epoch = date.getTime() / 1000
  if (!Number.isFinite(epoch) || epoch < 0) return Date.now() / 1000
  return epoch
}

/**
 * 解析 ZIP 中央目录，返回 entry 名 → mtime（epoch 秒）。
 * fflate 的解压 API 不暴露 mtime，这里按 PKZIP APPNOTE 手工解析。
 */
export function readZipMtimes(buffer: Uint8Array): Map<string, number> {
  const result = new Map<string, number>()
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  // 1. 从尾部找 EOCD（0x06054b50）
  let eocd = -1
  for (let i = buffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) return result
  const entryCount = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)

  // 2. 遍历中央目录 entry（0x02014b50）
  let offset = cdOffset
  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== 0x02014b50) break
    const modTime = view.getUint16(offset + 12, true)
    const modDate = view.getUint16(offset + 14, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLen)
    const flags = view.getUint16(offset + 8, true)
    // bit 11 = UTF-8 文件名；未置位时按 cp437，ASCII 子集两者一致
    const name = new TextDecoder((flags & 0x800) !== 0 ? 'utf-8' : 'latin1').decode(nameBytes)
    result.set(name, dosDateTimeToEpoch(modDate, modTime))
    offset += 46 + nameLen + extraLen + commentLen
  }
  return result
}

// ---------------------------------------------------------------------------
// 本地 manifest（← get_local_manifest，与 server 端同规则）
// ---------------------------------------------------------------------------

export function generateLocalManifest(dataPath: string): ManifestEntry[] {
  const manifest: ManifestEntry[] = []
  const stack: string[] = [dataPath]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue // 隐藏目录跳过（← dirs[:] = [not d.startswith('.')]）
      const fullPath = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(fullPath).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        stack.push(fullPath)
        continue
      }
      if (entry.startsWith('.') || entry.endsWith('.tmp')) continue
      const relativePath = relative(dataPath, fullPath).replace(/\\/g, '/')
      try {
        const statInfo = statSync(fullPath)
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
  }
  return manifest
}

// ---------------------------------------------------------------------------
// SyncClient
// ---------------------------------------------------------------------------

export class SyncClient {
  readonly serverUrl: string
  readonly authToken: string
  readonly dataPath: string
  private readonly timeoutSec: number
  private readonly backupRoot: string
  private readonly log: (message: string) => void
  private readonly fetchImpl: FetchImpl
  private lastBackupPath: string | null = null

  constructor(serverUrl: string, dataPath?: string, options: SyncClientOptions = {}) {
    let parsed: URL
    try {
      parsed = new URL(serverUrl.trim())
    } catch {
      throw new Error('同步服务器地址必须是有效的 HTTP(S) URL')
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname
    ) {
      throw new Error('同步服务器地址必须是有效的 HTTP(S) URL')
    }

    // token 从 URL fragment 解析（不随请求 URL 发送）
    this.authToken = new URLSearchParams(parsed.hash.slice(1)).get('token') ?? ''
    this.serverUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
    this.dataPath = dataPath ?? findDataPath()
    this.timeoutSec = options.timeoutSec ?? 30
    this.backupRoot = options.backupRoot ?? join(process.cwd(), 'backup')
    this.log = options.log ?? ((message) => console.log(message))
    this.fetchImpl = options.fetchImpl ?? fetch

    // Ensure data directory exists
    mkdirSync(this.dataPath, { recursive: true })
  }

  /** ← close（fetch 无连接池；保留空操作兼容 Python 调用方） */
  close(): void {
    // no-op
  }

  /** ← _request：GET + Bearer + 超时（fetch 版） */
  private async request(
    endpoint: string,
    options: { params?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const url = new URL(`${this.serverUrl}/${endpoint}`)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, value)
    }
    const headers: Record<string, string> = {}
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`

    // DEVIATION: fetch 无 (connect, read) 分离超时，用总超时 2×timeout 秒
    const signal = createTimeoutSignal(this.timeoutSec * 2 * 1000, options.signal)
    try {
      const response = await this.fetchImpl(url.toString(), { headers, signal })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return response
    } catch (err) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('同步已取消')
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`请求失败 ${endpoint}: ${message}`)
    }
  }

  /** ← check_server_health */
  async checkServerHealth(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.request('health', { signal })
      await response.json()
      this.log('服务器状态: 健康')
      return true
    } catch (err) {
      console.error(`[sync-client] 服务器健康检查失败: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** ← get_server_info */
  async getServerInfo(signal?: AbortSignal): Promise<{
    success: boolean
    server_info: { port: number; host: string; running: boolean; total_size: number; file_count: number }
  } | null> {
    try {
      const response = await this.request('info', { signal })
      return (await response.json()) as {
        success: boolean
        server_info: { port: number; host: string; running: boolean; total_size: number; file_count: number }
      }
    } catch (err) {
      console.error(`[sync-client] 获取服务器信息失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** ← get_remote_manifest */
  async getRemoteManifest(signal?: AbortSignal): Promise<ManifestEntry[] | null> {
    try {
      const response = await this.request('manifest', { signal })
      const data = (await response.json()) as { success?: boolean; manifest?: ManifestEntry[]; error?: string }
      if (data.success) {
        return data.manifest ?? []
      }
      throw new Error(data.error ?? '未知错误')
    } catch (err) {
      console.error(`[sync-client] 获取远程文件清单失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** ← get_local_manifest */
  getLocalManifest(): ManifestEntry[] {
    return generateLocalManifest(this.dataPath)
  }

  /** ← sync_full_zip：全量 ZIP 下载 → 临时文件 → 解压（含备份/恢复） */
  async syncFullZip(options: { backup?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    const backup = options.backup ?? true
    const signal = options.signal
    this.log('开始 ZIP 全量同步...')

    if (backup && !this.backupExistingData()) {
      console.error('[sync-client] 备份失败，取消同步')
      return false
    }

    let tempZipPath: string | null = null
    try {
      // Download ZIP file（流式写入临时文件）
      this.log('正在下载 ZIP 文件...')
      const response = await this.request('zip', { signal })
      tempZipPath = join(mkdtempSync(join(tmpdir(), 'stlsynczip')), 'data.zip')
      await pipeline(
        Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
        createWriteStream(tempZipPath),
      )

      // Extract ZIP file（Zip-Slip 防护 + mtime 保留）
      this.log('正在解压 ZIP 文件...')
      this.extractZip(tempZipPath, this.dataPath)

      this.log('ZIP 全量同步完成')
      return true
    } catch (err) {
      console.error(`[sync-client] ZIP 同步失败: ${err instanceof Error ? err.message : String(err)}`)
      if (backup) {
        this.log('尝试恢复备份...')
        this.restoreBackup()
      }
      return false
    } finally {
      // 确保临时文件被删除
      if (tempZipPath && existsSync(tempZipPath)) {
        try {
          rmSync(dirname(tempZipPath), { recursive: true, force: true })
        } catch (cleanupError) {
          console.error(
            `[sync-client] 清理临时文件失败: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          )
        }
      }
    }
  }

  /** ← _extract_zip_with_progress（Zip-Slip：不安全条目跳过而非中断） */
  private extractZip(zipPath: string, extractPath: string): void {
    const buffer = readFileSync(zipPath)
    const files = unzipSync(buffer)
    const mtimes = readZipMtimes(buffer)
    const realExtract = realpathBestEffort(extractPath)

    for (const [name, data] of Object.entries(files)) {
      // Skip directories
      if (name.endsWith('/')) continue

      // Zip Slip protection
      const memberPath = realpathBestEffort(resolve(extractPath, name))
      if (memberPath !== realExtract && !memberPath.startsWith(realExtract + sep)) {
        this.log(`跳过不安全的 ZIP 条目: ${name}`)
        continue
      }

      mkdirSync(dirname(memberPath), { recursive: true })
      writeFileSync(memberPath, data)
      // mtime 保留（Python zipfile.extractall 默认行为）
      const mtime = mtimes.get(name)
      if (mtime !== undefined) {
        try {
          utimesSync(memberPath, mtime, mtime)
        } catch {
          // 个别文件 utimes 失败不影响整体
        }
      }
    }
  }

  /** ← sync_incremental：mtime manifest diff，逐文件下载并保留 mtime */
  async syncIncremental(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const signal = options.signal
    this.log('开始增量同步...')

    try {
      // Get remote and local manifests
      this.log('获取文件清单...')
      const remoteManifest = await this.getRemoteManifest(signal)
      const localManifest = this.getLocalManifest()

      if (!remoteManifest) {
        this.log('无法获取远程文件清单')
        return false
      }

      // Create local manifest lookup
      const localFiles = new Map(localManifest.map((item) => [item.path, item]))

      // Analyze differences
      const filesToDownload: ManifestEntry[] = []
      const filesToDelete: string[] = []
      let totalSize = 0

      for (const remoteFile of remoteManifest) {
        const localFile = localFiles.get(remoteFile.path)
        if (!localFile) {
          filesToDownload.push(remoteFile)
          totalSize += remoteFile.size
        } else if (remoteFile.mtime > localFile.mtime) {
          filesToDownload.push(remoteFile)
          totalSize += remoteFile.size
        }
      }

      // Check for local files that don't exist remotely
      const remotePaths = new Set(remoteManifest.map((f) => f.path))
      for (const localPath of localFiles.keys()) {
        if (!remotePaths.has(localPath)) filesToDelete.push(localPath)
      }

      if (filesToDownload.length === 0 && filesToDelete.length === 0) {
        this.log('数据已是最新，无需同步')
        return true
      }

      this.log(`需要下载 ${filesToDownload.length} 个文件 (${formatSize(totalSize)})`)
      this.log(`需要删除 ${filesToDelete.length} 个文件`)

      // Delete obsolete files
      for (const filePath of filesToDelete) {
        const fullPath = join(this.dataPath, filePath)
        try {
          rmSync(fullPath, { force: true })
          this.log(`已删除: ${filePath}`)
        } catch (err) {
          this.log(`删除文件失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Download new/updated files
      let downloadedSize = 0
      let failures = 0
      for (let i = 0; i < filesToDownload.length; i++) {
        if (signal?.aborted) throw signal.reason ?? new Error('同步已取消')
        const fileInfo = filesToDownload[i] as ManifestEntry
        const success = await this.downloadFile(fileInfo, signal)
        if (success) {
          downloadedSize += fileInfo.size
          const progress = ((i + 1) / filesToDownload.length) * 100
          this.log(
            `进度: ${i + 1}/${filesToDownload.length} (${progress.toFixed(1)}%) - ` +
            `${formatSize(downloadedSize)}/${formatSize(totalSize)}`,
          )
        } else {
          failures += 1
          this.log(`下载失败: ${fileInfo.path}`)
        }
      }

      this.log('增量同步完成')
      return failures === 0
    } catch (err) {
      this.log(`增量同步失败: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** ← sync：自动回退（zip ↔ incremental） */
  async sync(
    options: { preferZip?: boolean; backup?: boolean; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const preferZip = options.preferZip ?? true
    const backup = options.backup ?? true
    const signal = options.signal
    this.log('开始数据同步...')

    // Check server health first
    if (!(await this.checkServerHealth(signal))) {
      return false
    }

    // Get server info
    const serverInfo = await this.getServerInfo(signal)
    if (serverInfo) {
      this.log('服务器信息:')
      this.log(`  文件数量: ${serverInfo.server_info?.file_count ?? 0}`)
      this.log(`  总大小: ${formatSize(serverInfo.server_info?.total_size ?? 0)}`)
    }

    if (preferZip) {
      this.log('尝试 ZIP 全量同步...')
      if (await this.syncFullZip({ backup, signal })) {
        return true
      }
      this.log('ZIP 同步失败，尝试增量同步...')
      return this.syncIncremental({ signal })
    }
    this.log('尝试增量同步...')
    if (await this.syncIncremental({ signal })) {
      return true
    }
    this.log('增量同步失败，尝试 ZIP 同步...')
    return this.syncFullZip({ backup, signal })
  }

  /** ← _download_file：下载单文件并保留远端 mtime */
  private async downloadFile(fileInfo: ManifestEntry, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.request('file', { params: { path: fileInfo.path }, signal })

      // Ensure directory exists
      const filePath = join(this.dataPath, fileInfo.path)
      mkdirSync(dirname(filePath), { recursive: true })

      // Save file（流式写入）
      await pipeline(
        Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
        createWriteStream(filePath),
      )

      // Set modification time to match remote
      try {
        utimesSync(filePath, fileInfo.mtime, fileInfo.mtime)
      } catch {
        // utimes 失败不视为下载失败（与 Python 一致性放宽）
      }
      return true
    } catch (err) {
      this.log(`下载文件失败 ${fileInfo.path}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** ← _backup_existing_data */
  private backupExistingData(): boolean {
    if (!isDirSync(this.dataPath) || readdirSync(this.dataPath).length === 0) {
      this.log('本地数据目录为空，无需备份')
      return true
    }

    mkdirSync(this.backupRoot, { recursive: true })

    // 使用数据目录的相对路径作为备份文件夹名
    const dataDirName = basename(this.dataPath.replace(/[\\/]+$/, ''))
    const timestamp = formatBackupTimestamp(new Date())
    const backupPath = join(this.backupRoot, `${dataDirName}_${timestamp}`)

    try {
      this.log(`备份现有数据到: ${backupPath}`)
      cpSync(this.dataPath, backupPath, { recursive: true })
      // Store backup path for potential restore
      this.lastBackupPath = backupPath
      return true
    } catch (err) {
      this.log(`备份失败: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** ← _restore_backup */
  restoreBackup(): boolean {
    if (!this.lastBackupPath) {
      this.log('没有找到备份文件')
      return false
    }
    if (!existsSync(this.lastBackupPath)) {
      this.log('备份文件不存在')
      return false
    }

    try {
      this.log(`从备份恢复: ${this.lastBackupPath}`)
      // Remove current data
      if (existsSync(this.dataPath)) {
        rmSync(this.dataPath, { recursive: true, force: true })
      }
      // Restore backup
      cpSync(this.lastBackupPath, this.dataPath, { recursive: true })
      this.log('数据恢复完成')
      return true
    } catch (err) {
      this.log(`恢复备份失败: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
}

/** ← datetime.now().strftime('%Y%m%d_%H%M%S') */
export function formatBackupTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** ← _format_size */
export function formatSize(sizeBytes: number): string {
  if (sizeBytes === 0) return '0B'
  const sizeNames = ['B', 'KB', 'MB', 'GB']
  let size = sizeBytes
  let i = 0
  while (size >= 1024 && i < sizeNames.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(1)}${sizeNames[i]}`
}

/** ← _find_data_path（client 版：目录或父目录存在即可） */
export function findDataPath(): string {
  const possiblePaths = [
    join(process.cwd(), 'SillyTavern', 'data', 'default-user'),
    join(process.cwd(), 'data', 'default-user'),
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'SillyTavern', 'data', 'default-user'),
    join('.', 'SillyTavern', 'data', 'default-user'),
  ]
  for (const path of possiblePaths) {
    if (isDirSync(path) || isDirSync(dirname(path))) return path
  }
  return join(process.cwd(), 'SillyTavern', 'data', 'default-user')
}
