/**
 * ← tests/test_terminal_stream.py（AsyncTerminalStreamTests）语义等价移植：
 * 行流读取、UTF-8 替换、超长行、扩展名探测、批处理 shell 方式、
 * 两阶段停止、同步硬杀、注册表、validateCustomArgs 注入白名单。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_LINE_BYTES,
  buildProcessEnv,
  executeProcessAsync,
  getActiveProcesses,
  getActiveProcessesCount,
  hasActiveProcess,
  readStreamLines,
  removeProcess,
  stopAllProcesses,
  stopAllProcessesSync,
  stripSurroundingQuotes,
  tokenizeCommand,
  validateCustomArgs,
  windowsQuoteArg,
} from '../services/processManager'
import type { LogLine } from '../services/types'
import { which } from '../services/runtime'

let tempDir: string
let events: string[]
let lines: LogLine[]

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-proc-'))
  events = []
  lines = []
})

afterEach(async () => {
  // 兜底清理，防止用例失败时泄漏子进程
  await stopAllProcesses()
  rmSync(tempDir, { force: true, recursive: true })
})

/** 优先 bun（生产宿主等价），找不到则退回当前 node 可执行文件 */
function runtimeBin(): string {
  return which('bun') ?? process.execPath
}

function collect(line: LogLine): void {
  lines.push(line)
}

describe('命令解析（← shlex posix=False + list2cmdline）', () => {
  it('tokenizeCommand：引号分组且引号保留在 token 内', () => {
    expect(tokenizeCommand('npm install --flag')).toEqual(['npm', 'install', '--flag'])
    expect(tokenizeCommand('"C:/tool dir/npm.cmd" --version')).toEqual([
      '"C:/tool dir/npm.cmd"',
      '--version',
    ])
    // 空白（含 tab）分隔，与 shlex 一致
    expect(tokenizeCommand('  a\tb  c ')).toEqual(['a', 'b', 'c'])
    // token 中部的引号原样保留
    expect(tokenizeCommand("--key 'quoted value'")).toEqual(['--key', "'quoted value'"])
  })

  it('未闭合引号抛错（对应 shlex ValueError）', () => {
    expect(() => tokenizeCommand('echo "unclosed')).toThrow('No closing quotation')
  })

  it('stripSurroundingQuotes：仅剥成对包裹的同种引号', () => {
    expect(stripSurroundingQuotes('"a b"')).toBe('a b')
    expect(stripSurroundingQuotes("'a b'")).toBe('a b')
    expect(stripSurroundingQuotes('"a')).toBe('"a')
    expect(stripSurroundingQuotes('"a\'')).toBe('"a\'')
  })

  it('windowsQuoteArg：空格/引号参数加引号，闭引号前尾部反斜杠翻倍（MSVCRT 规则）', () => {
    expect(windowsQuoteArg('plain')).toBe('plain')
    expect(windowsQuoteArg('')).toBe('""')
    expect(windowsQuoteArg('a b')).toBe('"a b"')
    expect(windowsQuoteArg('say "hi"')).toBe('"say \\"hi\\""')
    // 无空格无引号 → 不加引号，尾部反斜杠原样
    expect(windowsQuoteArg('C:\\dir\\')).toBe('C:\\dir\\')
    // 有空格 → 加引号，闭引号前的尾部反斜杠翻倍
    expect(windowsQuoteArg('a b\\')).toBe('"a b\\\\"')
  })
})

describe('readStreamLines（← _read_stream_output + _safe_readline）', () => {
  function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index])
          index += 1
        } else {
          controller.close()
        }
      },
    })
  }

  it('按 \\n 分行、剥 \\r、跳过空行（对应 Python rstrip+非空判断）', async () => {
    const out: LogLine[] = []
    await readStreamLines(
      streamOf(new TextEncoder().encode('第一行\r\nsecond\r\n\r\nlast')),
      'stdout',
      (l) => out.push(l),
    )
    expect(out).toEqual([
      { stream: 'stdout', text: '第一行' },
      { stream: 'stdout', text: 'second' },
      { stream: 'stdout', text: 'last' },
    ])
  })

  it('多字节 UTF-8 跨 chunk 分割不损坏', async () => {
    const bytes = new TextEncoder().encode('中文测试\n')
    const out: LogLine[] = []
    await readStreamLines(
      streamOf(bytes.slice(0, 3), bytes.slice(3), new TextEncoder().encode('tail\n')),
      'stdout',
      (l) => out.push(l),
    )
    expect(out).toEqual([
      { stream: 'stdout', text: '中文测试' },
      { stream: 'stdout', text: 'tail' },
    ])
  })

  it('无效 UTF-8 字节替换为 U+FFFD（errors=replace 等价）', async () => {
    const out: LogLine[] = []
    await readStreamLines(streamOf(new Uint8Array([0xff, 0xfe, 0x0a])), 'stderr', (l) => out.push(l))
    expect(out).toEqual([{ stream: 'stderr', text: '\uFFFD\uFFFD' }])
  })

  it('超长行保留首 64KB、丢弃溢出部分，后续行不受影响（← _safe_readline）', async () => {
    const encoder = new TextEncoder()
    const huge = encoder.encode('x'.repeat(MAX_LINE_BYTES + 100_000) + '\n')
    const out: LogLine[] = []
    await readStreamLines(
      streamOf(huge, encoder.encode('next line\n')),
      'stdout',
      (l) => out.push(l),
    )
    expect(out).toHaveLength(2)
    expect(out[0]?.text.length).toBe(MAX_LINE_BYTES)
    expect(out[1]?.text).toBe('next line')
  })

  it('空流与 null 流安全返回', async () => {
    await expect(readStreamLines(null, 'stdout', collect)).resolves.toBeUndefined()
    await expect(readStreamLines(streamOf(), 'stdout', collect)).resolves.toBeUndefined()
    expect(lines).toEqual([])
  })
})

describe('validateCustomArgs（← event.py 自定义参数校验，注入白名单）', () => {
  it('空参数与常规参数通过', () => {
    expect(validateCustomArgs('')).toEqual({ ok: true, message: '' })
    expect(validateCustomArgs('   ')).toEqual({ ok: true, message: '' })
    expect(validateCustomArgs('--port 8080').ok).toBe(true)
    expect(validateCustomArgs('--key=value').ok).toBe(true)
    expect(validateCustomArgs('-k v').ok).toBe(true)
    expect(validateCustomArgs('--path=C:/data --root=D:\\st').ok).toBe(true)
    expect(validateCustomArgs('--中文 参数').ok).toBe(true) // Unicode \w 等价
    expect(validateCustomArgs('--email=a@b.com --p=50%').ok).toBe(true)
  })

  it.each(['|', '&', ';', '$', '`', '(', ')', '<', '>', '\n', '\r'])(
    'shell 元字符 %p 被拒绝',
    (char) => {
      const result = validateCustomArgs(`--flag ${char} evil`)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('危险字符')
    },
  )

  it('未闭合引号被拒绝', () => {
    expect(validateCustomArgs("--key 'unclosed").ok).toBe(false)
    expect(validateCustomArgs('--key "unclosed').ok).toBe(false)
  })

  it('token 中的非法字符被拒绝', () => {
    expect(validateCustomArgs('--flag a!b').ok).toBe(false)
    expect(validateCustomArgs('--flag a#b').ok).toBe(false)
  })
})

describe('executeProcessAsync（← execute_process_async）', () => {
  it('stdout/stderr 行流分别回调（bun -e 等价命令）', async () => {
    const bin = runtimeBin()
    // 注：与 Python shlex(posix=False) 一致，参数 token 会保留引号，
    // 直接 exec 路径下带引号参数是字面量——event.py 的启动命令同样不带引号参数。
    const info = await executeProcessAsync({
      command: `"${bin}" -e console.log('a');console.error('b')`,
      cwd: tempDir,
      onLine: collect,
      onEvent: (m) => events.push(m),
    })
    expect(info).not.toBeNull()
    await info?.whenSettled
    expect(lines).toContainEqual({ stream: 'stdout', text: 'a' })
    expect(lines).toContainEqual({ stream: 'stderr', text: 'b' })
    // 命令回显（对应 add_log(f"{workdir} $ {command}")）
    expect(events[0]).toContain('$')
    // 结束后自动从注册表移除
    expect(getActiveProcessesCount()).toBe(0)
  })

  it('命令解析为空 → null + 错误事件', async () => {
    const info = await executeProcessAsync({
      command: '   ',
      cwd: tempDir,
      onEvent: (m) => events.push(m),
    })
    expect(info).toBeNull()
    expect(events.join('\n')).toContain('命令解析为空')
  })

  it('可执行文件不存在 → null + 错误事件', async () => {
    const info = await executeProcessAsync({
      command: `"${join(tempDir, 'missing.exe')}" --version`,
      cwd: tempDir,
      onEvent: (m) => events.push(m),
    })
    expect(info).toBeNull()
    expect(events.join('\n')).toContain('找不到可执行文件')
  })

  it('无扩展名脚本优先选择 .cmd 伴生文件并走 shell（← test_extensionless_...）', async () => {
    const toolDir = join(tempDir, 'tool dir') // 带空格，验证引号处理
    mkdirSync(toolDir, { recursive: true })
    const launcher = join(toolDir, 'npm')
    writeFileSync(launcher, '#!/usr/bin/env bash\n', 'utf8')
    writeFileSync(join(toolDir, 'npm.cmd'), '@echo off\r\necho hello-from-cmd\r\n', 'utf8')

    const info = await executeProcessAsync({
      command: `"${launcher}" --version`,
      cwd: tempDir,
      onLine: collect,
    })
    expect(info).not.toBeNull()
    await info?.whenSettled
    expect(lines).toContainEqual({ stream: 'stdout', text: 'hello-from-cmd' })
  })

  it('.cmd 批处理参数去引号后传递（空格路径 + 带引号参数）', async () => {
    const toolDir = join(tempDir, 'bat dir')
    mkdirSync(toolDir, { recursive: true })
    // 回显 %1 验证参数原样到达（cmd 的 %1 保留引号）
    writeFileSync(join(toolDir, 'echo1.cmd'), '@echo off\r\necho [%1]\r\n', 'utf8')
    const info = await executeProcessAsync({
      command: `"${join(toolDir, 'echo1.cmd')}" "hello world"`,
      cwd: tempDir,
      onLine: collect,
    })
    await info?.whenSettled
    expect(lines.some((l) => /\["?hello world"?\]/.test(l.text))).toBe(true)
  })

  it('注册表：注册/查询/移除（← create_process/remove_process）', async () => {
    const bin = runtimeBin()
    const info = await executeProcessAsync({
      command: `"${bin}" -e setTimeout(()=>console.log('late'),300)`,
      cwd: tempDir,
      onLine: collect,
    })
    expect(info).not.toBeNull()
    expect(getActiveProcessesCount()).toBe(1)
    expect(getActiveProcesses()[0]?.command).toContain('-e')
    expect(removeProcess(info!.pid)).toBe(true)
    expect(getActiveProcessesCount()).toBe(0)
    expect(removeProcess(999999)).toBe(false)
    await info?.whenSettled
    expect(lines).toContainEqual({ stream: 'stdout', text: 'late' })
  })

  it('kind 语义分类：running 派生只认 st-server（临时 git/npm 不算）', async () => {
    const bin = runtimeBin()
    // 未标记的临时任务（git/npm 语义）：不计入 st-server
    const task = await executeProcessAsync({
      command: `"${bin}" -e setTimeout(()=>{},600)`,
      cwd: tempDir,
    })
    expect(task).not.toBeNull()
    expect(hasActiveProcess('st-server')).toBe(false)
    expect(getActiveProcessesCount()).toBe(1)

    // 标记 st-server 的进程：计入
    const server = await executeProcessAsync({
      command: `"${bin}" -e setTimeout(()=>{},600)`,
      cwd: tempDir,
      kind: 'st-server',
    })
    expect(server).not.toBeNull()
    expect(server?.kind).toBe('st-server')
    expect(hasActiveProcess('st-server')).toBe(true)

    await Promise.all([task?.whenSettled, server?.whenSettled])
    // 全部结束后：注册表清空，running 派生复位
    expect(getActiveProcessesCount()).toBe(0)
    expect(hasActiveProcess('st-server')).toBe(false)
  })
})

describe('停止进程（← _stop_processes_impl_async / stop_processes_sync）', () => {
  it('stopAllProcesses：Windows 走 taskkill /T /F 杀整树', async () => {
    const bin = runtimeBin()
    const info = await executeProcessAsync({
      command: `"${bin}" -e setInterval(()=>{},1000)`,
      cwd: tempDir,
      onEvent: (m) => events.push(m),
    })
    expect(info).not.toBeNull()
    expect(getActiveProcessesCount()).toBe(1)

    const stopped = await stopAllProcesses((m) => events.push(m))
    expect(stopped).toBe(true)
    await info?.proc.exited
    expect(info?.proc.exitCode).not.toBe(null)
    expect(getActiveProcessesCount()).toBe(0)
    expect(events.some((m) => m.includes('正在终止 1 个进程'))).toBe(true)
    expect(events.some((m) => m.includes('所有进程已终止'))).toBe(true)

    // 无进程时返回 false
    await expect(stopAllProcesses()).resolves.toBe(false)
  })

  it('stopAllProcessesSync：同步硬杀并清空注册表', async () => {
    const bin = runtimeBin()
    const info = await executeProcessAsync({
      command: `"${bin}" -e setInterval(()=>{},1000)`,
      cwd: tempDir,
    })
    expect(info).not.toBeNull()
    expect(stopAllProcessesSync()).toBe(true)
    expect(getActiveProcessesCount()).toBe(0)
    expect(stopAllProcessesSync()).toBe(false)
  })

  it('多个进程同时停止', async () => {
    const bin = runtimeBin()
    const a = await executeProcessAsync({
      command: `"${bin}" -e setInterval(()=>{},1000)`,
      cwd: tempDir,
    })
    const b = await executeProcessAsync({
      command: `"${bin}" -e setInterval(()=>{},1000)`,
      cwd: tempDir,
    })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(getActiveProcessesCount()).toBe(2)
    await stopAllProcesses()
    await Promise.all([a!.proc.exited, b!.proc.exited])
    expect(a!.proc.exitCode).not.toBe(null)
    expect(b!.proc.exitCode).not.toBe(null)
  })
})

describe('buildProcessEnv（← event.py env 组装）', () => {
  it('NODE_ENV=production + PATH 前置便携 env + FORCE_COLOR=1', () => {
    const env = buildProcessEnv([join(tempDir, 'env'), join(tempDir, 'env', 'cmd')])
    expect(env.NODE_ENV).toBe('production')
    expect(env.FORCE_COLOR).toBe('1')
    expect(env.PATH?.startsWith(join(tempDir, 'env'))).toBe(true)
    expect(env.PATH).toContain(join(tempDir, 'env', 'cmd'))
    expect(env.PATH).toContain(process.env.PATH ?? '')
    // 继承宿主环境
    expect(env.PATH).toBeTruthy()
  })

  it('不传目录时不改 PATH', () => {
    const env = buildProcessEnv()
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.NODE_ENV).toBe('production')
  })
})
