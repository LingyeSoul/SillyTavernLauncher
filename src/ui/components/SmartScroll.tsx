/**
 * SmartScrollArea（内容超高才滚动的滚动区，2026-09-20）：
 * GPUIX 0.9 无 overflow:'auto'（不被解析：不滚也不裁，见 AGENTS.md）；而 overflow:'scroll'
 * 容器在内容不超高时，真实窗口里滚轮仍可把偏移推出越界（实测位移 34px 起且可把
 * 整窗内容滚没——"内容明明装得下却还能滚"的根因）。
 * 对策：挂载后经 renderer.getElementBounds 实测视口/内容高度，超高才开
 * overflow:'scroll'，否则 'hidden'（非滚动容器，滚轮天然无效）。
 * - 首帧默认 'scroll'（保持旧行为；测量失败亦不降级，安全兜底）
 * - contentKey 变化 / 窗口尺寸变化 / 500ms 看门狗 → 重测自愈（内容异步长高、
 *   版本卡加载后再翻回可滚动；React 同值 setState 不触发提交，无额外开销）
 * - 从 'scroll' 翻 'hidden' 前先 scrollTo(0,0) 清残留偏移（GPUIX 越界偏移破坏绘制的教训）
 * - 对话框内模式（maxHeight + pad 0）：模态正文盒同样"可能不超高"（loading 态/
 *   暂无日志态单行文本），裸 scroll 会引入滚轮推越界——传 maxHeight 钳视口即可
 *   复用同一实测判定。
 * 铁律不变：本组件是所在视图（或所在模态）的唯一垂直滚动容器；内层 contentRef
 * 包装 div 仅作测量锚点（flex 列 + 子元素自带 margin，不改变布局）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useWindowSize, useGpuixRequired } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'
import { layout } from '../../theme'
import { errMsg, logError } from '../../services/errorLog'
import { mainWindowQueryState } from '../../services/windowControl'

export interface SmartScrollAreaProps {
  /** 滚动区内容（flex 列排布；间距由子元素自带或外层显式 gap） */
  children: ReactNode
  /** 内容版本号：tab 切换 / 数据加载等可能改变内容高度的时机传入，触发重测 */
  contentKey?: unknown
  testId?: string
  /**
   * 视口最大高度（对话框内模式）：页面级用法靠外层 flex 定高约束视口，对话框
   * 内容区无此约束，传本值钳住视口高度，超高才滚。ErrorDialog / EulaDialog /
   * UpdateAvailableDialog 的正文滚动即此模式（短文案自动翻 'hidden'，杜绝裸
   * scroll 的滚轮推越界）。
   */
  maxHeight?: number
  /**
   * 视口内边距：默认 layout.padFormX/Y（页面级）；对话框内嵌自带 padding 的
   * 样式盒（bg/border/padding 12）时传 0 避免双重内边距。padY 参与超高判定。
   */
  padX?: number
  padY?: number
}

/** 等待绘制后实测；bounds 未就绪时轮询（首帧绘制在 commit 之后一帧） */
const MEASURE_RETRY = 12
const MEASURE_INTERVAL_MS = 16
/** 内容异步长高（版本卡加载等）的自愈重测周期 */
const WATCHDOG_INTERVAL_MS = 500
/** 滚动区内边距默认值（对话框内调用方传 0 覆盖；PAD_Y 参与超高判定） */
const DEFAULT_PAD_Y = layout.padFormY
const DEFAULT_PAD_X = layout.padFormX

export function SmartScrollArea({
  children,
  contentKey,
  testId,
  maxHeight,
  padX = DEFAULT_PAD_X,
  padY = DEFAULT_PAD_Y,
}: SmartScrollAreaProps) {
  const renderer = useGpuixRequired()
  const { width: winW, height: winH } = useWindowSize()
  const viewportRef = useRef<PublicInstance | null>(null)
  const contentRef = useRef<PublicInstance | null>(null)
  // 首帧与测量失败均保持 'scroll'（旧行为兜底）；翻 'hidden' 只在实测"装得下"后
  const [overflow, setOverflow] = useState<'scroll' | 'hidden'>('scroll')

  useEffect(() => {
    // 测量 API 缺失（旧版 renderer）：不启动定时器与看门狗，保持 'scroll' 兜底——
    // 否则看门狗每 500ms 空转重试，永无结果。注意不可把方法捕获为局部变量调用
    // （会丢失 renderer this 绑定，testing.js 的 getElementBounds 依赖它）
    if (typeof renderer.getElementBounds !== 'function') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    let warned = false
    const measure = (): void => {
      if (cancelled) return
      // 窗口隐藏（close-to-tray）/最小化时原生侧不回应 bounds 查询：实测同步
      // 阻塞整 2s 后抛 GenericFailure，500ms 看门狗会连环炸 + 冻死 JS 线程
      // （2026-09-22 回归）。冻结态布局不变，跳过本轮即可——恢复可见后下一
      // 个看门狗周期自然重测，自愈语义不变
      if (mainWindowQueryState() === 'frozen') return
      const vp = viewportRef.current
      const ct = contentRef.current
      if (!vp || !ct) return
      try {
        const vb = renderer.getElementBounds?.(vp.id) ?? null
        const cb = renderer.getElementBounds?.(ct.id) ?? null
        if (!vb || !cb) {
          // 尚未绘制：短轮询等待；超次放弃（保持 'scroll'，不阻塞 UI）
          if (++tries < MEASURE_RETRY) timer = setTimeout(measure, MEASURE_INTERVAL_MS)
          return
        }
        const fits = cb.height <= vb.height - padY * 2 + 1
        if (fits) {
          renderer.scrollTo?.(vp.id, 0, 0)
          setOverflow('hidden')
        } else {
          setOverflow('scroll')
        }
      } catch (err) {
        // 竞态兜底（门检与查询之间窗口刚被隐藏等）：放弃本轮，看门狗下轮再试；
        // 只记一次日志防刷屏（错误路径每次都阻塞 2s，不能进高频重试）
        if (!warned) {
          warned = true
          logError(`[SmartScroll] 元素测量失败（窗口冻结竞态兜底）: ${errMsg(err)}`)
        }
      }
    }
    timer = setTimeout(measure, MEASURE_INTERVAL_MS)
    const watchdog = setInterval(measure, WATCHDOG_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      clearInterval(watchdog)
    }
  }, [renderer, contentKey, winW, winH, padX, padY])

  return (
    <div
      ref={viewportRef}
      testId={testId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        maxHeight,
        overflow,
        paddingTop: padY,
        paddingBottom: padY,
        paddingLeft: padX,
        paddingRight: padX,
      }}>
      {/* 测量锚点：flexShrink 0 保住内容自然高度（默认收缩会把它压到视口高，
          超高内容被误判"装得下"）；派生 testId 暴露锚点供测试/E2E 复测同一判定 */}
      <div
        ref={contentRef}
        testId={testId ? `${testId}-content` : undefined}
        style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}
      >
        {children}
      </div>
    </div>
  )
}
