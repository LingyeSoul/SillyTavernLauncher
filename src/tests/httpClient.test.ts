/**
 * httpClient（fetch TLS 容错层）单元测试：
 * - isTlsVerifyError：code / message / cause 三种来源的信任链失败识别
 * - fetchWithTlsFallback：TLS 失败 → 系统 CA 注入重试；非 TLS 错误不打扰回退
 * - 全程注入 fetchImpl / caProvider，绝不触真实网络与 PowerShell
 */
import { describe, expect, it, vi } from 'vitest'
import {
  fetchWithTlsFallback,
  isTlsVerifyError,
  TlsInterceptError,
  type CaProvider,
  type FetchLikeX,
} from '../services/httpClient'

/** 构造 Bun/Node 证书信任链失败错误（code + message 两种载体） */
function tlsError(code?: string, message = 'unable to verify the first certificate'): Error {
  const err = new Error(message)
  if (code !== undefined) {
    Object.assign(err, { code })
  }
  return err
}

describe('isTlsVerifyError（证书信任链失败识别）', () => {
  it('code 命中（Bun 直接给 code）', () => {
    expect(isTlsVerifyError(tlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe(true)
    expect(isTlsVerifyError(tlsError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))).toBe(true)
    expect(isTlsVerifyError(tlsError('SELF_SIGNED_CERT_IN_CHAIN'))).toBe(true)
    expect(isTlsVerifyError(tlsError('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe(true)
  })

  it('message 命中（Bun 只给 message 的兜底）', () => {
    expect(isTlsVerifyError(tlsError())).toBe(true)
    expect(isTlsVerifyError(tlsError(undefined, 'SSL certificate problem: self-signed certificate'))).toBe(true)
    expect(isTlsVerifyError(tlsError(undefined, 'unable to get local issuer certificate'))).toBe(true)
    expect(isTlsVerifyError(tlsError(undefined, 'certificate verify failed'))).toBe(true)
  })

  it('Node 错误藏于 cause 时也能识别', () => {
    const wrapper = new Error('fetch failed')
    Object.assign(wrapper, { cause: tlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE') })
    expect(isTlsVerifyError(wrapper)).toBe(true)
  })

  it('非证书错误不命中（真证书问题/网络故障/空值不误伤）', () => {
    expect(isTlsVerifyError(tlsError('CERT_HAS_EXPIRED', 'certificate has expired'))).toBe(false)
    expect(isTlsVerifyError(tlsError('ERR_TLS_CERT_ALTNAME_INVALID', 'Hostname/IP does not match certificate'))).toBe(false)
    expect(isTlsVerifyError(tlsError('ECONNRESET', 'socket hang up'))).toBe(false)
    expect(isTlsVerifyError(new TypeError('fetch failed'))).toBe(false)
    expect(isTlsVerifyError('not an error')).toBe(false)
    expect(isTlsVerifyError(null)).toBe(false)
  })
})

describe('fetchWithTlsFallback（系统证书库回退）', () => {
  const URL_ = 'https://example.com/data'
  const INIT = { headers: { 'User-Agent': 'test' } }
  const CA: CaProvider = async () => 'FAKE-CA-PEM'

  it('成功路径：单次调用，不触 caProvider', async () => {
    const fetchImpl: FetchLikeX = vi.fn(async () => new Response('ok', { status: 200 }))
    const caProvider = vi.fn(CA)
    const response = await fetchWithTlsFallback(URL_, INIT, { fetchImpl, caProvider })
    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(caProvider).not.toHaveBeenCalled()
  })

  it('TLS 失败 → 注入系统 CA 重试成功（init 保留原 headers）', async () => {
    const fetchImpl: FetchLikeX = vi.fn(async (_url, init) => {
      if (init?.tls?.ca === 'FAKE-CA-PEM') {
        return new Response('via-ca', { status: 200 })
      }
      throw tlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    })
    const response = await fetchWithTlsFallback(URL_, INIT, { fetchImpl, caProvider: CA })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('via-ca')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const retryInit = vi.mocked(fetchImpl).mock.calls[1]?.[1]
    expect(retryInit?.headers).toEqual(INIT.headers)
  })

  it('TLS 失败 + 导不出 CA → TlsInterceptError（原始信息保留）', async () => {
    const fetchImpl: FetchLikeX = vi.fn(async () => {
      throw tlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    })
    await expect(
      fetchWithTlsFallback(URL_, INIT, { fetchImpl, caProvider: async () => null }),
    ).rejects.toBeInstanceOf(TlsInterceptError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('TLS 失败 + 回退也失败 → TlsInterceptError', async () => {
    const fetchImpl: FetchLikeX = vi.fn(async () => {
      throw tlsError('SELF_SIGNED_CERT_IN_CHAIN')
    })
    await expect(
      fetchWithTlsFallback(URL_, INIT, { fetchImpl, caProvider: CA }),
    ).rejects.toBeInstanceOf(TlsInterceptError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('caProvider 抛异常 → 视为无 CA，抛 TlsInterceptError 而非崩溃', async () => {
    const fetchImpl: FetchLikeX = vi.fn(async () => {
      throw tlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    })
    await expect(
      fetchWithTlsFallback(URL_, INIT, {
        fetchImpl,
        caProvider: async () => {
          throw new Error('powershell gone')
        },
      }),
    ).rejects.toBeInstanceOf(TlsInterceptError)
  })

  it('非 TLS 错误原样上抛，绝不重试', async () => {
    const boom = new Error('network down')
    const fetchImpl: FetchLikeX = vi.fn(async () => {
      throw boom
    })
    const caProvider = vi.fn(CA)
    await expect(
      fetchWithTlsFallback(URL_, INIT, { fetchImpl, caProvider }),
    ).rejects.toBe(boom)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(caProvider).not.toHaveBeenCalled()
  })
})
