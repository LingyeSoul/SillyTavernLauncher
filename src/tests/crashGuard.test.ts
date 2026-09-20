/**
 * crashGuard：进程级异常兜底落盘。
 * - installCrashGuard 注册 uncaughtException / unhandledRejection 两个 listener，幂等
 *   （globalThis 标志去重，--hot 重求值不重复注册）。
 * - handler 把异常写入 logs/Error_*.txt（tag + message/stack），自身绝不抛
 *   （logError 文件通道失败自降级）。
 *
 * process.on 用 spy 拦截而非真注册：真 listener 会留在测试 worker 进程上，
 * 污染后续用例的 listenerCount 与无关异常的日志行为。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as crashGuardModule from '../services/crashGuard'

type InstallFn = typeof crashGuardModule.installCrashGuard

interface CrashGuardModule {
  installCrashGuard: InstallFn
}

async function freshModule(): Promise<CrashGuardModule> {
  vi.resetModules()
  return (await import('../services/crashGuard')) as CrashGuardModule
}

let tempDir: string

/** 清掉幂等标志：每个用例从零安装 */
function resetFlag(): void {
  delete (globalThis as { __stlCrashGuardInstalled?: boolean }).__stlCrashGuardInstalled
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-crashguard-'))
  resetFlag()
  // 默认视作 gpuix handler 在场（基线 listenerCount ≥ 1）：独监听退出路径不触发，
  // 避免现有用例手动调 handler 时真调 process.exit 杀死测试 worker；独监听
  // 专用用例内改写为 0
  vi.spyOn(process, 'listenerCount').mockReturnValue(1)
})

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true })
  resetFlag()
  vi.restoreAllMocks()
})

describe('crashGuard（进程级异常落盘兜底）', () => {
  it('注册 uncaughtException / unhandledRejection 各一个 listener，且幂等', async () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { installCrashGuard } = await freshModule()

    installCrashGuard()
    const events = onSpy.mock.calls.map(([event]) => event)
    expect(events).toContain('uncaughtException')
    expect(events).toContain('unhandledRejection')

    // 二次安装（--hot 重求值语义）：标志命中，不再注册
    onSpy.mockClear()
    installCrashGuard()
    expect(onSpy).not.toHaveBeenCalled()
  })

  it('uncaughtException handler 落盘 tag + 完整堆栈，且自身不抛', async () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { installCrashGuard } = await freshModule()
    const { __setErrorLogDirForTests } = await import('../services/errorLog')
    __setErrorLogDirForTests(join(tempDir, 'logs'))

    installCrashGuard()
    const handlers = new Map(onSpy.mock.calls as [string, (payload: unknown) => void][])
    const onUncaught = handlers.get('uncaughtException')
    expect(onUncaught).toBeTypeOf('function')

    expect(() => onUncaught?.(new Error('The GPUI UI thread is not running'))).not.toThrow()

    const files = readdirSync(join(tempDir, 'logs'))
    expect(files).toHaveLength(1)
    const content = readFileSync(join(tempDir, 'logs', files[0] ?? ''), 'utf8')
    expect(content).toContain('[crashGuard] uncaughtException:')
    expect(content).toContain('The GPUI UI thread is not running')
    expect(content).toContain('at ')
  })

  it('unhandledRejection handler 落盘非 Error 原因（字符串），且自身不抛', async () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { installCrashGuard } = await freshModule()
    const { __setErrorLogDirForTests } = await import('../services/errorLog')
    __setErrorLogDirForTests(join(tempDir, 'logs'))

    installCrashGuard()
    const handlers = new Map(onSpy.mock.calls as [string, (payload: unknown) => void][])
    const onRejection = handlers.get('unhandledRejection')
    expect(onRejection).toBeTypeOf('function')

    expect(() => onRejection?.('字符串原因')).not.toThrow()

    const files = readdirSync(join(tempDir, 'logs'))
    expect(files).toHaveLength(1)
    const content = readFileSync(join(tempDir, 'logs', files[0] ?? ''), 'utf8')
    expect(content).toContain('[crashGuard] unhandledRejection: 字符串原因')
  })

  it('独监听防御：无其他 listener 时落盘后以退出码 1 结束（保持原生崩溃语义）', async () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(process, 'listenerCount').mockReturnValue(0)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { installCrashGuard } = await freshModule()
    const { __setErrorLogDirForTests } = await import('../services/errorLog')
    __setErrorLogDirForTests(join(tempDir, 'logs'))

    installCrashGuard()
    const handlers = new Map(onSpy.mock.calls as [string, (payload: unknown) => void][])

    handlers.get('uncaughtException')?.(new Error('sole listener crash'))
    expect(exitSpy).toHaveBeenCalledWith(1)

    exitSpy.mockClear()
    handlers.get('unhandledRejection')?.('独监听 rejection')
    expect(exitSpy).toHaveBeenCalledWith(1)

    const files = readdirSync(join(tempDir, 'logs'))
    expect(files).toHaveLength(1)
    const content = readFileSync(join(tempDir, 'logs', files[0] ?? ''), 'utf8')
    expect(content).toContain('sole listener crash')
    expect(content).toContain('独监听 rejection')
  })
})
