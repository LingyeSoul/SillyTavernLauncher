/**
 * 局域网同步的协议面：manifest 条目形状、目录遍历与摘要规则、/info 响应形状。
 *
 * client 与 server 都依赖本模块，互不依赖——协议知识只此一份。此前
 * client.ts 与 server.ts 各写一份 sha256File 与 manifest 遍历规则，一致性
 * 只靠注释「与 server 端同规则」维持；今后协议规则变更只改这里。
 */
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

/** ← manifest 条目（与 Python 字段一一对应；sha256 为跨端协议字段，见下方说明） */
export interface ManifestEntry {
  path: string
  size: number
  mtime: number
  modified: string
  is_dir: boolean
  /**
   * 内容摘要（64 位 hex）。Termux 版启动器的同步客户端把 sha256 视为
   * manifest 必填字段（缺失即拒绝增量同步），且其增量比较以内容摘要为准、
   * 不依赖 mtime——为打通 Windows ↔ Termux 双端同步，本端 manifest 必须携带。
   * 兼容老版本服务器：字段可缺省 / 为 null，客户端回退 mtime 比较。
   */
  sha256?: string | null
}

export interface WalkEntry {
  file: string
  filePath: string
}

/** 流式计算文件 sha256（大文件不全量驻内存，对齐 Termux 端 buildManifest） */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** ← os.walk + 隐藏目录过滤（原地修改 dirs 语义） */
export function walkFiles(root: string, skipHiddenDirs: boolean): WalkEntry[] {
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

/** ← _generate_manifest：隐藏目录/隐藏文件/.tmp 跳过，路径归一为正斜杠；含流式 sha256（async） */
export async function buildManifest(dataPath: string): Promise<ManifestEntry[]> {
  const manifest: ManifestEntry[] = []
  for (const { file, filePath } of walkFiles(dataPath, true)) {
    if (file.startsWith('.') || file.endsWith('.tmp')) continue
    const relativePath = relative(dataPath, filePath).replace(/\\/g, '/')
    try {
      const statInfo = statSync(filePath)
      manifest.push({
        path: relativePath,
        size: statInfo.size,
        mtime: statInfo.mtimeMs / 1000,
        modified: new Date(statInfo.mtimeMs).toISOString(),
        is_dir: false,
        sha256: await sha256File(filePath),
      })
    } catch {
      // Skip files that can't be accessed
    }
  }
  return manifest
}

/** /info 响应里的服务器信息（client 消费、server 构造） */
export interface ServerInfo {
  port: number
  host: string
  running: boolean
  total_size: number
  file_count: number
}

/** /info 响应形状 */
export interface InfoResponse {
  success: boolean
  server_info: ServerInfo
}
