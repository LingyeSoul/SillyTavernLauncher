/**
 * 同步服务器真机验证：Bun 生产宿主上的端到端链路（单测跑在 Node，此处补 Bun 侧闭环）。
 * 运行：bun scripts/verify-sync-live.ts（从 src/ 目录）
 * 步骤：manager 起服务（127.0.0.1 随机端口）→ 鉴权/穿越/清单/zip 端点逐项核对
 *       → 客户端 ZIP 全量同步 → 增量无差异 → 远端变更（改/增/删）增量收敛
 *       → 运行守卫 → 停服端口释放。
 * 数据全部落在系统临时目录，不触碰仓库与真实 SillyTavern 数据。
 */
import {
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { DataSyncManager } from '../services/sync/manager'
import { readZipMtimes } from '../services/sync/client'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail}`}`)
}

/** 递归收集相对路径（正斜杠）→ 内容 Buffer（忽略空目录） */
function snapshot(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`)
      else out.set(`${prefix}${entry}`, readFileSync(full))
    }
  }
  walk(root, '')
  return out
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'stl-sync-live-'))
  const serverData = join(tempRoot, 'server-data')
  const clientData = join(tempRoot, 'client-data')
  const logs: string[] = []
  const log = (message: string): void => {
    logs.push(message)
  }

  try {
    // ---- 服务端数据：常规 3 个（含嵌套/二进制/中文）+ 应被过滤的隐藏目录/.tmp/隐藏文件 ----
    mkdirSync(join(serverData, 'chats'), { recursive: true })
    mkdirSync(join(serverData, 'characters'), { recursive: true })
    mkdirSync(join(serverData, '.hidden'), { recursive: true })
    writeFileSync(join(serverData, 'settings.json'), '{"theme":"dark","名字":"测试"}')
    writeFileSync(join(serverData, 'chats', 'scene.json'), '{"turns":[1,2,3]}')
    writeFileSync(join(serverData, 'characters', 'card.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x20]))
    writeFileSync(join(serverData, '.hidden', 'secret.txt'), 'SHOULD_NOT_SYNC')
    writeFileSync(join(serverData, 'notes.tmp'), 'tmp-should-skip')
    writeFileSync(join(serverData, '.env'), 'hidden-file-should-skip')
    // 穿越目标：数据目录同级
    writeFileSync(join(tempRoot, 'escapeme.txt'), 'OUTSIDE')

    // ---- manager 起 server（生产入口路径；configStore:null 不落盘）----
    const serverManager = new DataSyncManager({ dataDir: serverData, configStore: null, log })
    await serverManager.initialize()
    const started = await serverManager.startSyncServer({ host: '127.0.0.1', port: 0 })
    check('manager.startSyncServer 成功（Bun 宿主）', started && serverManager.isServerRunning)
    const port = serverManager.syncServer?.actualPort() ?? 0
    const token = serverManager.authToken
    const base = `http://127.0.0.1:${port}`
    const clientUrl = `${base}#token=${token}`
    const authedHeaders = { Authorization: `Bearer ${token}` }

    // ---- /health 免鉴权 ----
    const health = await fetch(`${base}/health`)
    const healthBody = (await health.json()) as { status?: string; auth_required?: boolean }
    check(
      '/health 免鉴权返回 healthy + auth_required',
      health.status === 200 && healthBody.status === 'healthy' && healthBody.auth_required === true,
      `status=${health.status} body=${JSON.stringify(healthBody)}`,
    )

    // ---- 数据端点缺 token / 错误 token → 401 ----
    const noAuth = await fetch(`${base}/manifest`)
    check('/manifest 缺 token → 401', noAuth.status === 401)
    const wrongToken = await fetch(`${base}/manifest`, {
      headers: { Authorization: `Bearer ${'x'.repeat(token.length)}` },
    })
    check('/manifest 错误 token（等长）→ 401', wrongToken.status === 401)

    // ---- /manifest：3 个常规文件、正斜杠路径、过滤规则 ----
    const manifestRes = await fetch(`${base}/manifest`, { headers: authedHeaders })
    const manifestData = (await manifestRes.json()) as { total_files?: number; manifest?: { path: string }[] }
    const paths = (manifestData.manifest ?? []).map((m) => m.path).sort()
    check(
      '/manifest 列出 3 个常规文件（跳过隐藏/.tmp），路径正斜杠',
      manifestRes.status === 200 &&
        manifestData.total_files === 3 &&
        paths.join('|') === 'characters/card.png|chats/scene.json|settings.json',
      `paths=${paths.join('|')}`,
    )

    // ---- /file 路径穿越 → 403 ----
    const traversal = await fetch(`${base}/file?path=${encodeURIComponent('../escapeme.txt')}`, { headers: authedHeaders })
    check('/file 穿越路径 → 403', traversal.status === 403, `status=${traversal.status}`)
    const absPath = await fetch(`${base}/file?path=${encodeURIComponent(join(tempRoot, 'escapeme.txt'))}`, {
      headers: authedHeaders,
    })
    check('/file 绝对路径 → 403', absPath.status === 403, `status=${absPath.status}`)

    // ---- /zip：可解包、内容一致、mtime 保留（DOS 2 秒精度内）----
    const zipRes = await fetch(`${base}/zip`, { headers: authedHeaders })
    const zipU8 = new Uint8Array(await zipRes.arrayBuffer())
    const unzipped = unzipSync(zipU8)
    const mtimes = readZipMtimes(zipU8)
    const expectFiles = ['settings.json', 'chats/scene.json', 'characters/card.png']
    const zipNamesOk =
      expectFiles.every((n) => unzipped[n] !== undefined) && Object.keys(unzipped).length === 3
    let zipMtimeOk = true
    for (const name of expectFiles) {
      const remoteMtime = mtimes.get(name) ?? 0
      const srcMtime = statSync(join(serverData, name)).mtimeMs / 1000
      if (Math.abs(remoteMtime - srcMtime) > 2) zipMtimeOk = false // DOS 时间戳 2 秒精度
    }
    check(
      '/zip 返回 3 文件且内容一致（含二进制/UTF-8）',
      zipRes.status === 200 &&
        zipNamesOk &&
        Buffer.from(unzipped['settings.json'] as Uint8Array).toString() === '{"theme":"dark","名字":"测试"}' &&
        Buffer.from(unzipped['characters/card.png'] as Uint8Array).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x20]),
        ),
    )
    check('/zip 中央目录 mtime 与源文件一致（±2s）', zipMtimeOk)

    // ---- /info ----
    const infoRes = await fetch(`${base}/info`, { headers: authedHeaders })
    const infoData = (await infoRes.json()) as { server_info?: { file_count?: number; running?: boolean } }
    check(
      '/info 返回 file_count=3、running=true',
      infoData.server_info?.file_count === 3 && infoData.server_info?.running === true,
    )

    // ---- 客户端：ZIP 全量同步（走 manager 生产入口 syncFromServer）----
    const clientManager = new DataSyncManager({ dataDir: clientData, configStore: null, log })
    await clientManager.initialize()
    const sync1 = await clientManager.syncFromServer(clientUrl, { method: 'zip', backup: true })
    const snap1 = snapshot(clientData)
    check(
      '客户端 ZIP 全量同步成功且内容一致',
      sync1 &&
        snap1.size === 3 &&
        snap1.get('settings.json')?.toString() === '{"theme":"dark","名字":"测试"}' &&
        snap1.get('characters/card.png')?.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x20])) === true,
      `sync1=${sync1} files=${[...snap1.keys()].join('|')}`,
    )
    let extractMtimeOk = true
    for (const name of expectFiles) {
      const localMtime = statSync(join(clientData, name)).mtimeMs / 1000
      const srcMtime = statSync(join(serverData, name)).mtimeMs / 1000
      if (Math.abs(localMtime - srcMtime) > 2) extractMtimeOk = false
    }
    check('解压后 mtime 保留（±2s）', extractMtimeOk)

    // ---- 增量：无差异 ----
    // 已知行为（自 Python 1:1 移植）：ZIP DOS 时间戳 2s 向下量化，解压后本地 mtime 可早于
    // 远端全精度 mtime → 首次增量可能整批重拉一遍（数据无损，重拉后 mtime 精确回写自愈）。
    const sync2 = await clientManager.syncFromServer(clientUrl, { method: 'incremental' })
    const noDiff = logs.some((l) => l.includes('数据已是最新'))
    check('增量同步（ZIP 全量后）：成功', sync2 === true)
    if (noDiff) {
      console.log('✅ 增量同步（ZIP 全量后）：无差异直接成功')
    } else {
      console.log('⚠️ 已知量化效应：ZIP 全量后首次增量整批重拉（DOS 2s 截断），验证自愈…')
    }
    const sync2b = await clientManager.syncFromServer(clientUrl, { method: 'incremental' })
    check('增量同步自愈：随后一次无差异（量化重拉后 mtime 已精确对齐）', sync2b === true && logs.filter((l) => l.includes('数据已是最新')).length >= (noDiff ? 2 : 1))

    // ---- 远端变更：改（mtime 推到 +1h 确保触发）+ 增 + 删 ----
    writeFileSync(join(serverData, 'settings.json'), '{"theme":"light","名字":"更新"}')
    const future = Date.now() / 1000 + 3600
    utimesSync(join(serverData, 'settings.json'), future, future)
    mkdirSync(join(serverData, 'assets'), { recursive: true })
    writeFileSync(join(serverData, 'assets', 'new.bin'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
    utimesSync(join(serverData, 'assets', 'new.bin'), future, future)
    rmSync(join(serverData, 'chats', 'scene.json'))
    const sync3 = await clientManager.syncFromServer(clientUrl, { method: 'incremental' })
    const snap3 = snapshot(clientData)
    check(
      '增量同步收敛远端变更（改+增+删）',
      sync3 &&
        snap3.get('settings.json')?.toString() === '{"theme":"light","名字":"更新"}' &&
        snap3.get('assets/new.bin')?.equals(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])) === true &&
        !snap3.has('chats/scene.json') &&
        snap3.size === 3,
      `sync3=${sync3} files=${[...snap3.keys()].join('|')}`,
    )

    // ---- 守卫：服务器运行时该 manager 拒绝本机同步（防自覆盖）----
    const guardRes = await serverManager.syncFromServer(clientUrl, { method: 'incremental' })
    check(
      '守卫：服务器运行时拒绝本机发起同步',
      guardRes === false && logs.some((l) => l.includes('服务器正在运行时无法同步数据')),
    )

    // ---- 停服：端口释放、幂等 ----
    const stopped = await serverManager.stopSyncServer()
    let healthAfterStop = 'connected'
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
    } catch {
      healthAfterStop = 'refused'
    }
    check('stopSyncServer 成功且端口释放', stopped && healthAfterStop === 'refused')
    const stoppedAgain = await serverManager.stopSyncServer()
    check('重复 stop 幂等', stoppedAgain && !serverManager.isServerRunning)

    console.log(`\nℹ️  运行日志 ${logs.length} 条（访问日志/进度/生命周期均经回调上报）`)
    console.log(failures === 0 ? '\n🟢 全部通过' : `\n🔴 ${failures} 项失败`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
    if (existsSync(tempRoot)) console.error('⚠️ 临时目录清理失败:', tempRoot)
  }
}

await main()
