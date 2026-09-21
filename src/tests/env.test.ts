/**
 * ← env.py / env_sys.py 迁移验证：便携 env 路径、ST 安装检测、
 * 系统模式 git/node 探测、Node ≥18 版本比较、Windows 扩展名探测。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkEnv,
  checkNodeModules,
  checkStInstalled,
  checkSysEnv,
  clearDepsPending,
  compareVersions,
  depsPendingMarkerPath,
  getGitRootDir,
  markDepsPending,
  probeSystemGit,
  probeSystemNode,
  resolveExecutableExtension,
  resolvePortableEnv,
} from '../services/env'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-env-'))
})

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true })
})

describe('便携 env 路径解析（← env.py Env）', () => {
  it('解析 env/cmd/git.exe、env/node.exe、env/npm.cmd、SillyTavern', () => {
    const root = join(tempDir, 'root')
    const paths = resolvePortableEnv(join(root, 'env'))
    expect(paths.baseDir).toBe(join(root, 'env'))
    expect(paths.gitDir).toBe(join(root, 'env', 'cmd'))
    expect(paths.gitExe).toBe(join(root, 'env', 'cmd', 'git.exe'))
    expect(paths.nodeExe).toBe(join(root, 'env', 'node.exe'))
    expect(paths.npmCmd).toBe(join(root, 'env', 'npm.cmd'))
    expect(paths.stDir).toBe(join(root, 'SillyTavern'))
  })

  it('checkEnv：目录齐备返回 true，缺失按序报错（← Env.checkEnv）', () => {
    const paths = resolvePortableEnv(join(tempDir, 'full', 'env'))
    expect(checkEnv(paths)).toBe('Base dir is not exists')
    mkdirSync(paths.baseDir, { recursive: true })
    expect(checkEnv(paths)).toBe('Git dir is not exists')
    mkdirSync(paths.gitDir, { recursive: true })
    expect(checkEnv(paths)).toBe(true)
  })

  it('checkStInstalled：package.json + server.js 齐备才算安装（← Env.checkST）', () => {
    const stDir = join(tempDir, 'SillyTavern')
    expect(checkStInstalled(stDir)).toBe(false)
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, 'package.json'), '{}', 'utf8')
    expect(checkStInstalled(stDir)).toBe(false)
    writeFileSync(join(stDir, 'server.js'), '', 'utf8')
    expect(checkStInstalled(stDir)).toBe(true)
  })

  it('checkNodeModules（← Env.check_nodemodules）', () => {
    const stDir = join(tempDir, 'SillyTavern')
    expect(checkNodeModules(stDir)).toBe(false)
    mkdirSync(join(stDir, 'node_modules'), { recursive: true })
    expect(checkNodeModules(stDir)).toBe(true)
  })

  it('checkNodeModules：安装「未完成」标记在位视作未装好（2026-09-21 真机竞态）', () => {
    const stDir = join(tempDir, 'SillyTavern')
    // 目录不存在时标记为 no-op（不抢建目录；checkNodeModules 本就拒绝）
    markDepsPending(stDir)
    expect(existsSync(depsPendingMarkerPath(stDir))).toBe(false)
    expect(checkNodeModules(stDir)).toBe(false)
    // 目录就位（安装已开始动树）→ 标记可落
    mkdirSync(join(stDir, 'node_modules'), { recursive: true })
    markDepsPending(stDir)
    expect(existsSync(depsPendingMarkerPath(stDir))).toBe(true)
    expect(checkNodeModules(stDir)).toBe(false)
    // 安装成功收尾 → 标记清除 → 恢复可启动
    clearDepsPending(stDir)
    expect(existsSync(depsPendingMarkerPath(stDir))).toBe(false)
    expect(checkNodeModules(stDir)).toBe(true)
    // 幂等：重复清除不抛
    clearDepsPending(stDir)
    expect(checkNodeModules(stDir)).toBe(true)
  })
})

describe('Windows 无扩展名探测（← terminal.py 扩展名探测逻辑）', () => {
  it('按 .exe/.cmd/.bat/.ps1 顺序选择首个存在的伴生文件', () => {
    const toolDir = join(tempDir, 'tool dir')
    mkdirSync(toolDir, { recursive: true })
    const launcher = join(toolDir, 'npm')
    writeFileSync(launcher, '#!/usr/bin/env bash\n', 'utf8')
    // 无伴生文件时原样返回
    expect(resolveExecutableExtension(launcher)).toBe(launcher)
    // 只有 .cmd 伴生 → 选 .cmd
    writeFileSync(`${launcher}.cmd`, '@echo off\n', 'utf8')
    expect(resolveExecutableExtension(launcher)).toBe(`${launcher}.cmd`)
    // 出现 .exe 伴生 → 优先 .exe
    writeFileSync(`${launcher}.exe`, '', 'utf8')
    expect(resolveExecutableExtension(launcher)).toBe(`${launcher}.exe`)
  })

  it('已带扩展名的可执行文件不探测', () => {
    expect(resolveExecutableExtension(join(tempDir, 'git.exe'))).toBe(join(tempDir, 'git.exe'))
  })
})

describe('版本比较（← packaging.version）', () => {
  it('宽松解析 v 前缀与短版本', () => {
    expect(compareVersions('18.0.0', '17.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v18.20.1', '18.0.0')).toBeGreaterThan(0)
    expect(compareVersions('v24.14.1', '18.0.0')).toBeGreaterThan(0)
    expect(compareVersions('17.99.99', '18.0.0')).toBeLessThan(0)
    expect(compareVersions('1.13.0', '1.13.0')).toBe(0)
    expect(compareVersions('18', '18.0.0')).toBe(0)
  })

  it('预发布版本低于同名正式版本（semver）', () => {
    expect(compareVersions('1.13.0-beta.1', '1.13.0')).toBeLessThan(0)
    expect(compareVersions('1.13.0-beta.2', '1.13.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0-rc.1', '1.99.0')).toBeGreaterThan(0)
  })
})

describe('系统环境探测（← env_sys.py SysEnv）', () => {
  it('真实系统 git 探测通过并返回所在目录', () => {
    const probe = probeSystemGit()
    expect(probe.ok).toBe(true)
    expect(probe.gitDir).toBeTruthy()
  })

  it('真实系统 node 探测通过（版本 ≥ 18）', () => {
    const probe = probeSystemNode()
    expect(probe.ok).toBe(true)
    expect(probe.nodeDir).toBeTruthy()
    expect(compareVersions(probe.version ?? '', '18.0.0')).toBeGreaterThanOrEqual(0)
  })

  it('git 缺失时返回固定错误消息', () => {
    const probe = probeSystemGit(() => null)
    expect(probe).toEqual({ ok: false, message: 'Git is not installed on system', gitDir: null })
  })

  it('node 缺失时返回固定错误消息', () => {
    const probe = probeSystemNode(() => null)
    expect(probe.ok).toBe(false)
    expect(probe.message).toBe('Node.js is not installed on system')
  })

  it('checkSysEnv 组合判定（← SysEnv.checkSysEnv）', async () => {
    expect(checkSysEnv(() => null)).toBe('System Git Not Found')
    // git 可用、node 缺失 → System Node Not Found（git 用真实路径，--version 才能通过）
    const { which } = await import('../services/runtime')
    const realGit = which('git')
    expect(realGit).toBeTruthy()
    const nodeMissing = (bin: string) => (bin === 'git' ? realGit : null)
    expect(checkSysEnv(nodeMissing)).toBe('System Node Not Found')
    const both = (bin: string) =>
      bin === 'git' ? realGit : bin === 'node' ? (process.execPath ?? 'node') : null
    expect(checkSysEnv(both)).toBe(true)
  })

  it('getGitRootDir：cmd/bin 子目录取上级（← SysEnv.get_git_root_dir）', () => {
    expect(getGitRootDir('C:/PortableGit/cmd/git.exe')).toBe('C:/PortableGit')
    expect(getGitRootDir('C:/PortableGit/bin/git.exe')).toBe('C:/PortableGit')
    expect(getGitRootDir('C:/somewhere/git.exe')).toBe('C:/somewhere/git.exe')
  })
})
