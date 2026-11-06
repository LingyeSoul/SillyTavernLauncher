/**
 * ← stLifecycle.test.ts 拆分：Windows 系统代理读取/归一化/可达性门检的独立用例。
 * 用例内容原样搬移，断言与期望值未改。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  extractProxyEndpoint,
  normalizeProxyServer,
  probeProxyReachable,
  readWindowsRegistryProxy,
} from '../services/systemProxy'

describe('normalizeProxyServer / readWindowsRegistryProxy（← getproxies_registry）', () => {
  it('裸 host:port 补 http:// 前缀', () => {
    expect(normalizeProxyServer('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('分协议串优先 https 段，次选 http 段', () => {
    expect(normalizeProxyServer('http=127.0.0.1:80;https=127.0.0.1:443')).toBe('http://127.0.0.1:443')
    expect(normalizeProxyServer('http=127.0.0.1:80')).toBe('http://127.0.0.1:80')
  })

  it('无 http/https 段或空值返回空串', () => {
    expect(normalizeProxyServer('socks=127.0.0.1:1080')).toBe('')
    expect(normalizeProxyServer('   ')).toBe('')
  })

  it('已带 scheme 不重复补前缀', () => {
    expect(normalizeProxyServer('http://proxy.local:8080')).toBe('http://proxy.local:8080')
  })

  it.skipIf(process.platform !== 'win32')('reg 输出解析：ProxyEnable=0x1 + ProxyServer 生效', () => {
    const query = vi.fn((args: string[]) =>
      args.includes('ProxyEnable')
        ? { exitCode: 0, stdout: 'HKEY_CURRENT_USER\\Internet Settings\n    ProxyEnable    REG_DWORD    0x1\n' }
        : { exitCode: 0, stdout: '    ProxyServer    REG_SZ    127.0.0.1:7890\n' },
    )
    expect(readWindowsRegistryProxy(query)).toBe('http://127.0.0.1:7890')
  })

  it.skipIf(process.platform !== 'win32')(
    'reg 输出解析：ProxyEnable=0x0 / 查询失败 / 值缺失均按无代理',
    () => {
      expect(
        readWindowsRegistryProxy(() => ({ exitCode: 0, stdout: '    ProxyEnable    REG_DWORD    0x0\n' })),
      ).toBe('')
      expect(readWindowsRegistryProxy(() => ({ exitCode: 1, stdout: '' }))).toBe('')
      expect(
        readWindowsRegistryProxy((args: string[]) =>
          args.includes('ProxyEnable')
            ? { exitCode: 0, stdout: '    ProxyEnable    REG_DWORD    0x1\n' }
            : { exitCode: 0, stdout: '    ProxyServer    REG_SZ    \n' },
        ),
      ).toBe('')
    },
  )
})

describe('extractProxyEndpoint / probeProxyReachable（可达性门检）', () => {
  it('常见协议解析：显式端口直取，缺省端口按协议补', () => {
    expect(extractProxyEndpoint('http://127.0.0.1:10808')).toEqual({ host: '127.0.0.1', port: 10808 })
    expect(extractProxyEndpoint('socks5://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 1080 })
    expect(extractProxyEndpoint('http://proxy.local')).toEqual({ host: 'proxy.local', port: 80 })
    expect(extractProxyEndpoint('https://proxy.local:8443')).toEqual({ host: 'proxy.local', port: 8443 })
  })

  it('非法输入 → null（探测按不可达处理）', () => {
    expect(extractProxyEndpoint('')).toBeNull()
    expect(extractProxyEndpoint('not a url')).toBeNull()
    // 无默认端口的协议且未写端口 → 无法探测
    expect(extractProxyEndpoint('gopher://proxy.local')).toBeNull()
  })

  it('probeProxyReachable：URL 解析失败直接 false，不发起连接', async () => {
    expect(await probeProxyReachable('not a url')).toBe(false)
    expect(await probeProxyReachable('')).toBe(false)
  })

  it('probeProxyReachable：本机无监听端口 → false（ECONNREFUSED 即时返回）', async () => {
    // 临时 TCP server 探活的反面：绑一个空闲端口（listen 后关闭）再探测必拒绝。
    // 选 IANA 保留的丢弃端口 9（discard）——本机几乎不可能有服务在听。
    expect(await probeProxyReachable('http://127.0.0.1:9', 500)).toBe(false)
  })

  it('probeProxyReachable：真实监听端口 → true', async () => {
    const { createServer } = await import('node:http')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('未取得监听端口')
    try {
      expect(await probeProxyReachable(`http://127.0.0.1:${address.port}`, 1000)).toBe(true)
    } finally {
      server.close()
    }
  })
})
