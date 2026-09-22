/**
 * tray 纯函数单测：NOTIFYICONDATAW x64 布局 / UTF-16LE+NUL 写入（含代理对不劈）/
 * 托盘菜单模型（运行态置灰）。
 * FFI 部分依赖 win32+Bun 真实托盘，由 scripts/verify-tray.ts 取证覆盖
 * （本进程 FFI 链路断言 + 真窗关闭到托盘存活断言）。
 */
import { describe, expect, it } from 'vitest'
import {
  NOTIFY_ICON_DATA_SIZE,
  TRAY_CMD,
  buildNotifyIconData,
  buildTrayMenuModel,
  writeUtf16z,
} from '../services/tray'

describe('writeUtf16z', () => {
  it('写入 UTF-16LE 字节并以 NUL 结尾', () => {
    const buf = Buffer.alloc(16)
    const written = writeUtf16z(buf, 0, 8, 'ab')
    expect(written).toBe(2)
    expect([...buf.subarray(0, 6)]).toEqual([0x61, 0, 0x62, 0, 0, 0])
  })

  it('空字符串只写 NUL，全零缓冲保持干净', () => {
    const buf = Buffer.alloc(4)
    expect(writeUtf16z(buf, 0, 2, '')).toBe(0)
    expect([...buf]).toEqual([0, 0, 0, 0])
  })

  it('超容量截断且不劈代理对（孤立高代理整对放弃）', () => {
    const buf = Buffer.alloc(8)
    // 容量 4 wchar：'😀'(代理对) + '字' 后只剩 1 wchar，第二个代理对 '😀' 整对放弃
    const written = writeUtf16z(buf, 0, 4, '😀字😀')
    expect(written).toBe(3)
    // 末尾必须是 NUL 且不出现孤立高代理（0xD83D 无 0xDE00 跟随）
    expect(buf[6]).toBe(0)
    expect(buf[7]).toBe(0)
    expect([...buf.subarray(0, 6)]).toEqual([0x3d, 0xd8, 0x00, 0xde, 0x57, 0x5b])
  })

  it('截断恰好落在字符边界时正常写入', () => {
    const buf = Buffer.alloc(8)
    expect(writeUtf16z(buf, 0, 3, 'abcd')).toBe(2)
    expect([...buf.subarray(0, 6)]).toEqual([0x61, 0, 0x62, 0, 0, 0])
  })
})

describe('buildNotifyIconData', () => {
  const data = buildNotifyIconData({
    hwnd: 0x000007ff_80001234n,
    iconHandle: 0x00ff00ff_00110022n,
    callbackMessage: 0x8001,
    id: 1,
    tooltip: 'SillyTavernLauncher',
  })

  it('总尺寸 976（x64 全量布局，cbSize 自洽）', () => {
    expect(data.length).toBe(NOTIFY_ICON_DATA_SIZE)
    expect(data.readUInt32LE(0)).toBe(NOTIFY_ICON_DATA_SIZE)
  })

  it('字段落位：hWnd@8 / uID@16 / uFlags@20 / uCallbackMessage@24 / hIcon@32', () => {
    expect(data.readBigUInt64LE(8)).toBe(0x000007ff_80001234n)
    expect(data.readUInt32LE(16)).toBe(1)
    // NIF_MESSAGE|NIF_ICON|NIF_TIP = 0x7
    expect(data.readUInt32LE(20)).toBe(0x7)
    expect(data.readUInt32LE(24)).toBe(0x8001)
    expect(data.readBigUInt64LE(32)).toBe(0x00ff00ff_00110022n)
  })

  it('tooltip 落在 szTip@40 的 UTF-16LE + NUL', () => {
    const tip = 'SillyTavernLauncher'
    for (let i = 0; i < tip.length; i++) {
      expect(data.readUInt16LE(40 + i * 2)).toBe(tip.charCodeAt(i))
    }
    expect(data.readUInt16LE(40 + tip.length * 2)).toBe(0)
    // szTip 区间（128 wchar）尾段保持零
    expect(data.readUInt16LE(40 + 127 * 2)).toBe(0)
  })

  it('超长 tooltip 截断到 127 字符且结尾仍是 NUL', () => {
    const long = buildNotifyIconData({
      hwnd: 1n,
      iconHandle: 1n,
      callbackMessage: 0x8001,
      id: 1,
      tooltip: 'x'.repeat(500),
    })
    expect(long.readUInt8(40 + 126 * 2)).toBe('x'.charCodeAt(0) & 0xff)
    expect(long.readUInt16LE(40 + 127 * 2)).toBe(0)
  })
})

describe('buildTrayMenuModel', () => {
  it('五命令项对齐旧版 pystray 菜单 + 退出前独立分隔线占位项（共 6 项）', () => {
    const model = buildTrayMenuModel(false)
    // 分隔线是独立占位项（id=0，不可选中）——不是"quit 自带前置分隔线"
    // （后者曾让 append 循环只画线不画项，"托盘缺失退出启动器"的根因）
    expect(model.map((e) => e.id)).toEqual([
      TRAY_CMD.openMain,
      TRAY_CMD.startSt,
      TRAY_CMD.stopSt,
      TRAY_CMD.restartSt,
      0,
      TRAY_CMD.quit,
    ])
    const separators = model.filter((e) => e.separator)
    expect(separators).toHaveLength(1)
    expect(separators[0].id).toBe(0)
    // quit 是可点菜单项：非分隔、有标签、可用
    const quit = model[model.length - 1]
    expect(quit.id).toBe(TRAY_CMD.quit)
    expect(quit.separator).toBe(false)
    expect(quit.label).toBe('退出启动器')
    expect(quit.enabled).toBe(true)
  })

  it('未运行：启动可用，关闭/重启置灰', () => {
    const byId = new Map(buildTrayMenuModel(false).map((e) => [e.id, e]))
    expect(byId.get(TRAY_CMD.openMain)?.enabled).toBe(true)
    expect(byId.get(TRAY_CMD.startSt)?.enabled).toBe(true)
    expect(byId.get(TRAY_CMD.stopSt)?.enabled).toBe(false)
    expect(byId.get(TRAY_CMD.restartSt)?.enabled).toBe(false)
    expect(byId.get(TRAY_CMD.quit)?.enabled).toBe(true)
  })

  it('运行中：启动置灰，关闭/重启可用（每次右键现读，模型即状态）', () => {
    const byId = new Map(buildTrayMenuModel(true).map((e) => [e.id, e]))
    expect(byId.get(TRAY_CMD.startSt)?.enabled).toBe(false)
    expect(byId.get(TRAY_CMD.stopSt)?.enabled).toBe(true)
    expect(byId.get(TRAY_CMD.restartSt)?.enabled).toBe(true)
  })
})
