/**
 * onefile 打包脚本：产出单文件发行 exe（bun build --compile）。
 *
 * 用法（在 src/ 下执行）：
 *   bun scripts/build-onefile.ts               # 全流程：门禁 → 编译 → 验证 → 冒烟
 *   bun scripts/build-onefile.ts --skip-tests  # 跳过 typecheck/单测（快速迭代用）
 *   bun scripts/build-onefile.ts --skip-smoke  # 跳过运行冒烟（无图形环境时）
 *
 * 产物（项目根 dist/，已 gitignore）：
 *   dist/SillyTavernLauncher-<version>-win-x64.exe  # 带版本号，Release 上传用
 *
 * 设计要点：
 * - 门禁红线：默认先跑 typecheck + unit 测试，失败即中止——不打包坏代码
 * - exe 图标：运行时用 src/assets/logo.png + windowIcon 纯函数生成多尺寸
 *   PNG-entry ICO（16~256 七档），与标题栏 WM_SETICON 同一套缩放算法，
 *   视觉表现一致；嵌入经 --windows-icon，Win32 FFI 路径与此互补。
 *   目录条目必须降序（256 在首）——legacy shell 取首条目再缩放，
 *   升序 = 16px 被放大到所有尺寸 = 发糊
 * - 版本资源：版权 Copyright (c) 2026 LingyeSoul；公司名单空格占位不显示
 * - 版本三处同步：version.ts ↔ package.json（此处校验）→ 文件名 + PE 元数据
 * - --windows-hide-console：GUI 子系统，双击不弹黑窗（exe 内 console.log
 *   仍写入 logs/，诊断不受影响）
 * - 冒烟验证：临时目录冷启动 exe，判定信号 = 进程存活 ≥5s 且主窗口已创建
 *   （GetTopWindow/GetWindow 链 标题+PID 双匹配，复用 services/windowIcon 枚举）。
 *   不依赖磁盘副作用与网络——旧版等 config/agreement/logs 落盘，而冷启动唯一
 *   可靠落盘是 EULA 远端抓取缓存，网络抖动即误报（RCA 2026-09-20）。
 *   STL_SKIP_AGREEMENT_RECHECK=1 对齐 E2E 种子环境（首启 EULA 仍会后台抓
 *   远端协议，但不参与判定）。冒烟会在本机短暂弹出启动器窗口后强杀，与 E2E 一致
 *
 * DEVIATION: 子进程不经 services/runtime.ts——那是应用运行时纪律；本脚本与
 *   scripts/verify-*.ts 同构，直接 Bun.spawnSync + 数组参数（仍禁 shell 拼接）。
 * DEVIATION: 构建失败只 console.error + 非零退出，不写 errorLog（logs/ 属于
 *   应用运行时产物，打包脚本不得污染安装根目录）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { APP_VERSION } from '../version'
import { decodePngRgba, resizeRgba, encodePngRgba, ICON_SIZES, findWindowByTitleAndPid } from '../services/windowIcon'

/** 项目根 = src/ 的上一级（启动器安装根，config/logs/env 均相对它） */
const SRC_ROOT = join(import.meta.dir, '..')
const DIST_DIR = join(SRC_ROOT, '..', 'dist')
const LOGO_PNG = join(SRC_ROOT, 'assets', 'logo.png')
const SKIP_TESTS = process.argv.includes('--skip-tests')
const SKIP_SMOKE = process.argv.includes('--skip-smoke')
/** 冒烟探测的窗口标题（与 app.tsx WINDOW_OPTIONS.title / --windows-title 同值） */
const SMOKE_WINDOW_TITLE = 'SillyTavernLauncher'

/** 阶段门：失败即终止打包（闭环红线——不打包过不了门禁的代码） */
function gate(name: string, run: () => number | boolean): void {
  console.log(`\n▶ ${name}`)
  const result = run()
  if (result !== 0 && result !== true) {
    console.error(`✘ ${name} 未通过（exit=${result}），打包中止`)
    process.exit(1)
  }
  console.log(`✔ ${name} 通过`)
}

/** 同步跑命令（数组参数、继承 stdio、不经 shell） */
function run(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): number {
  return spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
  }).status ?? 1
}

// ---------------------------------------------------------------------------
// 版本：version.ts ↔ package.json 双向校验；派生 PE 四段式版本号
// ---------------------------------------------------------------------------

const pkgVersion = JSON.parse(readFileSync(join(SRC_ROOT, 'package.json'), 'utf8')).version as string

if (APP_VERSION !== `v${pkgVersion}`) {
  console.error(`✘ 版本不同步：version.ts=${APP_VERSION} vs package.json=${pkgVersion}（两处必须手动同步）`)
  process.exit(1)
}

/** 'v2.0.0-alpha.0' → '2.0.0.0'（PE 版本资源只认四段数字，pre-release 并入文件名） */
function windowsVersion(v: string): string {
  const core = v.replace(/^v/, '').split('-')[0].split('.').map(Number)
  if (core.some((n) => !Number.isFinite(n))) throw new Error(`无法解析版本号：${v}`)
  while (core.length < 4) core.push(0)
  return core.slice(0, 4).join('.')
}

// ---------------------------------------------------------------------------
// 图标：logo.png → 多尺寸 PNG-entry ICO（复用 windowIcon 纯函数，与标题栏同源）
// ---------------------------------------------------------------------------

/** ICO 容器：6 字节头 + N×16 字节目录 + PNG 数据（PNG-entry Vista+ 原生支持） */
function buildIconIco(pngBytes: Uint8Array): Buffer {
  const img = decodePngRgba(pngBytes)
  // 目录条目降序（256→16）：Win32 legacy 图标解析取目录首条目再缩放——
  // 升序会让 16px 被选中后放大到所有显示尺寸（发糊根因，探针实测验证）；
  // 降序保证任何请求都从 256 高质量下采样。七档全保留，现代 best-fit
  // 路径仍可精确命中
  const entries = [...ICON_SIZES].reverse().map((size) => ({
    size,
    data: encodePngRgba(resizeRgba(img, size, size), size, size),
  }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(entries.length * 16)
  let offset = 6 + entries.length * 16
  entries.forEach((e, i) => {
    const d = dir.subarray(i * 16, i * 16 + 16)
    // 256 编码为 0（ICONDIR 字段只有一字节）
    d.writeUInt8(e.size === 256 ? 0 : e.size, 0)
    d.writeUInt8(e.size === 256 ? 0 : e.size, 1)
    d.writeUInt16LE(1, 4) // planes
    d.writeUInt16LE(32, 6) // bitcount
    d.writeUInt32LE(e.data.length, 8)
    d.writeUInt32LE(offset, 12)
    offset += e.data.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => Buffer.from(e.data))])
}

// ---------------------------------------------------------------------------
// 产物验证：图标嵌入 / PE 子系统 / 尺寸下限
// ---------------------------------------------------------------------------

interface VerifyResult {
  ok: boolean
  message: string
}

/** 逐 entry 字节搜索（bun 的 winresource 会把 ICO 拆成独立 RT_ICON，整块搜不到） */
function verifyIconEmbedded(exe: Buffer, ico: Buffer): VerifyResult {
  const count = ico.readUInt16LE(4)
  let offset = 6 + count * 16
  for (let i = 0; i < count; i++) {
    const size = ico.readUInt32LE(6 + i * 16 + 8)
    if (!exe.includes(ico.subarray(offset, offset + size))) {
      return { ok: false, message: `第 ${i} 档图标未嵌入 .rsrc` }
    }
    offset += size
  }
  return { ok: true, message: `${count} 档图标全部嵌入` }
}

function verifyPeSubsystem(exe: Buffer): VerifyResult {
  const peOff = exe.readUInt32LE(0x3c)
  if (exe.readUInt32LE(peOff) !== 0x00004550) return { ok: false, message: '非 PE 文件（签名不匹配）' }
  const subsystem = exe.readUInt16LE(peOff + 0x5c)
  if (subsystem !== 2) return { ok: false, message: `PE subsystem=${subsystem}（期望 2=GUI，--windows-hide-console 未生效）` }
  return { ok: true, message: 'PE subsystem=GUI（双击不弹控制台）' }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`▶ onefile 打包 ${APP_VERSION}（Bun ${Bun.version}）`)

  if (!SKIP_TESTS) {
    gate('类型检查（tsc --noEmit）', () => run('bun', ['run', 'typecheck'], { cwd: SRC_ROOT }))
    gate('单元测试（vitest unit）', () => run('bunx', ['vitest', 'run', '--project', 'unit'], { cwd: SRC_ROOT }))
  } else {
    console.log('⏭ 跳过门禁（--skip-tests）')
  }

  // 图标就绪（失败抛错由 main 的 catch 统一报告）
  const icoPath = join(tmpdir(), `stl-build-logo-${Date.now()}.ico`)
  const ico = buildIconIco(new Uint8Array(readFileSync(LOGO_PNG)))
  writeFileSync(icoPath, ico)
  console.log(`\n▶ 图标生成：${ICON_SIZES.join('/')} 七档，${(ico.length / 1024).toFixed(0)} KB`)

  // 编译
  const exeName = `SillyTavernLauncher-${APP_VERSION}-win-x64.exe`
  const exePath = join(DIST_DIR, exeName)
  mkdirSync(DIST_DIR, { recursive: true })
  console.log(`\n▶ bun build --compile → dist/${exeName}`)
  const buildExit = run('bun', [
    'build',
    '--compile',
    '--bytecode',
    '--sourcemap=none',
    '--windows-hide-console',
    `--windows-icon=${icoPath}`,
    `--windows-version=${windowsVersion(APP_VERSION)}`,
    '--windows-title=SillyTavernLauncher',
    `--windows-description=SillyTavern Launcher ${APP_VERSION}`,
    // 版权显式声明；公司名用单空格占位——Bun 对空 publisher 会回落默认
    // "Oven"，单空格实测使字段显示为空白（--windows-publisher="" 无效）
    '--windows-copyright=Copyright (c) 2026 LingyeSoul',
    '--windows-publisher= ',
    `--outfile=${exePath}`,
    'app.tsx',
  ], { cwd: SRC_ROOT })
  if (buildExit !== 0) throw new Error(`bun build 失败（exit=${buildExit}）`)

  // 产物验证
  const exe = readFileSync(exePath)
  const sizeMb = exe.length / 1024 / 1024
  const checks: VerifyResult[] = [
    sizeMb >= 50
      ? { ok: true, message: `产物 ${(sizeMb).toFixed(1)} MB（含 Bun 运行时 + gpuix 原生模块）` }
      : { ok: false, message: `产物仅 ${sizeMb.toFixed(1)} MB，疑似裁剪异常` },
    verifyIconEmbedded(exe, ico),
    verifyPeSubsystem(exe),
  ]
  if (!SKIP_SMOKE) checks.push(await runSmoke(exePath))

  // 注：dist 若出现 config.json / agreement_cache.json / logs，是有人双击运行过
  // 产物 exe 的正常副作用（配置按设计落在 exe 所在目录 = 安装根），非打包缺陷，
  // 不作门禁。冒烟自身写临时目录，已经对照实验排除（RCA 详见 2026-09-20 会话）。

  rmSync(icoPath, { force: true })

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`${c.ok ? '✔' : '✘'} ${c.message}`)
  if (failed.length > 0) throw new Error(`${failed.length} 项产物验证未通过`)

  console.log(`\n✔ onefile 打包完成：dist/${exeName}`)
}

/** 冒烟：临时目录冷启动，要求存活 ≥5s 且主窗口已创建（标题+PID 双匹配），finally 强杀 */
async function runSmoke(exePath: string): Promise<VerifyResult> {
  const smokeDir = join(tmpdir(), `stl-onefile-smoke-${Date.now()}`)
  mkdirSync(smokeDir, { recursive: true })
  const proc = Bun.spawn([exePath], {
    cwd: smokeDir,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, STL_SKIP_AGREEMENT_RECHECK: '1' },
  })
  try {
    const deadline = Date.now() + 15_000
    let aliveMs = 0
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        return { ok: false, message: `冒烟失败：exe 启动后提前退出（exitCode=${proc.exitCode}）` }
      }
      await Bun.sleep(500)
      aliveMs += 500
      let hwnd = 0
      try {
        hwnd = await findWindowByTitleAndPid(SMOKE_WINDOW_TITLE, proc.pid)
      } catch (err) {
        return { ok: false, message: `冒烟异常：窗口探测失败（${err instanceof Error ? err.message : String(err)}）` }
      }
      if (aliveMs >= 5_000 && hwnd !== 0) {
        return { ok: true, message: `冒烟通过：存活 ${aliveMs}ms + 主窗口已创建（pid=${proc.pid}）` }
      }
    }
    return {
      ok: false,
      message: `冒烟超时：进程存活但 15s 内未检测到主窗口（标题+PID 双匹配，pid=${proc.pid}）`,
    }
  } finally {
    proc.kill()
    await proc.exited
    rmSync(smokeDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`\n✘ 打包失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
