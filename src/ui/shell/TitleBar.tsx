/**
 * TitleBar（自绘标题栏，2026-09-22）：36px 窗口铬层，承接原生标题栏被
 * `titlebarTransparent: true` 隐藏后的全部职责——拖动、最小化、关闭、品牌。
 *
 * 结构（← docs/plans/2026-09-19-gpuix-ui-design.md §3.A 修订 + §1.C O12）：
 *   栏体 35px + 底 1px 分隔线（StyleDesc 无分边框色，用 1px div）= layout.titlebarH
 *   左：品牌区（logo 18 + 应用名；在拖动区内部，承接侧栏移除的品牌位）
 *   中：拖动区（弹性，含品牌区；三监听器所在，见"命中模型"）
 *   右：最小化 / 关闭（各 46px 宽，Windows 惯例；拖动区的兄弟）
 *
 * 命中模型（GPUIX 实测纪律，两条都是踩坑换来的）：
 * ① 祖先的 mouseDown/Move/Up 监听器会**捕获**手势——按在子元素上时，子元素的
 *    onClick 永远不触发（真实鼠标与 harness 合成点击都收不到）。所以拖动三监听器
 *    挂中段拖动区，两个按钮是它的**兄弟**，不是后代。
 * ② 拖动区内的填充子元素（品牌区）要 `pointerEvents: 'none'`，否则命中被它吃掉、
 *    在 logo/文字上按下拖不动窗口（命中测试解析到最深可命中盒子）。
 *
 * 最小化按钮 = 投递 WM_SYSCOMMAND/SC_MINIMIZE（services/windowControl）；关闭按钮的
 * 语义由调用方经 `onCloseRequest` 注入（AppShell.requestClose：ST 运行中先确认再
 * 停止退出，未运行走 closeWindow 的 WM_CLOSE 原生链路）——本组件保持哑展示，不读
 * store，退出保护语义只此一处。非 win32/Bun 下窗口原语整体空操作。
 * 窗口 resizable:false（D4）故不设最大化——见 windowControl 模块头。
 */
import { useGpuix } from '@gpuix/react'
import type { IconName } from '../components/icons'
import { ICONS } from '../components/icons'
import { useTheme } from '../theme'
import { layout } from '../../theme'
import { LOGO_DATA_URL } from '../assets/logo'
import { beginWindowMove, continueWindowMove, endWindowMove, minimizeWindow } from '../../services/windowControl'

const BTN_W = 46
const BTN_ICON = 14

export function TitleBar({ onCloseRequest }: { onCloseRequest: () => void }) {
  const t = useTheme()
  const { renderer } = useGpuix()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, userSelect: 'none' }}>
      {/* 栏体本身不挂任何鼠标监听器：拖动监听器必须挂在**中段拖动区**上，
          按钮做拖动区的兄弟（见下） */}
      <div
        testId="titlebar"
        style={{
          height: layout.titlebarH - 1,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: t.bg.deep,
        }}>
        {/* 拖动区：三个监听器同节点（gpui 自动指针捕获，拖出窗口仍跟手）。
            DEVIATION/踩坑实录：监听器若挂在整条栏体（按钮的祖先）上，按压事件被
            祖先捕获，子按钮的 click 永远收不到（实测：真实鼠标点击与 harness 合成
            点击都无法触发最小化/关闭；createTestRoot 最小复现 —— 祖先 mousedown+up
            吞掉子 onClick）。按钮必须是拖动区的兄弟，不能是后代。 */}
        <div
          testId="titlebar-drag"
          onMouseDown={(e) => {
            // 仅左键武装拖动；未武装（非 win32 / 句柄未定位）时退化为激活窗口
            if (e.button === 0 && !beginWindowMove()) renderer?.activateWindow?.()
          }}
          onMouseMove={() => continueWindowMove()}
          onMouseUp={() => endWindowMove()}
          style={{
            flexGrow: 1,
            minWidth: 0,
            height: '100%',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
          }}>
          {/* 品牌区：pointerEvents none → 命中穿透到拖动区，在 logo/文字上按下也能拖窗 */}
          <div
            testId="titlebar-brand"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingLeft: 12,
              pointerEvents: 'none',
            }}>
            <img src={LOGO_DATA_URL} style={{ width: 18, height: 18 }} />
            <text style={{ fontSize: t.fs.caption, color: t.text.secondary, fontFamily: t.font.sans }}>
              {'SillyTavernLauncher'}
            </text>
          </div>
        </div>
        <TitleBarButton icon="minus" label="最小化" onClick={minimizeWindow} testId="titlebar-minimize" />
        <TitleBarButton icon="x" label="关闭启动器" onClick={onCloseRequest} testId="titlebar-close" />
      </div>
      {/* 底部分隔线：与侧栏右线同款 1px border-subtle */}
      <div style={{ height: 1, backgroundColor: t.border.subtle }} />
    </div>
  )
}

/**
 * 窗口按钮：46×35 悬停底（Windows 惯例的宽扁形），中性 hover——Forge 调色板
 * 无实心红 token，不为关闭键造一个；语义由 aria-label 承担。
 */
function TitleBarButton({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: IconName
  label: string
  onClick: () => void
  testId: string
}) {
  const t = useTheme()
  return (
    <div
      onClick={onClick}
      role="button"
      aria-label={label}
      testId={testId}
      style={{
        width: BTN_W,
        height: '100%',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        hover: { backgroundColor: t.bg.hover },
      }}>
      <svg source={ICONS[icon]} style={{ width: BTN_ICON, height: BTN_ICON, color: t.text.secondary }} />
    </div>
  )
}
