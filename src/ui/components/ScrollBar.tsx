/**
 * ScrollBar（virtual-list 自绘滚动条，2026-09-29）：
 * GPUIX 0.9 无原生滚动条（@gpuix 全包零 "scrollbar" 命中；Select 的
 * ScrollUp/DownButton 也只是 scrollTo 自绘按钮），virtual-list 只暴露滚动锚点
 * 协议：onVisibleRange(startIndex/endIndex) 事件 + scrollToItem(逻辑行号)。
 * 本组件组合成"事件驱动指示 + 拖拽行进"：
 * - 几何：thumb 高 = 轨道高 × 可视行数/总行数（下限 24px），位置 = 首可见行
 *   占最大可滚行数的比例 × 剩余行程——全部纯函数（导出供测试）。本组件热路径
 *   零 renderer 查询；但 thumb 锚点（startRow prop）**宿主侧不得只依赖
 *   onVisibleRange 事件**——live 渲染器对程序化 scrollToItem 不发该事件
 *   （2026-09-30 真窗探针实证，offscreen 台架却即时连发），宿主必须在滚动
 *   指令后经 getListScrollTop 读回原生锚点自驱动（范式见 TerminalView
 *   applyVisibleAnchor / readNativeAnchor）；
 * - 拖拽：轨道是唯一监听宿主（祖先监听吞子元素 click 的教训反向利用：thumb
 *   纯视觉 pointerEvents:'none'，根本不需要自己的处理器）；按下点在 thumb
 *   外时先跳转到点击处居中再进入拖拽（现代滚动条语义）；释放发生在轨道外
 *   收不到 mouseUp，由后续 mouseMove 的 pressedButton≠0 自愈终止拖拽；
 * - 命中区设计（2026-09-30 拖拽误选修复，同日按用户决策改隐藏式）：GPUIX
 *   原生文本选择只由**按下点**决定（真窗探针 P0–P6 实证：选择锚点在
 *   mouseDown 即武装，thumb 命中区按下无跳转 + 拖动扫过可选文本 = 成选区；
 *   脱靶按下直击文本行同样扫选）。日志文本可选中是复制特性不能禁 → 防误选
 *   分两层：① 拖拽会话逐 move clearSelection（clearSelectionDuringDrag，
 *   本组件内）；② 命中区加宽 16px（原 12px）。DEVIATION: 曾按"轨道常显
 *   极淡底色 + hover 加深"做可见化，用户嫌丑改为**隐藏式**（轨道透明透出
 *   宿主背景、thumb 常显 + hover 变色为唯一反馈）——脱靶防护由此收窄到
 *   16px 宽度一层，美观优先系用户拍板；
 * - thumb 色值（DEVIATION 登记，审计 A 组）：dragging=ember / hover=text.muted /
 *   常态=text.disabled，非 Forge 配方的 border.default/strong——隐藏式轨道透明
 *   透出宿主背景，border token 在其上几乎不可见（隐藏式拍板时一并确认）；thumb
 *   语义 = 弱化的控制件，与文本禁用/次要色同级；
 * - 滚轮转发：轨道必须 pointerEvents:'auto' 才收得到 mouseDown，代价是吃掉
 *   滚轮（GPUIX 滚轮只达命中元素、不冒泡，virtual-list 是兄弟节点收不到）
 *   → onScroll 把 delta 换算成行数经 onScrollToRow 转发回列表：
 *   precise=像素（÷行高），否则按 Windows 棘轮 120/档 × 3 行/档换算；
 * - 轨道高：经 getElementBounds 实测自愈（冻结门检 + try/catch，见
 *   AGENTS.md SmartScroll 条目），初值由宿主按布局常量推导传入。
 */
import { useEffect, useRef, useState } from 'react'
import { useGpuixRequired, useWindowSize } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'
import type { EventPayload } from '@gpuix/native'
import { useTheme } from '../theme'
import { errMsg, logError } from '../../services/errorLog'
import { mainWindowQueryState } from '../../services/windowControl'

/** 轨道宽（日志卡右缘常驻预留列；virtual-list 兄弟节点）。命中区即轨道盒——
 *  加宽到 16（原 12）是为压低"瞄准 thumb 脱靶落在文本行上触发原生扫选"的
 *  暴露面（2026-09-30 误选修复，见文件头"命中区可见化"）；行宽口径（容器
 *  内宽 − 本常量）随之自动传播，勿在宿主侧再散写 */
export const SCROLLBAR_TRACK_W = 16
/** thumb 视觉宽（命中区为整条轨道，thumb 纯视觉；6px 居中于 16px 轨道，
 *  提高瞄准观感） */
export const SCROLLBAR_THUMB_W = 6
/** thumb 最小高：行数极大时避免缩成不可抓取的细线 */
export const SCROLLBAR_MIN_THUMB_H = 24

/** 测量轮询（bounds 首帧未绘制时等待）：次数 × 周期 ≈ 200ms */
const MEASURE_RETRY = 12
const MEASURE_INTERVAL_MS = 16

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 滚动条几何：thumb 高与剩余行程（travel = thumb 顶点可移动范围） */
export interface ScrollBarGeometry {
  thumbH: number
  travel: number
}

/** thumb 尺寸：可视占比 × 轨道高，钳 [MIN, trackH]；行数不足一行可视按满轨处理 */
export function thumbGeometry(trackH: number, itemCount: number, visibleRows: number): ScrollBarGeometry {
  if (trackH <= 0 || itemCount <= 0 || visibleRows <= 0) return { thumbH: trackH, travel: 0 }
  const thumbH = clamp((trackH * visibleRows) / itemCount, SCROLLBAR_MIN_THUMB_H, trackH)
  return { thumbH, travel: trackH - thumbH }
}

/** 首可见行 → thumb 顶点像素。无可滚余量（装得下）时贴底（尾部跟随形态） */
export function thumbTopFor(startRow: number, itemCount: number, visibleRows: number, geo: ScrollBarGeometry): number {
  const maxRow = Math.max(0, itemCount - visibleRows)
  if (maxRow <= 0 || geo.travel <= 0) return geo.travel
  const ratio = clamp(startRow / maxRow, 0, 1)
  return ratio * geo.travel
}

/** thumb 顶点像素 → 目标首行（thumbTopFor 的逆映射，拖拽/轨道点击共用） */
export function rowForThumbTop(thumbTop: number, itemCount: number, visibleRows: number, geo: ScrollBarGeometry): number {
  const maxRow = Math.max(0, itemCount - visibleRows)
  if (geo.travel <= 0 || maxRow <= 0) return 0
  const ratio = clamp(thumbTop / geo.travel, 0, 1)
  return Math.round(ratio * maxRow)
}

/**
 * 滚轮 delta → 行数（正值 = 向下/向尾部）。deltaY 语义见 EventPayload：
 * precise=true 为像素（触控板，÷行高），否则为 Windows 棘轮单位
 * （120/档，系统默认 3 行/档）。±30 行钳幅防单事件暴冲。
 */
export function wheelToRows(deltaY: number, precise: boolean | undefined, rowHeight: number): number {
  if (deltaY === 0) return 0
  const h = rowHeight > 0 ? rowHeight : 22
  const rows = precise ? -deltaY / h : -(deltaY / 120) * 3
  if (rows === 0) return deltaY > 0 ? -1 : 1
  return clamp(Math.round(rows), -30, 30)
}

export interface ScrollBarProps {
  /** 逻辑总行数（virtual-list itemCount） */
  itemCount: number
  /** 当前可视行数（onVisibleRange end−start；估算兜底由宿主传入） */
  visibleRows: number
  /** 当前首可见行（vr 事件区间或宿主 getListScrollTop 读回，见文件头锚点注释） */
  startRow: number
  /** 估算行高（滚轮像素→行换算） */
  rowHeight: number
  /** 行数超出可视行数才渲染 thumb / 启用交互；轨道本身常驻（宽度稳定，防折行列数抖动） */
  overflow: boolean
  /** 拖拽 / 轨道点击 / 滚轮转发的统一出口（宿主实现为 scrollToItem） */
  onScrollToRow: (row: number) => void
  /** 轨道高的布局推导初值（实测 bounds 落地前使用） */
  estimatedTrackH: number
  testId?: string
}

/** virtual-list 配套自绘滚动条（指示 + 拖拽 + 滚轮转发） */
export function ScrollBar({
  itemCount,
  visibleRows,
  startRow,
  rowHeight,
  overflow,
  onScrollToRow,
  estimatedTrackH,
  testId,
}: ScrollBarProps) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const { width: winW, height: winH } = useWindowSize()
  const trackRef = useRef<PublicInstance | null>(null)
  const [trackH, setTrackH] = useState(estimatedTrackH)
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  /** 拖拽会话：grabOffset = 按下点在 thumb 内的偏移；boundsY = 按下时轨道 y（缓存，拖拽中不重复查询） */
  const dragRef = useRef<{ grabOffset: number; boundsY: number } | null>(null)

  // 轨道高实测自愈：初值是布局推导，实测修正（窗口隐藏冻结门检跳过本轮；
  // 无看门狗——轨道高只随窗口尺寸变，winW/winH 变化即重触发）
  useEffect(() => {
    if (typeof renderer.getElementBounds !== 'function') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    const measure = (): void => {
      if (cancelled) return
      if (mainWindowQueryState() === 'frozen') return
      const el = trackRef.current
      if (!el) return
      try {
        const b = renderer.getElementBounds?.(el.id) ?? null
        if (b && b.height > 0) {
          setTrackH(b.height)
          return
        }
        if (++tries < MEASURE_RETRY) timer = setTimeout(measure, MEASURE_INTERVAL_MS)
      } catch (err) {
        // 冻结竞态兜底：放弃本轮（同 SmartScroll，错误路径不进高频重试）
        logError(`[ScrollBar] 轨道测量失败: ${errMsg(err)}`)
      }
    }
    timer = setTimeout(measure, MEASURE_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [renderer, winW, winH, overflow])

  const geo = thumbGeometry(trackH, itemCount, visibleRows)
  const thumbTop = thumbTopFor(startRow, itemCount, visibleRows, geo)

  /** 拖拽会话清选区（2026-09-30 误选修复核心）：原生选择锚点在 mouseDown 即
   *  武装——按下点在轨道上也一样（真窗探针 P5 实证：thumb 区按下无跳转 +
   *  拖动扫过可选文本 = 成选区；scrollToItem 跳转路径会意外抑制它，探针 P6）。
   *  GPUIX 无"按下手势声明/抢占"API，唯一正牌出口 = 每次拖拽 move 清一次选区
   *  （拖拽中本就逐帧重绘，clearSelection 附带的 repaint 请求零额外成本） */
  const clearSelectionDuringDrag = (): void => {
    try {
      // 门面类型上为可选方法（同 getElementBounds?. 范式；缺席 = 该渲染器无选择实现）
      renderer.clearSelection?.()
    } catch (err) {
      logError(`[ScrollBar] 拖拽清选区失败: ${errMsg(err)}`)
    }
  }

  const endDrag = (): void => {
    if (dragRef.current) dragRef.current = null
    setDragging(false)
    // 释后终态兜底（末次 move 与 up 之间原生侧不再新增选区，双保险）
    clearSelectionDuringDrag()
  }

  const handleMouseDown = (e: EventPayload): void => {
    if (e.button !== 0 || geo.travel <= 0) return
    // renderer 查询冻结门检（AGENTS.md：隐藏/最小化时原生侧不回应，同步阻塞 2s）
    if (mainWindowQueryState() === 'frozen') return
    const el = trackRef.current
    if (!el) return
    let boundsY = 0
    let trackHeight = 0
    try {
      const b = renderer.getElementBounds?.(el.id) ?? null
      if (b && b.height > 0) {
        boundsY = b.y
        trackHeight = b.height
      }
    } catch {
      // 查询失败（竞态）：无几何即无法换算，忽略本次按下
    }
    if (trackHeight <= 0) return
    const yLocal = (e.y ?? 0) - boundsY
    const onThumb = yLocal >= thumbTop && yLocal <= thumbTop + geo.thumbH
    if (onThumb) {
      dragRef.current = { grabOffset: yLocal - thumbTop, boundsY }
    } else {
      // 轨道点击：跳转到点击处（thumb 居中于按点），随即进入拖拽
      dragRef.current = { grabOffset: geo.thumbH / 2, boundsY }
      onScrollToRow(rowForThumbTop(yLocal - geo.thumbH / 2, itemCount, visibleRows, geo))
    }
    setDragging(true)
  }

  const handleMouseMove = (e: EventPayload): void => {
    const drag = dragRef.current
    if (!drag) return
    // 自愈：拖拽中收到非左键按住的 move = 释放发生在轨道外（mouseUp 收不到）
    if (e.pressedButton !== undefined && e.pressedButton !== 0) {
      endDrag()
      return
    }
    const yLocal = (e.y ?? 0) - drag.boundsY
    onScrollToRow(rowForThumbTop(yLocal - drag.grabOffset, itemCount, visibleRows, geo))
    // 扫过可选文本不得成选区（按下即武装的原生锚点，见 clearSelectionDuringDrag）
    clearSelectionDuringDrag()
  }

  /** 滚轮转发：轨道 pointerEvents:'auto' 吃掉的滚轮，换算行数还给列表 */
  const handleWheel = (e: EventPayload): void => {
    if (!overflow || e.deltaY === undefined) return
    const rows = wheelToRows(e.deltaY, e.precise, rowHeight)
    if (rows === 0) return
    onScrollToRow(clamp(startRow + rows, 0, Math.max(0, itemCount - 1)))
  }

  return (
    <div
      ref={trackRef}
      testId={testId}
      onMouseDown={handleMouseDown}
      onMouseUp={endDrag}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onScroll={handleWheel}
      style={{
        width: SCROLLBAR_TRACK_W,
        flexShrink: 0,
        position: 'relative',
        // 'auto' 才能收 mouseDown；代价是吃滚轮（由 onScroll 转发补回）。
        // 无溢出时整条轨道对命中透明——此时列表自身也无内容可滚，语义一致
        pointerEvents: overflow ? 'auto' : 'none',
      }}>
      {overflow && (
        <div
          testId={testId ? `${testId}-thumb` : undefined}
          style={{
            position: 'absolute',
            left: (SCROLLBAR_TRACK_W - SCROLLBAR_THUMB_W) / 2,
            top: thumbTop,
            width: SCROLLBAR_THUMB_W,
            height: geo.thumbH,
            borderRadius: 2,
            backgroundColor: dragging ? t.ember : hovered ? t.text.muted : t.text.disabled,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  )
}
