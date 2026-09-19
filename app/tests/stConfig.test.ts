/**
 * ← tests/test_st_config.py（SillyTavernConfigTests）语义等价移植：
 * eemeli/yaml 注释 round-trip、未知字段保留、非法节回退安全默认、
 * whitelist.txt 一次性迁移、智能子网白名单、unified 双向同步、原子写。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import {
  DEFAULT_PRIVATE_ADDRESS_RANGES,
  StConfig,
  isValidIpOrPattern,
} from '../services/stConfig'

let tempDir: string
let baseDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stl-stcfg-'))
  baseDir = join(tempDir, 'SillyTavern')
  mkdirSync(baseDir, { recursive: true })
})

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true })
})

function writeConfig(content: string): void {
  writeFileSync(join(baseDir, 'config.yaml'), content, 'utf8')
}

function readConfigText(): string {
  return readFileSync(join(baseDir, 'config.yaml'), 'utf8')
}

function readConfigRoot(): Record<string, unknown> {
  return parseDocument(readConfigText()).toJS() as Record<string, unknown>
}

const fakeIp = (ip: string | null) => async (): Promise<string | null> => ip

describe('StConfig（← st/config.py stcfg）', () => {
  it('注释与未知字段在读写 round-trip 后保留（eemeli/yaml AST）', () => {
    writeConfig([
      '# 顶部注释：SillyTavern 配置',
      'listen: false  # 行尾注释',
      'port: 8000',
      'dataRoot: ./data  # 非托管键必须原样保留',
      'whitelist:',
      '  - ::1',
      '  - 127.0.0.1',
      'privateAddressWhitelist:',
      '  enabled: true',
      '  allowUnresolvedHosts: true',
      '  customOption: keep-me',
      '  log:',
      '    blockedRequests: false',
      '    allowedRequests: true',
      '  allowedRanges:',
      '    - 192.168.50.*',
      '',
    ].join('\n'))

    const config = new StConfig({ baseDir })
    expect(config.privateAddressWhitelistEnabled).toBe(true)
    expect(config.privateAddressAllowUnresolvedHosts).toBe(true)
    expect(config.privateAddressLogBlocked).toBe(false)
    expect(config.privateAddressLogAllowed).toBe(true)
    expect(config.privateAddressAllowedRanges).toEqual(['192.168.50.*'])

    config.privateAddressAllowedRanges.push('10.0.0.0/8')
    config.port = 8001
    config.save()

    const text = readConfigText()
    expect(text).toContain('# 顶部注释：SillyTavern 配置')
    expect(text).toContain('# 行尾注释')
    expect(text).toContain('# 非托管键必须原样保留')
    const saved = readConfigRoot()
    const pw = saved.privateAddressWhitelist as Record<string, unknown>
    expect(pw.customOption).toBe('keep-me')
    expect(pw.allowedRanges).toEqual(['192.168.50.*', '10.0.0.0/8'])
    expect(saved.dataRoot).toBe('./data')
    expect(saved.port).toBe(8001)
    expect(saved.listen).toBe(false)
  })

  it('config.yaml 不存在时使用默认值，保存后创建目录与文件', () => {
    rmSync(baseDir, { force: true, recursive: true })
    const config = new StConfig({ baseDir })
    expect(config.listen).toBe(false)
    expect(config.port).toBe(8000)
    expect(config.whitelistIps).toEqual(['::1', '127.0.0.1'])
    expect(config.whitelistMode).toBe(true)
    expect(config.enableForwardedWhitelist).toBe(true)
    config.save()
    expect(existsSync(join(baseDir, 'config.yaml'))).toBe(true)
    // 原子写：无 .tmp 残留
    expect(existsSync(`${join(baseDir, 'config.yaml')}.tmp`)).toBe(false)
  })

  it('非法 privateAddressWhitelist（标量）回退安全默认（← test_invalid_...）', () => {
    writeConfig('privateAddressWhitelist: invalid\n')
    const config = new StConfig({ baseDir })
    config.save()
    const saved = readConfigRoot().privateAddressWhitelist as Record<string, unknown>
    expect(saved.enabled).toBe(false)
    expect(saved.allowedRanges).toEqual([...DEFAULT_PRIVATE_ADDRESS_RANGES])
    const log = saved.log as Record<string, unknown>
    expect(log.blockedRequests).toBe(true)
    expect(log.allowedRequests).toBe(false)
  })

  it('whitelist.txt 一次性迁移：合并去重、写标记、删除旧文件、不重复执行', () => {
    writeConfig('listen: false\nwhitelist:\n  - ::1\n  - 127.0.0.1\n')
    writeFileSync(
      join(baseDir, 'whitelist.txt'),
      '192.168.1.10\n\n  192.168.1.20  \n192.168.1.10\n127.0.0.1\n',
      'utf8',
    )

    const config = new StConfig({ baseDir })
    // txt 顺序在前、原有 IP 去重后缀、重复行去重
    expect(config.whitelistIps).toEqual(['192.168.1.10', '192.168.1.20', '127.0.0.1', '::1'])
    expect(existsSync(join(baseDir, 'whitelist.txt'))).toBe(false)
    const saved = readConfigRoot()
    expect(saved._whitelist_migrated).toBe(true)
    expect(saved.whitelist).toEqual(['192.168.1.10', '192.168.1.20', '127.0.0.1', '::1'])

    // 第二次加载不再迁移（标记生效，且旧文件已删除）
    const config2 = new StConfig({ baseDir })
    expect(config2.whitelistIps).toEqual(config.whitelistIps)
  })

  it('createWhitelist：最小权限默认 + 当前网段只进入入站白名单（← test_create_...）', async () => {
    writeConfig('listen: false\n')
    const config = new StConfig({ baseDir, getLocalIp: fakeIp('192.168.42.17') })

    await expect(config.createWhitelist()).resolves.toBe(true)
    expect(config.privateAddressWhitelistEnabled).toBe(true)
    expect(config.whitelistIps).toContain('192.168.42.*')
    // 网段不得进入出站私有地址范围（最小权限）
    expect(config.privateAddressAllowedRanges).not.toContain('192.168.42.*')
    for (const range of DEFAULT_PRIVATE_ADDRESS_RANGES) {
      expect(config.privateAddressAllowedRanges).toContain(range)
    }
    expect(config.whitelistIps).toContain('127.0.0.1')
    expect(config.whitelistIps).toContain('::1')

    const saved = readConfigRoot().privateAddressWhitelist as Record<string, unknown>
    expect(saved.enabled).toBe(true)
    expect(saved.allowedRanges).not.toContain('192.168.42.*')
  })

  it('getSubnetFromIp：IPv4 三段通配 / IPv6 两段通配（← _get_subnet_from_ip）', () => {
    const config = new StConfig({ baseDir })
    expect(config.getSubnetFromIp('192.168.42.17')).toBe('192.168.42.*')
    // Python: f"{parts[0]}:{parts[1]}::*" → 'fe80' + ':' + '' + '::*'
    expect(config.getSubnetFromIp('fe80::a1b2')).toBe('fe80:::*')
    expect(config.getSubnetFromIp('bad')).toBeNull()
  })

  it('checkAndUpdateWhitelistSubnet：网段变化时重建白名单（← _check_and_update_...）', async () => {
    writeConfig([
      'listen: true',
      'whitelist:',
      '  - 192.168.1.*',
      '  - 127.0.0.1',
      '  - ::1',
      '',
    ].join('\n'))
    const config = new StConfig({ baseDir, getLocalIp: fakeIp('10.20.30.5') })

    await expect(config.checkAndUpdateWhitelistSubnet()).resolves.toBe(true)
    expect(config.whitelistIps[0]).toBe('10.20.30.*')
    expect(config.whitelistIps).toContain('127.0.0.1')
    expect(config.whitelistIps).toContain('::1')
    // 旧网段前缀不同（192 != 10）→ 保留
    expect(config.whitelistIps).toContain('192.168.1.*')

    // 网段已存在 → 返回 false 且不改动
    const before = [...config.whitelistIps]
    await expect(config.checkAndUpdateWhitelistSubnet()).resolves.toBe(false)
    expect(config.whitelistIps).toEqual(before)
  })

  it('unified 双向同步：ip → host（IPv6 加方括号），host → ip（过滤非法/localhost）', () => {
    writeConfig('listen: true\n')
    const config = new StConfig({ baseDir })
    config.hostWhitelistHosts = ['localhost', 'extra.example.com']
    config.whitelistIps = ['192.168.1.*', 'fe80::1', '127.0.0.1']

    config.syncWhitelists('ip')
    expect(config.hostWhitelistHosts).toEqual(['localhost', '192.168.1.*', '[fe80::1]', '127.0.0.1'])

    // 反向：localhost 与非法条目被剔除
    config.hostWhitelistHosts = ['localhost', '[fe80::1]', '10.0.0.8', 'not!an!ip', '*.example.com']
    config.syncWhitelists('host')
    expect(config.whitelistIps).toEqual(['fe80::1', '10.0.0.8'])

    const saved = readConfigRoot()
    expect(saved.whitelist).toEqual(['fe80::1', '10.0.0.8'])
  })

  it('toSnapshot 输出托管字段纯数据视图', () => {
    writeConfig('listen: true\nport: 8080\n')
    const config = new StConfig({ baseDir })
    const snapshot = config.toSnapshot()
    expect(snapshot.listen).toBe(true)
    expect(snapshot.port).toBe(8080)
    expect(snapshot.requestProxy).toEqual({ enabled: false, url: '' })
    expect(snapshot.privateAddressWhitelist.allowedRanges).toEqual([
      ...DEFAULT_PRIVATE_ADDRESS_RANGES,
    ])
  })
})

describe('isValidIpOrPattern（← is_valid_ip_or_pattern）', () => {
  it('接受 IP/CIDR/通配符，拒绝 localhost 与任意字符串', () => {
    expect(isValidIpOrPattern('192.168.1.10')).toBe(true)
    expect(isValidIpOrPattern('192.168.1.*')).toBe(true)
    expect(isValidIpOrPattern('192.168.1.0/24')).toBe(true)
    expect(isValidIpOrPattern('fe80::1')).toBe(true)
    expect(isValidIpOrPattern('::1/128')).toBe(true)
    expect(isValidIpOrPattern('10.*')).toBe(true)
    expect(isValidIpOrPattern('localhost')).toBe(false)
    expect(isValidIpOrPattern('example.com')).toBe(false)
    expect(isValidIpOrPattern('')).toBe(false)
  })
})
