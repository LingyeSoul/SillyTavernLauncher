/**
 * 欢迎问答对话框（设计 §4.7）：10 题单选步进器。
 * - 步进器：头部"初始配置 (N/10)" + 10 个 6px 进度点（当前=ember，已答=border.default，
 *   未答=bg.elevated）；题干 14/500；选项 = Radio 行高 36（√ 正确 / ✗ 错误）。
 * - 底部：上一步 quiet / 下一题 primary（末题变"完成"）。
 * - 题目文本 + 解析 + 正确答案从 welcome_dialog.py 提取（文案照搬）。
 *   DEVIATION: 题库 12 题取 10 题（#5 与 #4、#11 与 #10 语义重复，去重）；
 *   Flet 版的功能介绍长文区块按设计 §4.7 步进器规格未迁移，压缩为顶部两行警示。
 */
import { useState } from 'react'
import { getConfigStore } from '../../services/configStore'
import { errMsg, logError } from '../../services/errorLog'
import { useUiState } from '../../stores/uiState'
import { useTheme } from '../theme'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'
import { Radio } from '../components/Radio'

const TEXTS = {
  title: '欢迎使用 SillyTavernLauncher',
  headerPrefix: '初始配置',
  warnLine1: '⚠ 请勿使用包含中文或空格的路径！',
  warnLine2: '⚠ 懒人包用户请直接点击"启动"按钮，无需重复安装',
  optionTrue: '√ 正确',
  optionFalse: '✗ 错误',
  prev: '上一步',
  next: '下一题',
  finish: '完成',
  answerRequired: '请选择一个答案',
} as const

interface WelcomeQuestion {
  id: number
  text: string
  correctAnswer: boolean
  explanation: string
}

/** ← welcome_dialog.py QUESTION_BANK（文案照搬；12 题去重取 10） */
export const WELCOME_QUESTIONS: readonly WelcomeQuestion[] = [
  {
    id: 0,
    text: '可以将启动器放在包含中文或空格的路径中运行',
    correctAnswer: false,
    explanation: '启动器路径不能包含中文和空格，否则可能导致Git和Node.js命令执行失败。请确保使用纯英文路径。',
  },
  {
    id: 1,
    text: "使用懒人包安装后，仍需点击'安装'按钮安装SillyTavern",
    correctAnswer: false,
    explanation: '懒人包已经内置了环境和SillyTavern，下载后直接点击\'启动\'按钮即可运行，无需重复安装。',
  },
  {
    id: 2,
    text: "点击'停止'按钮后，SillyTavern会立即关闭，需要重新点击'启动'才能再次运行",
    correctAnswer: true,
    explanation: '正确。停止按钮会完全关闭SillyTavern进程，下次使用需要重新点击启动。',
  },
  {
    id: 3,
    text: "在'设置'页面修改配置后，所有设置都会立即生效",
    correctAnswer: false,
    explanation: '部分设置（如端口、代理URL等）需要保存，且涉及SillyTavern的配置需要重启酒馆后才能生效。',
  },
  {
    id: 4,
    text: '使用系统环境模式时，需要确保已安装Git和Node.js 18+',
    correctAnswer: true,
    explanation: '正确。系统环境模式依赖您电脑上已安装的Git和Node.js，版本要求为Node.js 18.x或更高。',
  },
  {
    id: 6,
    text: '启动器支持安装，启动，停止，更新SillyTavern',
    correctAnswer: true,
    explanation: '正确。启动器提供安装，启动，停止，更新SillyTavern功能，这也是启动器主要的4大功能。',
  },
  {
    id: 7,
    text: 'SillyTavern运行期间可以随时切换版本',
    correctAnswer: false,
    explanation: '错误。必须先停止当前运行的SillyTavern，才能切换到其他版本。',
  },
  {
    id: 8,
    text: '启动器支持多实例同时运行多个SillyTavern版本',
    correctAnswer: false,
    explanation: '错误。同时间内只能运行一个SillyTavern实例，启动器会自动检测并阻止多实例运行。',
  },
  {
    id: 9,
    text: '同步功能需要在局域网内两台设备上都运行启动器',
    correctAnswer: true,
    explanation: '正确。同步功能需要一台设备作为服务端运行，另一台作为客户端连接，都需要启动启动器。',
  },
  {
    id: 10,
    text: '启动器支持设置Github镜像',
    correctAnswer: true,
    explanation: '正确。启动器提供GitHub镜像设置功能，可以加速国内用户访问GitHub，提升SillyTavern和扩展下载速度。',
  },
]

export function WelcomeDialog() {
  const t = useTheme()
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Array<boolean | null>>(
    WELCOME_QUESTIONS.map(() => null),
  )
  const [error, setError] = useState<string | null>(null)

  const total = WELCOME_QUESTIONS.length
  const question = WELCOME_QUESTIONS[step]
  const isLast = step === total - 1
  const answered = answers[step] !== null

  const handleNext = (): void => {
    if (!answered) {
      setError(TEXTS.answerRequired)
      return
    }
    setError(null)
    if (isLast) {
      // ← _close_dialog：完成后写 config
      const config = getConfigStore()
      config.set('first_run', false)
      try {
        config.save()
      } catch (err) {
        logError(`[welcome] 保存首次启动状态失败: ${errMsg(err)}`)
      }
      useUiState.getState().closeTopDialog()
      return
    }
    setStep(step + 1)
  }

  return (
    <Modal open strong width={480} title={TEXTS.title}>
      {/* 步进器头部 + 进度点 */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <text style={{ fontSize: 13, fontWeight: 500, color: t.text.secondary, fontFamily: t.font.sans }}>
          {`${TEXTS.headerPrefix} (${step + 1}/${total})`}
        </text>
        <div style={{ display: 'flex', flexDirection: 'row', gap: 5 }}>
          {WELCOME_QUESTIONS.map((q, i) => (
            <div
              key={q.id}
              testId={`welcome-dot-${i}`}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor:
                  i === step ? t.ember
                  : answers[i] !== null ? t.border.default
                  : t.bg.elevated,
              }}
            />
          ))}
        </div>
      </div>

      {/* 压缩警示（Flet 功能介绍区块的保留项） */}
      <text style={{ fontSize: 12, color: t.status.warning, fontFamily: t.font.sans, marginBottom: 2 }}>
        {TEXTS.warnLine1}
      </text>
      <text style={{ fontSize: 12, color: t.status.warning, fontFamily: t.font.sans, marginBottom: 12 }}>
        {TEXTS.warnLine2}
      </text>

      {/* 题干 */}
      <text testId="welcome-question" style={{ fontSize: 14, fontWeight: 500, color: t.text.primary, fontFamily: t.font.sans }}>
        {`${step + 1}. ${question.text}`}
      </text>

      {/* 选项 */}
      <div style={{ display: 'flex', flexDirection: 'row', gap: 20, marginTop: 4 }}>
        <Radio
          checked={answers[step] === true}
          label={TEXTS.optionTrue}
          onChange={() => {
            setAnswers((prev) => prev.map((a, i) => (i === step ? true : a)))
            setError(null)
          }}
          testId="welcome-answer-true"
        />
        <Radio
          checked={answers[step] === false}
          label={TEXTS.optionFalse}
          onChange={() => {
            setAnswers((prev) => prev.map((a, i) => (i === step ? false : a)))
            setError(null)
          }}
          testId="welcome-answer-false"
        />
      </div>

      {error && (
        <text style={{ fontSize: 12, color: t.status.error, fontFamily: t.font.sans }}>{error}</text>
      )}

      {/* 底部动作 */}
      <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <Button
          variant="quiet"
          disabled={step === 0}
          onClick={() => {
            setStep(Math.max(0, step - 1))
            setError(null)
          }}
          testId="welcome-prev">
          {TEXTS.prev}
        </Button>
        <Button variant="primary" disabled={!answered} onClick={handleNext} testId="welcome-next">
          {isLast ? TEXTS.finish : TEXTS.next}
        </Button>
      </div>
    </Modal>
  )
}
