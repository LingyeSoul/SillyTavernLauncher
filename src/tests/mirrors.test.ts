/**
 * 镜像源服务（services/mirrors.ts，2026-09-21 镜像增强）门禁：
 * - 注册表完整性（host 唯一 / 形如主机名 / 官方哨兵不混入 / 旧站保留）；
 * - 前缀改写统一实现的兼容矩阵（原 updater/extensions/isoGit 三处重复逻辑的并集）；
 * - ping 输出解析与 IDN 归一（跨语言、跨平台文案都要命中）；
 * - 选优/故障切换的判定链（无可用站时不乱指、取证失败才换源、手动模式不换）；
 * 全部探针注入——本文件零网络、零子进程。
 */
import { describe, expect, it } from 'vitest'
import {
  applyMirrorPrefix,
  autoSelectMirror,
  activeMirrorHost,
  createMirrorPingProbe,
  ensureMirrorSelection,
  failoverMirror,
  isGithubUrl,
  isValidMirrorHost,
  isNetworkFailureText,
  mirrorPrefixUrl,
  mirrorProbeUrl,
  MIRROR_PROBE_TARGET,
  MIRROR_SELECTION_TTL_MS,
  MIRROR_SOURCES,
  normalizeSpeedTest,
  OFFICIAL_MIRROR,
  orderedCandidates,
  parsePingLatency,
  pickFastestMirror,
  readMirrorState,
  speedTestMirrors,
  toAsciiHost,
  writeMirrorState,
  type MirrorProbe,
  type MirrorState,
  type MirrorStoreLike,
} from '../services/mirrors'

/** 假 configStore：只实现 get/set/save 三点面（点号嵌套语义与真实实现一致） */
function makeStore(initial: Record<string, unknown> = {}): MirrorStoreLike & {
  data: Record<string, unknown>
  saves: number
} {
  const store = {
    data: initial as Record<string, unknown>,
    saves: 0,
    get<T = unknown>(key: string, defaultValue?: T): T {
      let value: unknown = store.data
      for (const part of key.split('.')) {
        if (value === null || typeof value !== 'object') return defaultValue as T
        value = (value as Record<string, unknown>)[part]
      }
      return (value === undefined ? defaultValue : value) as T
    },
    set(key: string, value: unknown): void {
      const parts = key.split('.')
      let cursor = store.data
      for (const part of parts.slice(0, -1)) {
        const next = cursor[part]
        if (next === null || typeof next !== 'object') cursor[part] = {}
        cursor = cursor[part] as Record<string, unknown>
      }
      cursor[parts[parts.length - 1] ?? ''] = value
    },
    save(): void {
      store.saves += 1
    },
  }
  return store
}

/** 装机态：已启用加速 + 自动选优 + 指定当前 host */
function enabledState(host: string, extra: Partial<MirrorState> = {}): Record<string, unknown> {
  return {
    github: {
      enabled: true,
      mirror: host,
      auto: true,
      speedtest: { results: {}, failed: [], tested_at: '' },
      ...extra,
    },
  }
}

/** 假探针：查表返回；未命中 = 不可达（null），并记录探测次数 */
function tableProbe(table: Record<string, number | null>): { probe: MirrorProbe; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    probe: async (host: string) => {
      calls.push(host)
      return table[host] ?? null
    },
  }
}

const FAST_A = 'github.dpik.top'
const FAST_B = 'gh.ddlc.top'
const MEDIUM = 'gh.chalin.tk'

describe('镜像注册表', () => {
  it('host 唯一且形如主机名；官方哨兵不混入名单', () => {
    const hosts = MIRROR_SOURCES.map((source) => source.host)
    expect(new Set(hosts).size).toBe(hosts.length)
    for (const host of hosts) {
      // 纯主机名（不含协议/路径/端口）；IDN（ghf.无名氏.top）允许原字面量，
      // 网络层由 toAsciiHost 转 punycode
      expect(host, `${host} 应为纯主机名（不含协议/路径）`).not.toMatch(/[/\\:\s]/)
      expect(host).not.toBe(OFFICIAL_MIRROR)
      expect(isValidMirrorHost(host)).toBe(true)
    }
  })

  it('用户实测名单收录齐全（fast 12 站 + medium 41 站）且报告值合理', () => {
    const fast = MIRROR_SOURCES.filter((source) => source.tier === 'fast')
    const medium = MIRROR_SOURCES.filter((source) => source.tier === 'medium')
    expect(fast).toHaveLength(12)
    expect(medium).toHaveLength(41)
    for (const source of [...fast, ...medium]) {
      expect(source.reportedMs, `${source.host} 缺报告延迟`).toBeDefined()
      expect(source.reportedMs ?? 0).toBeGreaterThan(0)
    }
    expect(fast[0]?.host).toBe(FAST_A)
  })

  it('旧版内置镜像保留（老配置升级后仍能加速）', () => {
    expect(isValidMirrorHost('gh-proxy.org')).toBe(true)
    expect(isValidMirrorHost('gh.llkk.cc')).toBe(true)
  })
})

describe('前缀改写（统一实现）', () => {
  const URL_GH = 'https://github.com/SillyTavern/SillyTavern.git'
  const URL_RAW = 'https://raw.githubusercontent.com/a/b/c'

  it('官方哨兵/空/注册表外主机名 → 原样返回（不加速，也不乱指域名）', () => {
    expect(applyMirrorPrefix(URL_GH, OFFICIAL_MIRROR)).toBe(URL_GH)
    expect(applyMirrorPrefix(URL_GH, '')).toBe(URL_GH)
    expect(applyMirrorPrefix(URL_GH, 'unknown.mirror')).toBe(URL_GH)
  })

  it('注册表内镜像 → https://<host>/<原始 URL>（含旧版两站，行为与升级前逐字节一致）', () => {
    expect(applyMirrorPrefix(URL_GH, 'gh-proxy.org')).toBe(`https://gh-proxy.org/${URL_GH}`)
    expect(applyMirrorPrefix(URL_GH, 'gh.llkk.cc')).toBe(`https://gh.llkk.cc/${URL_GH}`)
    expect(applyMirrorPrefix(URL_GH, FAST_A)).toBe(`https://${FAST_A}/${URL_GH}`)
    expect(applyMirrorPrefix(URL_RAW, FAST_A)).toBe(`https://${FAST_A}/${URL_RAW}`)
  })

  it('非 GitHub 家族 URL 不加速（http/https 皆可，其余协议拒绝）', () => {
    expect(applyMirrorPrefix('https://example.com/x.git', FAST_A)).toBe('https://example.com/x.git')
    expect(applyMirrorPrefix('https://evil.com/?u=https://github.com/a/b', FAST_A)).toBe(
      'https://evil.com/?u=https://github.com/a/b',
    )
    expect(applyMirrorPrefix('git://github.com/a/b', FAST_A)).toBe('git://github.com/a/b')
    expect(applyMirrorPrefix('http://github.com/a/b', FAST_A)).toBe(`https://${FAST_A}/http://github.com/a/b`)
  })

  it('isGithubUrl 覆盖 github.com 子域与 githubusercontent 家族', () => {
    expect(isGithubUrl('https://github.com/a')).toBe(true)
    expect(isGithubUrl('https://raw.githubusercontent.com/a')).toBe(true)
    expect(isGithubUrl('https://api.github.com/repos/a')).toBe(true)
    expect(isGithubUrl('https://objects.githubusercontent.com/x')).toBe(true)
    expect(isGithubUrl('https://github.com.evil.com/a')).toBe(false)
    expect(isGithubUrl('not a url')).toBe(false)
  })

  it('mirrorPrefixUrl / mirrorProbeUrl 形状固定（探针即 git 握手端点）', () => {
    expect(mirrorPrefixUrl(FAST_A)).toBe(`https://${FAST_A}/`)
    expect(mirrorProbeUrl(FAST_A)).toBe(`https://${FAST_A}/${MIRROR_PROBE_TARGET}`)
    expect(MIRROR_PROBE_TARGET).toContain('info/refs?service=git-upload-pack')
  })
})

describe('ping 解析与 IDN 归一', () => {
  it('zh/en/fr 文案都能取到毫秒（跨语言稳定片段）', () => {
    expect(parsePingLatency('来自 1.2.3.4 的回复: 字节=32 时间=23ms TTL=55')).toBe(23)
    expect(parsePingLatency('Reply from 1.2.3.4: bytes=32 time=23ms TTL=55')).toBe(23)
    expect(parsePingLatency('temps=23 ms')).toBe(23)
  })

  it('多包取最小值（抗抖动）；<1ms 与逗号小数都能解析', () => {
    expect(parsePingLatency('time=42ms\ntime=17ms')).toBe(17)
    expect(parsePingLatency('time<1ms')).toBe(1)
    expect(parsePingLatency('temps=23,5 ms')).toBe(23.5)
  })

  it('超时/找不到主机 → null（不误报延迟）', () => {
    expect(parsePingLatency('请求超时。')).toBeNull()
    expect(parsePingLatency('Request timed out.')).toBeNull()
    expect(parsePingLatency('Ping 请求找不到主机 x。')).toBeNull()
    expect(parsePingLatency('')).toBeNull()
  })

  it('IDN 主机名转 punycode（DNS/ping 层不接受原字面量）', () => {
    expect(toAsciiHost('ghf.无名氏.top')).toMatch(/^ghf\.xn--/)
    expect(toAsciiHost(FAST_A)).toBe(FAST_A)
  })

  it('ping 探针只认注册表内主机（脏配置不进网络层）', async () => {
    const calls: string[] = []
    const probe = createMirrorPingProbe({
      runPing: async (host) => {
        calls.push(host)
        return 'time=9ms'
      },
      tcpProbe: async () => null,
    })
    expect(await probe('unknown.mirror')).toBeNull()
    expect(calls).toHaveLength(0)
    expect(await probe(FAST_A)).toBe(9)
  })

  it('ICMP 无回复时回落 TCP 握手计时（不因屏蔽 ICMP 误杀可用镜像）', async () => {
    const probe = createMirrorPingProbe({
      runPing: async () => '请求超时。',
      tcpProbe: async () => 88,
    })
    expect(await probe(FAST_A)).toBe(88)
  })

  it('ping 进程本身不可用时也不判死（异常 → TCP 兜底）', async () => {
    const probe = createMirrorPingProbe({
      runPing: async () => {
        throw new Error('ping 不存在')
      },
      tcpProbe: async () => 120,
    })
    expect(await probe(FAST_A)).toBe(120)
  })
})

describe('状态读写与生效口径', () => {
  it('normalizeSpeedTest 丢掉脏值（非数字延迟/非字符串失败项）', () => {
    const dirty = {
      results: { [FAST_A]: 100, [FAST_B]: 'x', [MEDIUM]: -5, bogus: Number.NaN },
      failed: [FAST_B, 42, null],
      tested_at: 7,
    }
    const clean = normalizeSpeedTest(dirty)
    expect(clean.results).toEqual({ [FAST_A]: 100 })
    expect(clean.failed).toEqual([FAST_B])
    expect(clean.tested_at).toBe('')
    expect(normalizeSpeedTest(null).results).toEqual({})
  })

  it('activeMirrorHost fail-safe：未启用/未选定/主机名非法 → 官方源', () => {
    expect(activeMirrorHost(makeStore())).toBe(OFFICIAL_MIRROR)
    expect(activeMirrorHost(makeStore({ github: { enabled: false, mirror: FAST_A } }))).toBe(OFFICIAL_MIRROR)
    expect(activeMirrorHost(makeStore({ github: { enabled: true, mirror: '' } }))).toBe(OFFICIAL_MIRROR)
    expect(activeMirrorHost(makeStore({ github: { enabled: true, mirror: 'not-a-mirror' } }))).toBe(OFFICIAL_MIRROR)
    expect(activeMirrorHost(makeStore(enabledState(FAST_A)))).toBe(FAST_A)
  })

  it('writeMirrorState 落盘并计数 save；readMirrorState 缺键回落默认', () => {
    const store = makeStore()
    expect(readMirrorState(store)).toEqual({
      enabled: false,
      host: '',
      auto: true,
      speedtest: { results: {}, failed: [], tested_at: '' },
    })
    writeMirrorState({ enabled: true, host: FAST_A, auto: false }, store)
    expect(store.saves).toBe(1)
    expect(readMirrorState(store)).toMatchObject({ enabled: true, host: FAST_A, auto: false })
  })
})

describe('选优', () => {
  it('pickFastestMirror 取最小延迟；并列按注册表次序（结果稳定）', () => {
    expect(pickFastestMirror({ [FAST_B]: 200, [FAST_A]: 100 })).toEqual({ host: FAST_A, latencyMs: 100 })
    expect(pickFastestMirror({ [FAST_B]: 100, [FAST_A]: 100 })).toEqual({ host: FAST_A, latencyMs: 100 })
    expect(pickFastestMirror({ [FAST_A]: 100 }, [FAST_A])).toBeNull()
    expect(pickFastestMirror({})).toBeNull()
  })

  it('orderedCandidates 跳过实测不可用站，其余保持注册表次序', () => {
    const candidates = orderedCandidates({ results: {}, failed: [FAST_A], tested_at: '' })
    expect(candidates).toHaveLength(MIRROR_SOURCES.length - 1)
    expect(candidates.map((item) => item.host)).not.toContain(FAST_A)
    expect(candidates[0]?.host).toBe(FAST_B)
  })

  it('autoSelectMirror：未启用/手动模式直接返回，不发起任何探测', async () => {
    const off = tableProbe({ [FAST_A]: 10 })
    const official = await autoSelectMirror({ probe: off.probe, store: makeStore({ github: { enabled: false } }) })
    expect(official.changed).toBe(false)
    expect(off.calls).toHaveLength(0)

    const manual = tableProbe({ [FAST_A]: 10 })
    const locked = await autoSelectMirror({
      probe: manual.probe,
      store: makeStore(enabledState(MEDIUM, { auto: false })),
    })
    expect(locked.changed).toBe(false)
    expect(locked.message).toContain('手动')
    expect(manual.calls).toHaveLength(0)
  })

  it('autoSelectMirror：首批内取最快并落盘（探测数受限，不打满全名单）', async () => {
    const { probe, calls } = tableProbe({ [FAST_A]: 320, [FAST_B]: 120 })
    const store = makeStore(enabledState(''))
    const outcome = await autoSelectMirror({ probe, store })
    expect(outcome.exhausted).toBe(false)
    expect(outcome.host).toBe(FAST_B)
    expect(outcome.latencyMs).toBe(120)
    expect(outcome.changed).toBe(true)
    expect(calls).toHaveLength(6) // 默认首批 6 站：首个批次内已有可用站即停
    expect(readMirrorState(store).host).toBe(FAST_B)
    expect(readMirrorState(store).speedtest.results).toEqual({ [FAST_A]: 320, [FAST_B]: 120 })
  })

  it('autoSelectMirror：首批全灭 → 逐批续探（失败项记入 failed 供后续跳过）', async () => {
    const batches = [0, 1].map((index) =>
      MIRROR_SOURCES.slice(index * 6, index * 6 + 6).map((source) => source.host),
    )
    const table: Record<string, number | null> = { [MEDIUM]: 400 }
    for (const host of [...(batches[0] ?? []), ...(batches[1] ?? [])]) table[host] = null
    const { probe, calls } = tableProbe(table)
    const outcome = await autoSelectMirror({ probe, store: makeStore(enabledState('')) })
    // MEDIUM 在第三批 → 前两批（12 站）全部探过后才命中它；同批其余站并行探完，
    // 但"命中即停"——不会继续探第三批之后的站
    expect(outcome.host).toBe(MEDIUM)
    expect(calls.slice(0, 12)).toEqual([...(batches[0] ?? []), ...(batches[1] ?? [])])
    expect(calls).toHaveLength(18)
    expect(outcome.speedtest.failed).toEqual(
      expect.arrayContaining([...(batches[0] ?? []), ...(batches[1] ?? [])]),
    )
    expect(outcome.speedtest.failed).not.toContain(MEDIUM)
  })

  it('autoSelectMirror：候选全灭 → exhausted，host 空，不把用户指到测不通的站', async () => {
    const { probe } = tableProbe({})
    const store = makeStore(enabledState(''))
    const outcome = await autoSelectMirror({ probe, store })
    expect(outcome.exhausted).toBe(true)
    expect(outcome.host).toBe('')
    expect(outcome.message).toContain('官方源')
    expect(readMirrorState(store).host).toBe('')
    // 失败名单落盘（下一轮选优不再重复试这些站）
    expect(readMirrorState(store).speedtest.failed.length).toBeGreaterThan(0)
  })

  it('ensureMirrorSelection：新鲜选定零探测直接返回；未选定/过期才跑选优', async () => {
    const now = (): Date => new Date('2026-09-21T12:00:00.000Z')
    const freshState = enabledState(FAST_A, {
      speedtest: { results: { [FAST_A]: 100 }, failed: [], tested_at: '2026-09-21T11:00:00.000Z' },
    })
    const fresh = tableProbe({ [FAST_A]: 100 })
    expect(await ensureMirrorSelection({ probe: fresh.probe, store: makeStore(freshState), now })).toBeNull()
    expect(fresh.calls).toHaveLength(0)

    const staleAt = new Date(now().getTime() - MIRROR_SELECTION_TTL_MS - 1000).toISOString()
    const staleState = enabledState(FAST_A, {
      speedtest: { results: { [FAST_A]: 100 }, failed: [], tested_at: staleAt },
    })
    const stale = tableProbe({ [FAST_B]: 50 })
    const outcome = await ensureMirrorSelection({ probe: stale.probe, store: makeStore(staleState), now })
    expect(outcome?.host).toBe(FAST_B)
    expect(stale.calls.length).toBeGreaterThan(0)

    // 官方源 / 手动模式 → 一律不动作
    expect(await ensureMirrorSelection({ probe: stale.probe, store: makeStore(), now })).toBeNull()
    expect(
      await ensureMirrorSelection({ probe: stale.probe, store: makeStore(enabledState(FAST_A, { auto: false })), now }),
    ).toBeNull()
  })
})

describe('故障切换（取证式）', () => {
  it('当前镜像仍可达 → 判定与镜像无关，配置一动不动', async () => {
    const table = tableProbe({ [FAST_A]: 90 })
    const store = makeStore(enabledState(FAST_A))
    const outcome = await failoverMirror('git clone 失败', {
      probe: table.probe,
      verify: table.probe,
      store,
    })
    expect(outcome.switched).toBe(false)
    expect(outcome.to).toBe(FAST_A)
    expect(outcome.message).toContain('与镜像无关')
    expect(store.saves).toBe(0)
    expect(readMirrorState(store).host).toBe(FAST_A)
  })

  it('当前镜像不可达 → 切到首个可达批次内最快的备用站并记入 failed', async () => {
    // 取证探针（当前站）恒不可达；候选探针按表返回
    const verify: MirrorProbe = async () => null
    // 候选顺序 = 注册表次序去掉 FAST_A → 首批 6 站里 FAST_B 最快
    const { probe, calls } = tableProbe({ [FAST_B]: 70, [MEDIUM]: 60 })
    const store = makeStore(enabledState(FAST_A))
    const outcome = await failoverMirror('git pull 失败', { probe, verify, store })
    expect(outcome.switched).toBe(true)
    expect(outcome.from).toBe(FAST_A)
    expect(outcome.to).toBe(FAST_B)
    expect(outcome.message).toContain(FAST_B)
    // 命中首批即停：不在故障路径上做全量测速（MEDIUM 不进首批，故未被探测）
    expect(calls).toHaveLength(6)
    expect(calls).not.toContain(MEDIUM)
    const state = readMirrorState(store)
    expect(state.host).toBe(FAST_B)
    expect(state.speedtest.failed).toContain(FAST_A)
  })

  it('手动模式：失败也不自动换源（尊重用户锁定）', async () => {
    const store = makeStore(enabledState(FAST_A, { auto: false }))
    const outcome = await failoverMirror('git clone 失败', {
      probe: async () => null,
      verify: async () => null,
      store,
    })
    expect(outcome.switched).toBe(false)
    expect(outcome.message).toContain('手动')
    expect(store.saves).toBe(0)
    expect(readMirrorState(store).host).toBe(FAST_A)
  })

  it('备用站全灭 → 保持原设置并清空 failed（一次断网不把镜像池锁死）', async () => {
    const store = makeStore(
      enabledState(FAST_A, {
        speedtest: { results: {}, failed: [FAST_B], tested_at: '' },
      }),
    )
    const outcome = await failoverMirror('git fetch 失败', {
      probe: async () => null,
      verify: async () => null,
      store,
    })
    expect(outcome.exhausted).toBe(true)
    expect(outcome.switched).toBe(false)
    expect(readMirrorState(store).host).toBe(FAST_A)
    expect(readMirrorState(store).speedtest.failed).toEqual([])
  })
})

describe('全量测速', () => {
  it('逐个回调进度；成功进 results、失败进 failed；非法主机名不参与', async () => {
    const hosts = [FAST_A, FAST_B, MEDIUM]
    const table: Record<string, number | null> = { [FAST_A]: 500, [FAST_B]: 501 }
    const { probe } = tableProbe(table)
    const seen: Array<[string, number | null]> = []
    const outcome = await speedTestMirrors([...hosts, 'unknown.mirror'], {
      probe,
      concurrency: 2,
      onResult: (host, latency) => seen.push([host, latency]),
      now: () => new Date('2026-09-21T00:00:00.000Z'),
    })
    expect(seen).toHaveLength(3)
    expect(Object.keys(outcome.results).sort()).toEqual([FAST_A, FAST_B].sort())
    expect(outcome.failed).toEqual([MEDIUM])
    expect(outcome.tested_at).toBe('2026-09-21T00:00:00.000Z')
  })
})

describe('网络失败特征', () => {
  it('git/iso/fetch 三类真实报错命中，本地失败不误伤', () => {
    expect(isNetworkFailureText("fatal: unable to access 'https://x/': Failed to connect to x port 443")).toBe(true)
    expect(isNetworkFailureText('fatal: unable to access ...: Could not resolve host: gh.example')).toBe(true)
    expect(isNetworkFailureText('HttpError: 502 Bad Gateway')).toBe(true)
    expect(isNetworkFailureText('TypeError: fetch failed')).toBe(true)
    expect(isNetworkFailureText('目标目录已存在: x')).toBe(false)
    expect(isNetworkFailureText('不是有效的 SillyTavern 扩展')).toBe(false)
  })
})
