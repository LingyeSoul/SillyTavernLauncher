/**
 * 镜像源设置对话框（2026-09-21 镜像源增强）。
 *
 * 分工（与设置页「官方源 / 加速镜像」二选一配合）：
 * - 设置页只做二选一（不进具体站点名单）；
 * - 本对话框负责站点层：全量测速（延迟标注）+ 手动选定 + 自动选优开关。
 *
 * 交互语义（点击即生效，不做草稿态——与 Select 顶层切换的即时反馈一致，
 * 避免"对话框里改了但没点应用"的半提交态）：
 * - 点「官方源」行 → setMirrorMode('official')（保留已选 host，便于切回）；
 * - 点镜像行 → selectMirror(host, false)（手动指定 = 关自动选优与故障切换）；
 * - 「一键测速」→ 全量并发测速，结果落 config 并按延迟重排；
 *   自动选优开启时测速完直接选中最快站（= 自动模式的显式版）；
 * - 「自动测速选优」开关 → 只翻 github.auto；未选站且开启时立即跑一次选优。
 *
 * 测速目标为 SillyTavern 仓库的 Git 握手端点（mirrors.MIRROR_PROBE_TARGET），
 * 与真实 clone/fetch 首请求同路径——能过测的站才可能扛住 git 操作。
 *
 * ── 卡顿修复（2026-09-21，实测数据见 scripts/bench-mirror-dialog.ts）──
 * 1. **列表窗口化**：55 站全量挂载 = 509 原生元素，GPUIX 每次滚动帧要重排/重绘
 *    整个滚动子树，实测单帧 37–68ms（15–25 FPS，滚动卡顿根因）；改为 virtual-list
 *    itemCount/windowStart 协议只挂视口附近 WINDOW_ROWS 行 → 267 元素、4–5ms/帧。
 *    同款契约见 TerminalView（10k 行日志）。滚动区因此不再用 SmartScrollArea
 *    （其实测判定在"内容恒超高"场景无增益，且会全量挂载）。
 *    ⚠️ 列表子项**不自动拉伸**：行样式必须 `width:'100%'`（见 MirrorRow 注释），
 *    否则行盒按内容宽排布、宽窄参差（曾被当成"选中高亮/选项宽度异常"上报）。
 * 2. **测速期间不重排行序**：行序只由**已落盘**的测速结果决定（live 只影响该行
 *    延迟文案）——逐站重排会在光标下反复搬动整片行（实测 1431 次 insertBefore），
 *    且每次重排都是全列表重渲染。落盘后（测速结束）统一重排一次。
 * 3. **进度提交合流**：55 站逐站 setState = 55 次提交 / 21505 次原生 setStyle，
 *    测速期间主线程持续满载（入场动画与滚动全被拖垮）；按 PROGRESS_FLUSH_MS
 *    合流后提交数降到个位数，进度条仍"在动"。
 * 4. **行 memo + 稳定回调**：延迟落在一行时只重渲染该行（其余行 props 全等，
 *    React bailout → 原生侧零 setStyle）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errMsg, logError } from '../../services/errorLog'
import {
  MIRROR_SOURCES,
  OFFICIAL_MIRROR,
  createMirrorPingProbe,
  isValidMirrorHost,
  pickFastestMirror,
  speedTestMirrors,
  writeMirrorState,
} from '../../services/mirrors'
import type { MirrorProbe } from '../../services/mirrors'
import { useSettings } from '../../stores/settings'
import type { SettingsSnapshot } from '../../stores/settings'
import { uiStateActions, useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { FieldHint } from '../components/FieldHint'
import { Modal, useModalClose } from '../components/Modal'
import { SwitchRow } from '../components/Switch'
import { ICONS } from '../components/icons'

const TEXTS = {
  title: '镜像源设置',
  officialLabel: '官方源 (github.com)',
  officialDesc: '不使用加速镜像，直连 GitHub（国内网络可能较慢或不可达）',
  autoLabel: '自动测速选优',
  autoDesc: '未手动指定时自动选最快镜像；当前镜像网络出错时自动切换到备用镜像',
  speedTest: '一键测速',
  testing: '测速中',
  speedTestHint:
    '使用系统 ping 测量各镜像站延迟（ICMP 被屏蔽的站改用 TCP 443 握手计时），不发起真实下载',
  latencyUntested: '未测速',
  latencyFailed: '不可用',
  tierFast: '推荐',
  current: '当前',
  autoPicked: '自动选中',
  manual: '手动指定',
  done: '完成',
  speedTestEmpty: '测速完成：没有可用镜像，建议改用官方源',
  speedTestNoAuto: (host: string, ms: number) =>
    `测速完成：最快 ${host}（${ms} ms）；「自动测速选优」未开启，请点击该行手动选定`,
  speedTestFail: '测速失败，请检查网络后重试',
} as const

/** 列表视口高度（Modal maxHeight 560 的内容预算；56 行常态超高，定高不裁剪） */
const LIST_VIEWPORT_HEIGHT = 300
/** 视口内挂载行数：视口 ≈7.5 行 + 上下 overscan（帧成本与挂载行数线性，见文件头） */
const WINDOW_ROWS = 24
/** 推窗前缘 overscan：滚动时可见区间先落进窗口再推窗，避免边缘露白 */
const WINDOW_OVERSCAN = 6
/** 行高估计（镜像行 40px；官方源行含副文案更高，实际高度由列表自测） */
const ROW_ESTIMATED_HEIGHT = 40
/** 测速进度合流周期（10 次/秒：进度可见且提交数从 55 降到个位数） */
const PROGRESS_FLUSH_MS = 100

/**
 * 测速探针注入点（测试/探针脚本专用）：真实测速要 ping 55 个公网站点，既有网络
 * 依赖又要秒级等待——单测/E2E/性能门禁都无法稳定复现"逐站出结果"的提交风暴。
 * 注入替身后可零网络驱动完整测速链路（onResult → 进度合流 → 落盘 → 选中）。
 */
let probeOverride: MirrorProbe | null = null

export function __setMirrorDialogProbeForTests(probe: MirrorProbe | null): void {
  probeOverride = probe
}

/** 延迟配色分档（与用户实测报告的分档一致：<600 快 / <1100 中 / 其余慢） */
function latencyColor(ms: number, t: ReturnType<typeof useTheme>): string {
  if (ms < 600) return t.status.success
  if (ms < 1100) return t.status.warning
  return t.text.muted
}

export function MirrorSettingsDialog() {
  const t = useTheme()
  const settings = useSettings()
  const [testing, setTesting] = useState(false)
  const [done, setDone] = useState(0)
  const [live, setLive] = useState<Record<string, number | null>>({})
  /** 列表渲染窗口起始行（virtual-list itemCount/windowStart 协议的应用侧推窗态） */
  const [windowStart, setWindowStart] = useState(0)
  /** 未合流的测速进度（host → 延迟；null = 不可用）与已完成站数 */
  const pendingRef = useRef<Record<string, number | null>>({})
  const doneRef = useRef(0)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
    }
  }, [])

  /** 显示用延迟表：落盘结果 + 本轮实时结果（本轮覆盖落盘值） */
  const latencyOf = (host: string): number | null | undefined => {
    const liveValue = live[host]
    if (liveValue !== undefined) return liveValue
    const stored: number | undefined = settings.mirrorSpeedtest.results[host]
    if (stored !== undefined) return stored
    if (settings.mirrorSpeedtest.failed.includes(host)) return null
    return undefined
  }

  /** 落盘延迟（只认已测速结果——行序的唯一依据，见文件头"测速期间不重排行序"） */
  const storedLatencyOf = (host: string): number | null | undefined => {
    const stored: number | undefined = settings.mirrorSpeedtest.results[host]
    if (stored !== undefined) return stored
    if (settings.mirrorSpeedtest.failed.includes(host)) return null
    return undefined
  }

  /** 行序：已实测延迟升序 → 未测速（注册表顺序）→ 不可用垫底 */
  const orderedHosts = useMemo((): string[] => {
    const measured: Array<{ host: string; ms: number }> = []
    const untested: string[] = []
    const failed: string[] = []
    for (const source of MIRROR_SOURCES) {
      const latency = storedLatencyOf(source.host)
      if (latency === undefined) untested.push(source.host)
      else if (latency === null) failed.push(source.host)
      else measured.push({ host: source.host, ms: latency })
    }
    measured.sort((a, b) => a.ms - b.ms)
    return [...measured.map((item) => item.host), ...untested, ...failed]
    // settings.mirrorSpeedtest 落盘变化时才重排（live 不参与排序）
  }, [settings.mirrorSpeedtest])

  /** 行描述表：官方源行在前 + 镜像行（窗口切片与行序都由它派生） */
  const rowSpecs = useMemo(
    (): Array<{ host: string; official: boolean }> => [
      { host: OFFICIAL_MIRROR, official: true },
      ...orderedHosts.map((host) => ({ host, official: false })),
    ],
    [orderedHosts],
  )

  const maxWindowStart = Math.max(0, rowSpecs.length - WINDOW_ROWS)
  const windowStartClamped = Math.min(windowStart, maxWindowStart)
  const visibleRows = rowSpecs.slice(windowStartClamped, windowStartClamped + WINDOW_ROWS)

  /**
   * 可见区间 → 推窗（virtual-list itemCount/windowStart 协议）。
   * 缺区间信息的 payload（首次布局等）不推窗：`endIndex ?? total` 会把"无信息"
   * 当"已到尾部"，窗口跳到列表尾——打开对话框就看着最末几行（实测踩过）。
   */
  const handleVisibleRange = (e: { startIndex?: number; endIndex?: number }): void => {
    const total = rowSpecs.length
    const start = e.startIndex
    const end = e.endIndex
    if (start === undefined && end === undefined) return
    const next =
      (end ?? total) >= total
        ? Math.max(0, total - WINDOW_ROWS)
        : Math.max(0, Math.min((start ?? 0) - WINDOW_OVERSCAN, total - WINDOW_ROWS))
    setWindowStart((prev) => (prev === next ? prev : next))
  }

  /** 未合流进度 → 一次提交（setLive/setDone 在同一提交内，React 自动批处理） */
  const flushProgress = useCallback((): void => {
    flushTimerRef.current = null
    const pending = pendingRef.current
    if (Object.keys(pending).length === 0) return
    pendingRef.current = {}
    setLive((prev) => ({ ...prev, ...pending }))
    setDone(doneRef.current)
  }, [])

  const publishProgress = useCallback((host: string, latencyMs: number | null): void => {
    pendingRef.current[host] = latencyMs
    doneRef.current += 1
    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(flushProgress, PROGRESS_FLUSH_MS)
    }
  }, [flushProgress])

  /** 测速收尾：把未合流的最后几站同步落进 UI（否则计数停在中间值） */
  const flushProgressNow = useCallback((): void => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    flushProgress()
  }, [flushProgress])

  const handleSpeedTest = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    setDone(0)
    setLive({})
    pendingRef.current = {}
    doneRef.current = 0
    try {
      const outcome = await speedTestMirrors(
        MIRROR_SOURCES.map((source) => source.host),
        {
          // ping（ICMP，TCP 兜底）——不向镜像站发真实代理请求，避免浪费服务器资源
          probe: probeOverride ?? createMirrorPingProbe(),
          onResult: publishProgress,
        },
      )
      flushProgressNow()
      writeMirrorState({ speedtest: outcome })
      const fastest = pickFastestMirror(outcome.results)
      if (fastest === null) {
        uiStateActions.pushToast('warning', TEXTS.speedTestEmpty)
      } else if (settings.mirrorAuto) {
        // 自动模式：测速完直接落地最快站（toast 由 selectMirror 汇报）
        await settings.selectMirror(fastest.host, true)
      } else {
        uiStateActions.pushToast(
          'info',
          TEXTS.speedTestNoAuto(fastest.host, fastest.latencyMs),
        )
      }
    } catch (err) {
      flushProgressNow()
      logError(`[mirrorSettings] 测速失败: ${errMsg(err)}`)
      uiStateActions.pushToast('error', TEXTS.speedTestFail)
    } finally {
      setTesting(false)
      settings.reload()
    }
  }

  const handleAutoChange = (on: boolean): void => {
    settings.setMirrorAuto(on)
    if (on && settings.mirrorEnabled && !isValidMirrorHost(settings.mirrorHost)) {
      void settings.autoSelectMirrorNow()
    }
  }

  // 稳定回调：memo 行只在自身数据变化时重渲染（回调引用恒定，不破坏 memo）
  const handleSelect = useCallback((host: string): void => {
    const store = useSettings.getState()
    if (host === OFFICIAL_MIRROR) void store.setMirrorMode('official')
    else void store.selectMirror(host, false)
  }, [])

  return (
    <Modal
      open
      width={600}
      maxHeight={560}
      title={TEXTS.title}
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={<MirrorDialogActions />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <FieldHint testId="mirror-current">{currentText(settings)}</FieldHint>
        <SwitchRow
          label={TEXTS.autoLabel}
          desc={TEXTS.autoDesc}
          on={settings.mirrorAuto}
          onChange={handleAutoChange}
          testId="mirror-auto"
        />
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Button
            variant="default"
            icon="refresh"
            onClick={() => void handleSpeedTest()}
            disabled={testing}
            testId="mirror-speedtest">
            {testing ? `${TEXTS.testing} ${done}/${MIRROR_SOURCES.length}` : TEXTS.speedTest}
          </Button>
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <FieldHint>{TEXTS.speedTestHint}</FieldHint>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            borderWidth: 1,
            borderColor: t.border.subtle,
            borderRadius: t.radius.md,
            overflow: 'hidden',
          }}>
          {/* 窗口化列表：只挂 [windowStart, windowStart+WINDOW_ROWS) 的行切片，
              滚动时经 onVisibleRange 推窗（推窗状态在应用侧，见文件头说明）。
              56 行全挂实测 509 原生元素 / 68ms 单帧，窗口化后 228 元素 / 2.5ms */}
          <virtual-list
            alignment="top"
            itemCount={rowSpecs.length}
            windowStart={windowStartClamped}
            estimatedItemHeight={ROW_ESTIMATED_HEIGHT}
            onVisibleRange={handleVisibleRange}
            testId="mirror-list"
            style={{ height: LIST_VIEWPORT_HEIGHT, minHeight: 0 }}>
            {visibleRows.map((spec) => {
              if (spec.official) {
                return (
                  <MirrorRow
                    key="official"
                    host={spec.host}
                    label={TEXTS.officialLabel}
                    desc={TEXTS.officialDesc}
                    selected={!settings.mirrorEnabled}
                    latencyText="—"
                    onSelect={handleSelect}
                    testId="mirror-row-official"
                  />
                )
              }
              const host = spec.host
              const latency = latencyOf(host)
              const source = MIRROR_SOURCES.find((item) => item.host === host)
              const selected = settings.mirrorEnabled && settings.mirrorHost === host
              return (
                <MirrorRow
                  key={host}
                  host={host}
                  label={host}
                  tier={source?.tier === 'fast' ? TEXTS.tierFast : undefined}
                  badge={
                    selected
                      ? settings.mirrorAuto
                        ? TEXTS.autoPicked
                        : TEXTS.manual
                      : undefined
                  }
                  selected={selected}
                  latencyText={
                    latency === undefined
                      ? TEXTS.latencyUntested
                      : latency === null
                        ? TEXTS.latencyFailed
                        : `${latency} ms`
                  }
                  latencyColor={
                    typeof latency === 'number'
                      ? latencyColor(latency, t)
                      : latency === null
                        ? t.status.error
                        : undefined
                  }
                  onSelect={handleSelect}
                  testId={`mirror-row-${host}`}
                />
              )
            })}
          </virtual-list>
        </div>
      </div>
    </Modal>
  )
}

/** 状态行文案：避开下拉/行的完整标签（「加速镜像」/「官方源 (github.com)」）——
 *  E2E 的 getByText 是子串匹配，撞词会点到错误节点 */
function currentText(settings: SettingsSnapshot): string {
  if (!settings.mirrorEnabled) return '当前：官方源（github.com）'
  if (!isValidMirrorHost(settings.mirrorHost)) return '已开启镜像加速，但尚未选定站点'
  return `当前：${settings.mirrorHost}${settings.mirrorAuto ? '（自动选优）' : '（手动指定）'}`
}

/** 动作区（Provider 子树内取 useModalClose，走退场动画后结算关闭） */
function MirrorDialogActions() {
  const requestClose = useModalClose()
  return (
    <Button variant="primary" onClick={requestClose} testId="mirror-close">
      {TEXTS.done}
    </Button>
  )
}

interface MirrorRowProps {
  /** 行标识（点击回调回传；官方源行传 OFFICIAL_MIRROR 哨兵） */
  host: string
  label: string
  desc?: string
  tier?: string
  badge?: string
  selected: boolean
  latencyText: string
  latencyColor?: string
  /** 稳定回调（useCallback）：memo 行不因回调换引用而重渲染 */
  onSelect: (host: string) => void
  testId: string
}

/**
 * 列表行：整行可点（GPUIX 无 hover 伪类 → onMouseEnter 状态驱动底色）。
 *
 * `width:'100%'` 是 virtual-list 下的必需项（实测）：列表把子项按内容宽（shrink-to-fit）
 * 排布，不像 flex 列容器那样拉伸子项——漏掉它行盒只有内容那么宽，行底色/分隔线
 * 右缘参差（宽窄不一的"阶梯"观感，实测行宽 219–445px 而列表内容宽 558px）；
 * 实测 `width:'100%'` 按**边框盒**解析（558 = 容器内宽，padding 不外溢），
 * 而 `alignSelf:'stretch'` 对列表子项无效。
 *
 * memo：窗口内 24 行在测速期间只有被测站那一行的文案变化 → 只有它重渲染，
 * 原生侧只重发该行元素的样式（全量重渲染时是整列表 390 次 setStyle/提交）。
 */
const MirrorRow = memo(function MirrorRow({
  host,
  label,
  desc,
  tier,
  badge,
  selected,
  latencyText,
  latencyColor,
  onSelect,
  testId,
}: MirrorRowProps) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  return (
    <div
      testId={testId}
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={() => onSelect(host)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        minHeight: 40,
        paddingLeft: 10,
        paddingRight: 10,
        borderBottomWidth: 1,
        borderColor: t.border.subtle,
        backgroundColor: hover && !selected ? t.bg.hover : 'transparent',
        cursor: 'pointer',
        userSelect: 'none',
      }}>
      <svg
        source={ICONS.check}
        style={{ width: 12, height: 12, color: selected ? t.ember : 'transparent' }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
        <text
          style={{
            fontSize: t.fs.field,
            color: selected ? t.ember : t.text.primary,
            fontFamily: t.font.mono,
          }}>
          {label}
        </text>
        {desc !== undefined && (
          <text style={{ fontSize: t.fs.caption, color: t.text.muted, fontFamily: t.font.sans }}>
            {desc}
          </text>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {tier !== undefined && <Chip accent>{tier}</Chip>}
        {badge !== undefined && <Chip color={t.ember}>{badge}</Chip>}
        <text
          style={{
            fontSize: t.fs.caption,
            fontFamily: t.font.mono,
            color: latencyColor ?? t.text.secondary,
            minWidth: 64,
          }}>
          {latencyText}
        </text>
      </div>
    </div>
  )
})

/** 供测试/调用方复用：当前快照里的镜像状态摘要（避免测试硬编码文案） */
export function mirrorSummaryText(snapshot: SettingsSnapshot): string {
  if (!snapshot.mirrorEnabled) return 'official'
  return snapshot.mirrorHost.length > 0 ? snapshot.mirrorHost : 'unselected'
}
