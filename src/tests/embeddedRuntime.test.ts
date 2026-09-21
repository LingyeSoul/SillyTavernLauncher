/**
 * embedded 运行时服务测试（设计计划 §6/§9，Embedded-All Phase 2）：
 * - buildProcessEnvEmbedded：BUN_BE_BUN 恒在、继承 buildProcessEnv 全部语义
 *   （NODE_ENV/FORCE_COLOR/PYTHONUNBUFFERED 与 PATH 拼接）、NODE_EXTRA_CA_CERTS
 *   按 <root>/cache/win-ca.pem 存在性注入、baseDir/execPath 全程可注入；
 * - ensureCaCache：成功原子写入、进程内记忆化只写一次、获取/写失败 logError 不抛；
 * - ensureStEmbeddedRuntime：execPath 存在/不存在两态 + CA 懒加载触发。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildProcessEnvEmbedded,
  embeddedCaPemPath,
  ensureBunLockExcluded,
  ensureCaCache,
  ensureStEmbeddedRuntime,
  resetEmbeddedCaCacheForTest,
} from '../services/embeddedRuntime'

const FAKE_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBfake==\n-----END CERTIFICATE-----\n'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stlembed'))
  // CA 注入断言与宿主环境变量解耦（继承语义会把宿主的 NODE_EXTRA_CA_CERTS 带进来）
  delete process.env.NODE_EXTRA_CA_CERTS
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('buildProcessEnvEmbedded（§6 embedded 子进程环境）', () => {
  it('BUN_BE_BUN=1 恒在 + 继承 buildProcessEnv 全部语义（NODE_ENV/FORCE_COLOR/PYTHONUNBUFFERED）', () => {
    const env = buildProcessEnvEmbedded()
    expect(env.BUN_BE_BUN).toBe('1')
    expect(env.NODE_ENV).toBe('production')
    expect(env.FORCE_COLOR).toBe('1')
    expect(env.PYTHONUNBUFFERED).toBe('1')
  })

  it('prependDirs 空数组（默认）：PATH 不前置，保持宿主原值（embedded 无 PATH 前置语义）', () => {
    const env = buildProcessEnvEmbedded()
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.BUN_BE_BUN).toBe('1')
  })

  it('prependDirs 非空：继承 buildProcessEnv 的 PATH 前置拼接规则', () => {
    const env = buildProcessEnvEmbedded(['C:/fake/pre'])
    expect(env.PATH.startsWith('C:/fake/pre')).toBe(true)
    expect(env.BUN_BE_BUN).toBe('1')
  })

  it('NODE_EXTRA_CA_CERTS：cache/win-ca.pem 存在才注入（注入态，路径指向注入的 baseDir）', () => {
    mkdirSync(join(root, 'cache'), { recursive: true })
    writeFileSync(join(root, 'cache', 'win-ca.pem'), FAKE_PEM, 'utf8')
    const env = buildProcessEnvEmbedded([], { baseDir: root })
    expect(env.NODE_EXTRA_CA_CERTS).toBe(join(root, 'cache', 'win-ca.pem'))
    expect(env.BUN_BE_BUN).toBe('1')
  })

  it('NODE_EXTRA_CA_CERTS：文件不存在 → 不注入', () => {
    const env = buildProcessEnvEmbedded([], { baseDir: root })
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })

  it('embeddedCaPemPath：baseDir 默认 process.cwd()', () => {
    expect(embeddedCaPemPath()).toBe(join(process.cwd(), 'cache', 'win-ca.pem'))
    expect(embeddedCaPemPath(root)).toBe(join(root, 'cache', 'win-ca.pem'))
  })
})

describe('ensureCaCache（§9 CA 缓存懒加载）', () => {
  beforeEach(() => {
    resetEmbeddedCaCacheForTest()
  })

  it('成功导出 → 原子写入 <root>/cache/win-ca.pem（目录自动创建、内容一致）', async () => {
    const provider = vi.fn(async () => FAKE_PEM)
    const ok = await ensureCaCache({ baseDir: root, caProvider: provider })
    expect(ok).toBe(true)
    expect(readFileSync(join(root, 'cache', 'win-ca.pem'), 'utf8')).toBe(FAKE_PEM)
  })

  it('进程内记忆化：成功后再调不再导出、不再写盘', async () => {
    const provider = vi.fn(async () => FAKE_PEM)
    await ensureCaCache({ baseDir: root, caProvider: provider })
    // 手动篡改缓存文件：记忆化直通下不应被重写
    writeFileSync(join(root, 'cache', 'win-ca.pem'), 'STALE', 'utf8')
    const okAgain = await ensureCaCache({ baseDir: root, caProvider: provider })
    expect(okAgain).toBe(true)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(root, 'cache', 'win-ca.pem'), 'utf8')).toBe('STALE')
  })

  it('provider 抛异常 → logError 收口不抛、返回 false、不写文件', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = vi.fn(async () => {
        throw new Error('powershell boom')
      })
      const ok = await ensureCaCache({ baseDir: root, caProvider: provider })
      expect(ok).toBe(false)
      expect(existsSync(join(root, 'cache'))).toBe(false)
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('provider 返回 null（非 Windows / 导出失败）→ 返回 false，静默跳过', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ok = await ensureCaCache({ baseDir: root, caProvider: async () => null })
      expect(ok).toBe(false)
      expect(existsSync(join(root, 'cache'))).toBe(false)
      // 返回 null 是正常路径（非 Windows 恒 null），不刷错误日志
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('写盘失败（baseDir 指向文件而非目录）→ logError 收口返回 false，不向调用方抛出', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fileAsBase = join(root, 'not-a-dir')
      writeFileSync(fileAsBase, '', 'utf8')
      const ok = await ensureCaCache({ baseDir: fileAsBase, caProvider: async () => FAKE_PEM })
      expect(ok).toBe(false)
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('ensureStEmbeddedRuntime（§6 启动前校验）', () => {
  beforeEach(() => {
    resetEmbeddedCaCacheForTest()
  })

  it('execPath 存在 → ok + CA 懒加载触发（缓存落盘）', async () => {
    const exe = join(root, 'launcher.exe')
    writeFileSync(exe, '', 'utf8')
    const provider = vi.fn(async () => FAKE_PEM)
    const result = await ensureStEmbeddedRuntime({
      execPath: exe,
      baseDir: root,
      caProvider: provider,
    })
    expect(result.ok).toBe(true)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(root, 'cache', 'win-ca.pem'), 'utf8')).toBe(FAKE_PEM)
  })

  it('execPath 不存在（注入假路径）→ 失败 Result + logError，不抛出', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const missing = join(root, 'nope.exe')
      const result = await ensureStEmbeddedRuntime({ execPath: missing, baseDir: root })
      expect(result.ok).toBe(false)
      expect(result.message).toContain(missing)
      expect(errSpy).toHaveBeenCalled()
      // 校验失败提前返回：不应触发 CA 导出
      expect(existsSync(join(root, 'cache'))).toBe(false)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('execPath 是目录而非文件（isFile 语义）→ 同样失败', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dirPath = join(root, 'adirectory')
      mkdirSync(dirPath, { recursive: true })
      const result = await ensureStEmbeddedRuntime({ execPath: dirPath, baseDir: root })
      expect(result.ok).toBe(false)
      expect(result.message).toContain(dirPath)
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('ensureBunLockExcluded（§7/D6 bun.lock 消解）', () => {
  const excludePathOf = (stDir: string): string => join(stDir, '.git', 'info', 'exclude')

  it('首次写入：.git/info 与 exclude 均不存在 → 逐级创建，内容恰为 bun.lock 一行', async () => {
    const stDir = join(root, 'SillyTavern')
    const ok = await ensureBunLockExcluded(stDir)
    expect(ok).toBe(true)
    expect(readFileSync(excludePathOf(stDir), 'utf8')).toBe('bun.lock\n')
  })

  it('.git 存在但 info/ 不存在 → 自动创建 info 并写入', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(join(stDir, '.git'), { recursive: true })
    const ok = await ensureBunLockExcluded(stDir)
    expect(ok).toBe(true)
    expect(readFileSync(excludePathOf(stDir), 'utf8')).toBe('bun.lock\n')
  })

  it('已有 bun.lock 行 → 幂等跳过，文件逐字节不变（不重复追加）', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(join(stDir, '.git', 'info'), { recursive: true })
    const before = '*.log\nbun.lock\n# note\n'
    writeFileSync(excludePathOf(stDir), before, 'utf8')
    const ok = await ensureBunLockExcluded(stDir)
    expect(ok).toBe(true)
    expect(readFileSync(excludePathOf(stDir), 'utf8')).toBe(before)
  })

  it('exclude 有既有内容且无结尾换行 → 补换行后追加，既有内容保留', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(join(stDir, '.git', 'info'), { recursive: true })
    writeFileSync(excludePathOf(stDir), '.DS_Store', 'utf8')
    const ok = await ensureBunLockExcluded(stDir)
    expect(ok).toBe(true)
    expect(readFileSync(excludePathOf(stDir), 'utf8')).toBe('.DS_Store\nbun.lock\n')
  })

  it('行匹配为整行精确匹配：bun.lockx / 注释行不算已排除（会正常追加）', async () => {
    const stDir = join(root, 'SillyTavern')
    mkdirSync(join(stDir, '.git', 'info'), { recursive: true })
    writeFileSync(excludePathOf(stDir), 'bun.lockx\n# bun.lock\n', 'utf8')
    const ok = await ensureBunLockExcluded(stDir)
    expect(ok).toBe(true)
    expect(readFileSync(excludePathOf(stDir), 'utf8')).toBe('bun.lockx\n# bun.lock\nbun.lock\n')
  })

  it('写失败（.git 是文件，info/ 无法创建）→ logError 收口返回 false，不向调用方抛出', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const stDir = join(root, 'SillyTavern')
      mkdirSync(stDir, { recursive: true })
      writeFileSync(join(stDir, '.git'), 'not a dir', 'utf8')
      const ok = await ensureBunLockExcluded(stDir)
      expect(ok).toBe(false)
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})
