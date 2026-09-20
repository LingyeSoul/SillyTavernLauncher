/**
 * ← network.py 迁移验证：适配器分类优先级（物理>VM>VPN 关键词）、
 * IP 段优先级、os.networkInterfaces 采集、UDP 回退、300s 缓存。
 */
import type * as os from 'node:os'
import { describe, expect, it } from 'vitest'
import { isLocalAddress, NetworkManager } from '../services/network'

interface FakeIpv4 {
  address: string
  netmask: string
  family: 'IPv4'
  mac: string
  internal: boolean
  cidr: string
}

function iface(address: string, internal = false): FakeIpv4 {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: 'aa:bb:cc:dd:ee:ff',
    internal,
    cidr: `${address}/24`,
  }
}

/** IPv6 条目：验证采集时被排除 */
function ipv6(address: string): os.NetworkInterfaceInfoIPv6 {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: 'aa:bb:cc:dd:ee:ff',
    internal: false,
    cidr: null,
    scopeid: 1,
  }
}

describe('适配器分类（← _classify_adapter）', () => {
  const manager = new NetworkManager()

  it('物理网卡关键词 → physical/10', () => {
    for (const name of ['Realtek PCIe GbE Controller', 'Intel(R) Wi-Fi 6 AX200', 'Broadcom NetXtreme']) {
      expect(manager.classifyAdapter(name)).toEqual({ type: 'physical', priority: 10 })
    }
  })

  it('VM 关键词 → vm/30（优先于 physical 匹配，如 vEthernet）', () => {
    for (const name of ['vEthernet (Default Switch)', 'VMware Virtual Ethernet', 'Hyper-V Virtual']) {
      expect(manager.classifyAdapter(name)).toEqual({ type: 'vm', priority: 30 })
    }
  })

  it('VPN 关键词 → vpn/20', () => {
    for (const name of ['OpenVPN TAP-Windows Adapter', 'WireGuard Tunnel', 'NordVPN NordWhisper']) {
      expect(manager.classifyAdapter(name)).toEqual({ type: 'vpn', priority: 20 })
    }
  })

  it('未知名称 → other/25', () => {
    expect(manager.classifyAdapter('Random Loopback Thing')).toEqual({ type: 'other', priority: 25 })
  })
})

describe('IP 校验与优先级（← _is_valid_ip / _get_ip_priority / _is_valid_lan_ip）', () => {
  const manager = new NetworkManager()

  it('isValidIp：排除回环/链路本地/非法', () => {
    expect(manager.isValidIp('192.168.1.1')).toBe(true)
    expect(manager.isValidIp('10.0.0.5')).toBe(true)
    expect(manager.isValidIp('127.0.0.1')).toBe(false)
    expect(manager.isValidIp('169.254.1.1')).toBe(false)
    expect(manager.isValidIp('256.1.1.1')).toBe(false)
    expect(manager.isValidIp('abc')).toBe(false)
    expect(manager.isValidIp('::1')).toBe(false)
  })

  it('getIpPriority：192.168(1) > 10(2) > 172.16-31(3) > 其他(4)', () => {
    expect(manager.getIpPriority('192.168.31.5')).toBe(1)
    expect(manager.getIpPriority('10.1.2.3')).toBe(2)
    expect(manager.getIpPriority('172.16.0.1')).toBe(3)
    expect(manager.getIpPriority('172.32.0.1')).toBe(4)
    expect(manager.getIpPriority('8.8.4.4')).toBe(4)
    expect(manager.getIpPriority('not-an-ip')).toBe(999)
  })

  it('isValidLanIp：私有地址段', () => {
    expect(manager.isValidLanIp('192.168.1.1')).toBe(true)
    expect(manager.isValidLanIp('10.255.0.1')).toBe(true)
    expect(manager.isValidLanIp('172.20.0.1')).toBe(true)
    expect(manager.isValidLanIp('172.32.0.1')).toBe(false)
    expect(manager.isValidLanIp('8.8.8.8')).toBe(false)
  })
})

describe('isLocalAddress（监听地址拦截线：config 陈旧 IP 判定）', () => {
  const provider = (): NodeJS.Dict<os.NetworkInterfaceInfo[]> => ({
    lo: [iface('127.0.0.1', true)],
    eth: [iface('192.168.94.197')],
  })

  it('挂在本机网卡的 IP（含回环）→ true；陈旧/他机 IP → false', () => {
    expect(isLocalAddress('192.168.94.197', provider)).toBe(true)
    expect(isLocalAddress('127.0.0.1', provider)).toBe(true)
    expect(isLocalAddress('192.168.64.197', provider)).toBe(false)
    expect(isLocalAddress('8.8.8.8', provider)).toBe(false)
  })
})

describe('getLocalIp（← get_local_ip）', () => {
  it('物理网卡 + 192.168 段优先于 VM 网卡 + 10 段', async () => {
    const manager = new NetworkManager({
      getInterfaces: () => ({
        'VMware Network Adapter VMnet1': [iface('10.99.0.5')],
        'Realtek PCIe GbE Controller': [iface('192.168.1.23')],
      }),
      log: () => undefined,
    })
    await expect(manager.getLocalIp()).resolves.toBe('192.168.1.23')
  })

  it('只有 VM 网卡时返回 VM 网卡 IP', async () => {
    const manager = new NetworkManager({
      getInterfaces: () => ({
        'vEthernet (WSL)': [iface('172.30.100.7')],
      }),
      log: () => undefined,
    })
    await expect(manager.getLocalIp()).resolves.toBe('172.30.100.7')
  })

  it('跳过 internal/IPv6/169.254 地址', async () => {
    const manager = new NetworkManager({
      getInterfaces: () => ({
        Loopback: [iface('127.0.0.1', true)],
        Wifi: [ipv6('fe80::1'), iface('169.254.99.99'), iface('192.168.0.10')],
      }),
      log: () => undefined,
    })
    await expect(manager.getLocalIp()).resolves.toBe('192.168.0.10')
  })

  it('无可用网卡时走 UDP 8.8.8.8 回退', async () => {
    const manager = new NetworkManager({
      getInterfaces: () => ({ Loopback: [iface('127.0.0.1', true)] }),
      udpFallback: async () => '10.20.30.40',
      log: () => undefined,
    })
    await expect(manager.getLocalIp()).resolves.toBe('10.20.30.40')
  })

  it('全部失败返回 null', async () => {
    const manager = new NetworkManager({
      getInterfaces: () => ({}),
      udpFallback: async () => null,
      log: () => undefined,
    })
    await expect(manager.getLocalIp()).resolves.toBeNull()
  })

  it('300 秒缓存期内不重新探测，过期后重新探测（← _ip_cache_duration）', async () => {
    let clock = 1_000_000
    let probeCount = 0
    const manager = new NetworkManager({
      cacheDuration: 300,
      now: () => clock,
      getInterfaces: () => {
        probeCount += 1
        return { Ethernet: [iface('192.168.50.2')] }
      },
      log: () => undefined,
    })
    await expect(manager.getLocalIp()).resolves.toBe('192.168.50.2')
    await expect(manager.getLocalIp()).resolves.toBe('192.168.50.2')
    expect(probeCount).toBe(1)
    clock += 299_999
    await expect(manager.getLocalIp()).resolves.toBe('192.168.50.2')
    expect(probeCount).toBe(1)
    clock += 2
    await expect(manager.getLocalIp()).resolves.toBe('192.168.50.2')
    expect(probeCount).toBe(2)
  })
})
