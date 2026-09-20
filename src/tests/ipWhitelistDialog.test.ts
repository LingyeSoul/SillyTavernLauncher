/**
 * IpWhitelistDialog 纯逻辑单测（← ip_whitelist_dialog.py 语义移植的锁定测试）：
 * - parseLines / insertSubnetLine：_parse_lines 与 _append_current_subnet 的
 *   拆分去重、头部插入、已存在不动语义。
 * - defaultIpWhitelistDraft ↔ StConfig 字段默认值一致：把「重置为默认值」的
 *   UI 草稿与 stConfig 落盘默认值锁成同一关系，防两侧魔数漂移。
 * - draftFromStConfig：打开对话框时的草稿装配 roundtrip。
 *
 * 纪律：WhitelistDialogs.tsx 传递依赖 stores/settings（顶层 create 即按 cwd 读
 * config.json / SillyTavern/config.yaml），故照 ui.smoke.test.tsx 模式——
 * beforeAll chdir 临时目录后再动态 import，静态导入会被提升破坏时序。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type WhitelistModule = typeof import('../ui/dialogs/WhitelistDialogs')
type StConfigModule = typeof import('../services/stConfig')

let tempDir: string
let originalCwd: string
let wl: WhitelistModule
let stModule: StConfigModule

beforeAll(async () => {
  originalCwd = process.cwd()
  tempDir = mkdtempSync(join(tmpdir(), 'stl-ipwl-'))
  process.chdir(tempDir)
  ;[wl, stModule] = await Promise.all([
    import('../ui/dialogs/WhitelistDialogs'),
    import('../services/stConfig'),
  ])
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(tempDir, { force: true, recursive: true })
})

describe('parseLines（← _parse_lines）', () => {
  it('按行拆分、trim、去空行、去重（保序）', () => {
    expect(wl.parseLines('::1\n  127.0.0.1  \n\n::1\n10.0.0.1/8\n')).toEqual([
      '::1',
      '127.0.0.1',
      '10.0.0.1/8',
    ])
  })

  it('空串与纯空白行为空数组（清空守卫的输入形态）', () => {
    expect(wl.parseLines('')).toEqual([])
    expect(wl.parseLines('  \n  \n')).toEqual([])
  })
})

describe('insertSubnetLine（← _append_current_subnet）', () => {
  it('新网段插入头部', () => {
    expect(wl.insertSubnetLine('127.0.0.1\n::1', '192.168.1.*')).toBe(
      '192.168.1.*\n127.0.0.1\n::1',
    )
  })

  it('已存在的网段原样返回（不重复、不动用户排版）', () => {
    expect(wl.insertSubnetLine('127.0.0.0/8\n  192.168.1.*  ', '192.168.1.*')).toBe(
      '127.0.0.0/8\n  192.168.1.*  ',
    )
  })

  it('空列表插入后仅含该网段', () => {
    expect(wl.insertSubnetLine('', '10.0.0.*')).toBe('10.0.0.*')
  })
})

describe('ipWhitelistDraftError（← PrivateRangesDialog 防误操作守卫）', () => {
  it('过滤开启且网段清空（含纯空白）→ 拦截并给出文案', () => {
    const draft = { ...wl.defaultIpWhitelistDraft(), privateEnabled: true, ranges: '' }
    expect(wl.ipWhitelistDraftError(draft)).toMatch(/至少保留一个放行网段/)
    expect(wl.ipWhitelistDraftError({ ...draft, ranges: '  \n  \n' })).toMatch(/至少保留一个放行网段/)
  })

  it('守卫取草稿开关而非落盘值：本次打开过滤且清空网段同样拦下', () => {
    // 落盘 privateAddressWhitelistEnabled=false（StConfig 默认），草稿本次要开 → 仍拦
    const st = new stModule.StConfig({ baseDir: join(tempDir, 'no-such-st-3') })
    const draft = { ...wl.draftFromStConfig(st), privateEnabled: true, ranges: '' }
    expect(wl.ipWhitelistDraftError(draft)).not.toBeNull()
  })

  it('过滤关闭时清空网段放行；过滤开启且有网段放行', () => {
    expect(
      wl.ipWhitelistDraftError({ ...wl.defaultIpWhitelistDraft(), privateEnabled: false, ranges: '' }),
    ).toBeNull()
    expect(wl.ipWhitelistDraftError({ ...wl.defaultIpWhitelistDraft(), privateEnabled: true })).toBeNull()
  })
})

describe('defaultIpWhitelistDraft（← _reset_to_default）', () => {
  it('默认值与 StConfig 字段默认值逐项一致（防 UI 侧魔数漂移）', () => {
    // baseDir 指向不存在的目录：config.yaml 缺失 → 全部字段落到类默认值
    const st = new stModule.StConfig({ baseDir: join(tempDir, 'no-such-st') })
    expect(wl.defaultIpWhitelistDraft()).toEqual({
      mode: st.whitelistMode,
      forwarded: st.enableForwardedWhitelist,
      ips: st.whitelistIps.join('\n'),
      privateEnabled: st.privateAddressWhitelistEnabled,
      allowUnresolved: st.privateAddressAllowUnresolvedHosts,
      logBlocked: st.privateAddressLogBlocked,
      logAllowed: st.privateAddressLogAllowed,
      ranges: st.privateAddressAllowedRanges.join('\n'),
    })
  })

  it('具名断言旧版 _reset_to_default 的八项默认值（语义锚定）', () => {
    expect(wl.defaultIpWhitelistDraft()).toEqual({
      mode: true,
      forwarded: true,
      ips: '::1\n127.0.0.1',
      privateEnabled: false,
      allowUnresolved: false,
      logBlocked: true,
      logAllowed: false,
      ranges: '127.0.0.0/8\n::1/128',
    })
  })
})

describe('draftFromStConfig（← show() 控件初值装配）', () => {
  it('从实例字段构造草稿（打开对话框时的快照语义）', () => {
    const st = new stModule.StConfig({ baseDir: join(tempDir, 'no-such-st-2') })
    st.whitelistMode = false
    st.enableForwardedWhitelist = false
    st.whitelistIps = ['192.168.1.*', '127.0.0.1']
    st.privateAddressWhitelistEnabled = true
    st.privateAddressAllowUnresolvedHosts = true
    st.privateAddressLogBlocked = false
    st.privateAddressLogAllowed = true
    st.privateAddressAllowedRanges = ['127.0.0.0/8', '192.168.1.0/24']
    expect(wl.draftFromStConfig(st)).toEqual({
      mode: false,
      forwarded: false,
      ips: '192.168.1.*\n127.0.0.1',
      privateEnabled: true,
      allowUnresolved: true,
      logBlocked: false,
      logAllowed: true,
      ranges: '127.0.0.0/8\n192.168.1.0/24',
    })
  })
})
