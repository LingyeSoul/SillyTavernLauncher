/**
 * windowIcon 纯函数单测：PNG 解码 / area-average 缩放 / PNG 编码 /
 * dataURL 提取 / 尺寸档位选择。
 * FFI 部分依赖 win32+Bun 真实窗口，由 scripts/verify-window-icon.ts
 * 与真实应用冒烟覆盖（E2E 环境本身即 win32+Bun）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ICON_SIZES,
  decodePngRgba,
  encodePngRgba,
  pickNearestSize,
  pngBytesFromDataUrl,
  resizeRgba,
} from '../services/windowIcon'

const LOGO_PATH = fileURLToPath(new URL('../assets/logo.png', import.meta.url))
const logoBytes = new Uint8Array(readFileSync(LOGO_PATH))

describe('decodePngRgba', () => {
  it('解码启动器 logo 为 RGBA', () => {
    const img = decodePngRgba(logoBytes)
    expect(img.width).toBe(256)
    expect(img.height).toBe(256)
    expect(img.rgba.length).toBe(256 * 256 * 4)
  })

  it('拒绝非 PNG 输入', () => {
    expect(() => decodePngRgba(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toThrow(/PNG/)
  })
})

describe('resizeRgba', () => {
  it('整数倍下采样保持尺寸与不透明像素', () => {
    const img = decodePngRgba(logoBytes)
    // 256→16 为 16 倍整数降采样，纯色不透明区域的均值应原样保留
    const out = resizeRgba(img, 16, 16)
    expect(out.length).toBe(16 * 16 * 4)
    // logo 中心（火箭主体）必有不透明像素
    const opaqueCount = Array.from({ length: 256 }, (_, i) => out[i * 4 + 3]).filter((a) => a > 200).length
    expect(opaqueCount).toBeGreaterThan(32)
  })

  it('透明区域缩放后仍为全透明（预乘平均不产生黑晕残色）', () => {
    // 构造 8×8：左半纯红不透明、右半全透明 → 缩到 4×4 后最右列应 alpha=0
    const rgba = new Uint8Array(8 * 8 * 4)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 8 + x) * 4
        rgba[i] = 255
        rgba[i + 3] = 255
      }
    }
    const out = resizeRgba({ width: 8, height: 8, rgba }, 4, 4)
    // 最左列（x=0）来自纯红不透明半区
    const leftmost = (0 * 4 + 0) * 4
    expect(out[leftmost + 3]).toBe(255)
    expect(out[leftmost]).toBe(255)
    expect(out[leftmost + 1]).toBe(0)
    expect(out[leftmost + 2]).toBe(0)
    const rightmost = (0 * 4 + 3) * 4
    expect(out[rightmost + 3]).toBe(0)
    expect(out[rightmost]).toBe(0)
    expect(out[rightmost + 1]).toBe(0)
    expect(out[rightmost + 2]).toBe(0)
  })

  it('等尺寸返回原数据副本', () => {
    const img = decodePngRgba(logoBytes)
    const out = resizeRgba(img, img.width, img.height)
    expect(Array.from(out)).toEqual(Array.from(img.rgba))
    expect(out).not.toBe(img.rgba)
  })

  it('拒绝放大与非法尺寸', () => {
    const img = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4) }
    expect(() => resizeRgba(img, 16, 16)).toThrow(/缩放/)
    expect(() => resizeRgba(img, 0, 4)).toThrow(/缩放/)
  })
})

describe('encodePngRgba', () => {
  it('编码后可被解码回同尺寸同数据（往返一致）', () => {
    const img = decodePngRgba(logoBytes)
    const small = resizeRgba(img, 32, 32)
    const encoded = encodePngRgba(small, 32, 32)
    const round = decodePngRgba(encoded)
    expect(round.width).toBe(32)
    expect(round.height).toBe(32)
    // filter 0 + 无损 deflate：字节级往返
    expect(Array.from(round.rgba)).toEqual(Array.from(small))
  })
})

describe('pngBytesFromDataUrl', () => {
  it('提取 base64 载荷并与源文件字节一致', () => {
    const dataUrl = `data:image/png;base64,${Buffer.from(logoBytes).toString('base64')}`
    const extracted = pngBytesFromDataUrl(dataUrl)
    expect(Array.from(extracted)).toEqual(Array.from(logoBytes))
  })

  it('拒绝非法输入', () => {
    expect(() => pngBytesFromDataUrl('not-a-dataurl')).toThrow(/dataURL/)
  })
})

describe('pickNearestSize', () => {
  it('覆盖系统槽位取值并等距取小档', () => {
    expect(pickNearestSize(16)).toBe(16)
    expect(pickNearestSize(32)).toBe(32)
    expect(pickNearestSize(48)).toBe(48)
    expect(pickNearestSize(256)).toBe(256)
    expect(pickNearestSize(28)).toBe(24) // 28 与 24/32 等距 → 取小
    expect(pickNearestSize(100)).toBe(64)
    expect(pickNearestSize(999)).toBe(ICON_SIZES[ICON_SIZES.length - 1])
  })
})
