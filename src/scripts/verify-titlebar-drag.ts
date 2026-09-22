/**
 * 校验脚本：自绘标题栏的真实窗口取证（win32 + Bun 下运行，其他环境直接退出）。
 *
 *   bun scripts/verify-titlebar-drag.ts
 *
 * 它启一个真实启动器进程（临时 cwd，种子 config 跳过首启弹窗），然后：
 *   ① 铬层隐藏证据：GetWindowRect vs GetClientRect 相等 ⇒ 原生标题栏已被
 *      titlebarTransparent 隐藏（客户区覆盖整窗），不相等则说明系统标题栏仍在，
 *      自绘标题栏会与原生标题栏叠成双层铬层；
 *   ② 拖动证据：SetCursorPos + SendInput 左键真按下 → 分步移动光标 → 抬起，
 *      窗口矩形必须跟着位移（按抓取偏移换算的期望值比对）；同时验证"只按不移
 *      不搬窗口"（防止轻点就漂移）；
 *   ③ 最小化证据：点击最小化按钮落点 → IsIconic(hwnd) 置位；
 *   ④ 关闭证据：点击关闭按钮落点 → 进程在数秒内退出（WM_CLOSE 走 gpui 原生
 *      拆除路径，与系统 X 同链路）。
 *
 * 为什么不用 E2E（@gpuix/react/automation）：它的鼠标事件注入的是窗口内事件，
 * 不制造真实光标位移——而拖动实现读的是 GetCursorPos 的屏幕坐标，注入事件下
 * 光标原地不动，窗口必然"拖不动"，测不出真伪。真实输入台架（SendInput +
 * SetCursorPos）才能复现用户操作，这也是 gpuix skill pitfalls-production.md
 * 给这类问题定的取证口径。
 *
 * 与 services/windowControl 里的拖动实现共用同一套坐标语义：
 *   抓取偏移 = 光标 − 窗口左上角；拖动帧窗口 = 光标 − 抓取偏移
 * 这里的期望位移因此是"光标位移量本身"（拖动前后光标位移 = 窗口位移）。
 * 台架（spawn/输入/断言收集）来自 scripts/_verifyLib.ts。
 */
import { layout } from '../theme'
import {
  HWND_TOP,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  SW_RESTORE,
  SWP_NOACTIVATE,
  SWP_NOSIZE,
  bringUp,
  check,
  clickAt,
  disposeApp,
  readClientRect,
  readClientOrigin,
  readWindowRect,
  reportScriptError,
  sendMouse,
  sleep,
  startApp,
  user32,
  verifyFailureCount,
  type Rect,
  type RunningApp,
} from './_verifyLib'

// —— 常量（几何取 theme.layout 单一出处；拖动参数为本脚本专属）——
const WINDOW_W = layout.windowW
const WINDOW_H = layout.windowH + layout.titlebarH // 内容区 + 自绘标题栏
const TITLEBAR_MID_Y = 18 // 标题栏内拖动落点（栏体 35px 的中部）
const DRAG_START_X = 300 // 拖动落点：品牌区右侧、按钮组左侧的拖动区
const BTN_W = layout.titlebarBtnW
const DRAG_STEPS = 8
const DRAG_STEP_X = 8
const DRAG_STEP_Y = 4
const RECT_TOLERANCE = 6 // 每步 SetCursorPos → SetWindowPos 有一帧延迟，允许偏差

/**
 * 真实拖动一小段并报告两件事：窗口是否被搬动、是否被最小化（按钮点击在抬起时结算）。
 * 最小化态下 GetWindowRect 返回 -32000 级别的"图标位"矩形，不能当位移判据——
 * 故 minimized 时直接不判位移。
 */
interface DragProbeResult {
  moved: [number, number] | null
  minimized: boolean
}

async function dragFromPoint(hwnd: bigint, x: number, y: number, dx: number, dy: number): Promise<DragProbeResult> {
  const before = readWindowRect(hwnd)
  user32.SetCursorPos(x, y)
  await sleep(80)
  sendMouse(MOUSEEVENTF_LEFTDOWN)
  await sleep(80)
  for (let i = 1; i <= 6; i++) {
    user32.SetCursorPos(x + (dx / 6) * i, y + (dy / 6) * i)
    await sleep(60)
  }
  sendMouse(MOUSEEVENTF_LEFTUP)
  await sleep(250)
  const minimized = user32.IsIconic(hwnd) !== 0
  const after = readWindowRect(hwnd)
  const moved: [number, number] | null =
    minimized || (after.left === before.left && after.top === before.top) ? null : [after.left - before.left, after.top - before.top]
  return { moved, minimized }
}

/**
 * 真实拖动搬窗（标题栏拖动区那一套注入动作）；返回实测位移。
 * 零位移时重试至多 3 次：UI 线程忙（首帧布局/GC）会把整段输入压在队列里，
 * 表现为"拖不动"的假阴性——只对**完全没动**重试，部分位移按实测值判定，不放水。
 */
async function dragWindow(hwnd: bigint, x: number, y: number): Promise<[number, number]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = readWindowRect(hwnd)
    user32.SetCursorPos(x, y)
    await sleep(150)
    sendMouse(MOUSEEVENTF_LEFTDOWN)
    await sleep(120)
    for (let i = 1; i <= DRAG_STEPS; i++) {
      user32.SetCursorPos(x + i * DRAG_STEP_X, y + i * DRAG_STEP_Y)
      await sleep(90)
    }
    sendMouse(MOUSEEVENTF_LEFTUP)
    await sleep(300)
    const after = readWindowRect(hwnd)
    const moved: [number, number] = [after.left - before.left, after.top - before.top]
    if (moved[0] !== 0 || moved[1] !== 0) return moved
    if (attempt < 3) {
      console.log(`  第 ${attempt} 次拖动零位移（UI 未就绪？），重试`)
      await sleep(500)
    }
  }
  return [0, 0]
}

let running: RunningApp | null = null

try {
  // =====================================================================
  // 阶段一：铬层隐藏 + 拖动 + 最小化
  // =====================================================================
  console.log('— 阶段一：启动被测应用（真实窗口，非后台）—')
  running = await startApp({ dirPrefix: 'stl-titlebar-verify' })
  const hwnd = await bringUp(running.pid, 1500)

  // ① 铬层隐藏：客户区尺寸 = 请求的内容尺寸，且客户区**贴窗口上沿**（无标题栏带宽）。
  //    实测数据（titlebarTransparent: true）：窗口 816×688 / 客户区 800×680，
  //    偏移 left:8 top:0 right:8 bottom:8——左右下各 8px 是 DWM 隐形缩放边框/阴影，
  //    top=0 才是"没有系统标题栏"的硬证据（有标题栏时 top ≈ 31px）。
  const winRect = readWindowRect(hwnd)
  const clientRect = readClientRect(hwnd)
  const clientOrigin = readClientOrigin(hwnd)
  const winW = winRect.right - winRect.left
  const winH = winRect.bottom - winRect.top
  const cliW = clientRect.right - clientRect.left
  const cliH = clientRect.bottom - clientRect.top
  const frameLeft = clientOrigin.x - winRect.left
  const frameTop = clientOrigin.y - winRect.top
  console.log(
    `  窗口 ${winW}×${winH} @ (${winRect.left},${winRect.top})｜客户区 ${cliW}×${cliH}｜客户区原点偏移 (${frameLeft},${frameTop})`,
  )
  check(
    '原生标题栏已隐藏（客户区贴窗口上沿）',
    frameTop === 0,
    `客户区上沿偏移 ${frameTop}px（>0 = 系统标题栏仍占位，会出现双层标题栏）`,
  )
  check(
    '客户区尺寸 = 800×(644+36)',
    cliW === WINDOW_W && cliH === WINDOW_H,
    `${cliW}×${cliH}（期望 ${WINDOW_W}×${WINDOW_H}）`,
  )
  check(
    '窗口外框仅为 DWM 隐形边（无标题栏带宽）',
    winH - cliH <= 16 && winW - cliW <= 32,
    `外框 - 客户区 = ${winW - cliW}×${winH - cliH}`,
  )

  // 置顶 + 前台已由 bringUp 完成 —— 注入的真实点击必须落在被测窗口上
  const startRect: Rect = readWindowRect(hwnd)
  const startOrigin = readClientOrigin(hwnd)
  // 拖动落点：客户区内 300px（品牌区右侧、按钮组左侧）
  const dragX = startOrigin.x + DRAG_START_X
  const dragY = startOrigin.y + TITLEBAR_MID_Y

  // ②a 只按不移：不得搬窗口（防轻点即漂移）
  await clickAt(dragX, dragY)
  const afterClick = readWindowRect(hwnd)
  check(
    '轻点标题栏不移动窗口',
    Math.abs(afterClick.left - startRect.left) <= 1 && Math.abs(afterClick.top - startRect.top) <= 1,
    `点击前 (${startRect.left},${startRect.top}) → 点击后 (${afterClick.left},${afterClick.top})`,
  )

  // ②b 真实拖动：光标分步移动，窗口应同步位移
  const dragFrom = readWindowRect(hwnd)
  const [actualDx, actualDy] = await dragWindow(hwnd, dragX, dragY)
  const dragTo = readWindowRect(hwnd)
  const expectedDx = DRAG_STEPS * DRAG_STEP_X
  const expectedDy = DRAG_STEPS * DRAG_STEP_Y
  check(
    '真实拖动搬动窗口',
    Math.abs(actualDx - expectedDx) <= RECT_TOLERANCE && Math.abs(actualDy - expectedDy) <= RECT_TOLERANCE,
    `期望位移 (+${expectedDx},+${expectedDy})，实测 (+${actualDx},+${actualDy})`,
  )
  check(
    '拖动不改窗口尺寸',
    dragTo.right - dragTo.left === dragFrom.right - dragFrom.left &&
      dragTo.bottom - dragTo.top === dragFrom.bottom - dragFrom.top,
    `${dragTo.right - dragTo.left}×${dragTo.bottom - dragTo.top}`,
  )

  // ②c 窗口按钮落点不是拖动区（结构回归：监听器若挂到栏体/按钮祖先上，这里会被搬动，
  //     且按钮点击必然失效——见 ui/shell/TitleBar.tsx 命中模型①）。
  //     位移必须留在按钮盒子内：GPUIX 的 click 在**抬起时**由光标所在元素结算
  //     （vendored renderer 把 click 接在 on_mouse_up 上），释放点落到相邻按钮上
  //     会触发那个按钮——拖到关闭按钮上会把应用关了（实测：脚本曾把释放点落在
  //     关闭按钮，窗口当场消失）。
  const afterDrag = readWindowRect(hwnd)
  const afterDragOrigin = readClientOrigin(hwnd)
  const minPoint = { x: afterDragOrigin.x + WINDOW_W - BTN_W * 1.5, y: afterDragOrigin.y + TITLEBAR_MID_Y }
  const buttonProbe = await dragFromPoint(hwnd, minPoint.x, minPoint.y, 12, 6)
  check(
    '最小化按钮落点按下拖动不搬窗口',
    buttonProbe.moved === null,
    buttonProbe.moved === null
      ? '窗口纹丝不动（按钮不在拖动区内）'
      : `窗口被搬动 ${JSON.stringify(buttonProbe.moved)}（按钮落在拖动区内）`,
  )
  if (buttonProbe.moved !== null) {
    user32.SetWindowPos(hwnd, HWND_TOP, afterDrag.left, afterDrag.top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)
    await sleep(200)
  }

  // ③ 最小化按钮生效：上面那次"在按钮内按下-抬起"本身就是一次点击
  let iconic = 0
  for (let i = 0; i < 20 && iconic === 0; i++) {
    await sleep(150)
    iconic = user32.IsIconic(hwnd)
  }
  console.log(`  （点击落点 (${minPoint.x},${minPoint.y})）`)
  check('最小化按钮生效', iconic !== 0, `IsIconic=${iconic}`)
  user32.ShowWindow(hwnd, SW_RESTORE)
  await sleep(600)

  // =====================================================================
  // 阶段二：关闭按钮（进程退出是本阶段唯一判据，故放最后）
  // =====================================================================
  const closeOrigin = readClientOrigin(hwnd)
  const closeX = closeOrigin.x + WINDOW_W - BTN_W / 2
  const closeY = closeOrigin.y + TITLEBAR_MID_Y
  await clickAt(closeX, closeY)
  let exited = false
  for (let i = 0; i < 40 && !exited; i++) {
    await sleep(250)
    exited = running.proc.exitCode !== null || running.proc.signalCode !== null
  }
  check('关闭按钮退出进程', exited, `点击落点 (${closeX},${closeY}) → exitCode=${running.proc.exitCode}`)

  // =====================================================================
  // 阶段三：模态打开时标题栏必须被遮罩挡住（另一种"标题栏失效"风险：对话框弹出
  // 期间还能拖窗/关窗 = 遮罩没盖住铬层）
  // =====================================================================
  await disposeApp(running)
  running = null
  console.log('\n— 阶段三：模态（EULA）打开时标题栏连通性（种子未同意协议）—')
  // seedEula=true 时不写"已同意"种子：应用启动即弹 EULA 模态（用于验证遮罩
  // 确实盖住标题栏——模态打开时拖动/按钮必须无效）
  running = await startApp({ dirPrefix: 'stl-titlebar-verify', seed: { agreement_accepted: false } })
  const eulaHwnd = await bringUp(running.pid, 2500)
  const eulaOrigin = readClientOrigin(eulaHwnd)
  const eulaDrag = await dragFromPoint(eulaHwnd, eulaOrigin.x + DRAG_START_X, eulaOrigin.y + TITLEBAR_MID_Y, 60, 0)
  check(
    '模态打开时拖动标题栏无效（遮罩覆盖铬层）',
    eulaDrag.moved === null && !eulaDrag.minimized,
    `moved=${JSON.stringify(eulaDrag.moved)} minimized=${eulaDrag.minimized}`,
  )
  const eulaClose = { x: eulaOrigin.x + WINDOW_W - BTN_W / 2, y: eulaOrigin.y + TITLEBAR_MID_Y }
  await clickAt(eulaClose.x, eulaClose.y)
  await sleep(800)
  const aliveAfterClick = running.proc.exitCode === null && running.proc.signalCode === null
  check('模态打开时点击关闭按钮不退出（遮罩拦截）', aliveAfterClick, `进程存活=${aliveAfterClick}`)
} catch (err) {
  reportScriptError(err)
} finally {
  const leftover: RunningApp | null = running
  if (leftover) await disposeApp(leftover)
}

const failures = verifyFailureCount()
console.log(failures === 0 ? '\n全部校验通过' : `\n${failures} 项校验失败`)
process.exit(failures === 0 ? 0 : 1)
