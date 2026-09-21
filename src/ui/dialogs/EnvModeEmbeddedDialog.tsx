/**
 * 切换 embedded 环境模式确认对话框（设计计划 §5.2 / D4，Embedded-All Phase 1）：
 * gold 警示图标 + 四条兼容性风险（文案照设计文档逐字）。
 * 取消 = primary（安全默认，不落盘，Select 由 settings 状态驱动自动回显原值）；
 * 启用 = quietDanger（明知风险前行）。
 * DEVIATION: 原版「无 onClose」以阻断一切非按钮关闭路径；动效 PR4 后动作按钮改走
 * requestClose 播退场，需要 onClose 作结算通道——补 onClose 的同时加 strong 挡
 * Escape，保持「唯一出口是两个按钮」语义不变（ExitConfirm/Eula 同款强模态）。
 */
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal, useModalClose } from '../components/Modal'
import { ICONS } from '../components/icons'

const TEXTS = {
  title: '启用启动器内置运行时？',
  risk1: '• ST 官方主运行时为 Node.js，内置模式使用 Bun 运行时，个别功能与扩展可能异常；',
  risk2: '• Git 操作由 JS 实现完成，极端仓库操作可能失败；',
  risk3: '• 依赖安装使用 bun，与 npm 存在行为差异；',
  risk4: '• 遇到问题请切回内置懒人包环境或系统环境。',
  cancel: '取消',
  enable: '启用实验性运行时',
} as const

export interface EnvModeEmbeddedDialogProps {
  /** 用户确认启用后触发（真正落盘 settings.update({ envMode: 'embedded' }) 放这里） */
  onConfirm: () => void
}

/** 动作区（Provider 子树内取 useModalClose，PR4）：两个按钮统一走 requestClose 播退场 */
function EnvModeEmbeddedActions({ onConfirm }: EnvModeEmbeddedDialogProps) {
  const requestClose = useModalClose()
  return (
    <>
      <Button
        variant="quietDanger"
        icon="terminal"
        onClick={() => {
          requestClose()
          onConfirm()
        }}
        testId="env-embedded-confirm-ok">
        {TEXTS.enable}
      </Button>
      <Button variant="primary" onClick={requestClose} testId="env-embedded-confirm-cancel">
        {TEXTS.cancel}
      </Button>
    </>
  )
}

export function EnvModeEmbeddedDialog({ onConfirm }: EnvModeEmbeddedDialogProps) {
  const t = useTheme()
  const riskLineStyle = {
    fontSize: 14,
    color: t.text.primary,
    fontFamily: t.font.sans,
    lineHeight: 22,
  }
  return (
    <Modal
      open
      strong
      width={440}
      title={TEXTS.title}
      // 结算回调：退场播完后由 Modal 调用，直呼 closeTopDialog 真卸载（见 Modal.tsx 头注释）
      onClose={() => useUiState.getState().closeTopDialog()}
      actions={<EnvModeEmbeddedActions onConfirm={onConfirm} />}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <svg source={ICONS.alertTriangle} style={{ width: 19, height: 19, color: t.gold, flexShrink: 0 }} />
        <text style={{ fontSize: 14, color: t.text.primary, fontFamily: t.font.sans, flexGrow: 1 }}>
          {`以内置运行时（实验性）运行 SillyTavern 存在以下兼容性风险：`}
        </text>
      </div>
      <div style={{ height: 8 }} />
      <text style={riskLineStyle}>{TEXTS.risk1}</text>
      <text style={riskLineStyle}>{TEXTS.risk2}</text>
      <text style={riskLineStyle}>{TEXTS.risk3}</text>
      <text style={riskLineStyle}>{TEXTS.risk4}</text>
    </Modal>
  )
}
