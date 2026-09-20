/**
 * unit 项目全局 setup：把 errorLog 文件通道重定向到临时目录。
 *
 * - GUI 运行时路径的 catch 块统一走 logError（errorLog.ts），它会向
 *   `process.cwd()/logs` 懒写 Error_*.txt；vitest unit 项目 cwd 在 src/，
 *   不重定向会把 src/logs/ 写进仓库（违反 AGENTS.md 测试防污染纪律）。
 * - setupFiles 与测试文件共享同一模块图：静态 import 被测模块的用例
 *   拿到的 errorLog 即此处重定向过的实例，单点覆盖全部 unit 用例。
 * - 例外（互不冲突，保持现状）：
 *   - errorLog.test.ts / configStore.test.ts 用 vi.resetModules 后自建实例，
 *     且各自在用例内 __setErrorLogDirForTests 到私有 tempDir，不经过本 setup；
 *   - settings.terminalFont.test.ts 虽 resetModules，但其用例只走正常保存
 *     路径，不触发 settings.ts 的 logError catch 块。
 * - errorLog 懒创建：未触发错误的测试文件不会产生任何磁盘写入。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { __setErrorLogDirForTests } from '../services/errorLog'

const tempDir = mkdtempSync(join(tmpdir(), 'stl-errlog-setup-'))
__setErrorLogDirForTests(join(tempDir, 'logs'))

// 本测试文件跑完后回收重定向目录（每个测试文件独立模块图，各自重建互不串）
afterAll(() => {
  rmSync(tempDir, { force: true, recursive: true })
})
