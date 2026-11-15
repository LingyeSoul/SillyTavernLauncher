/**
 * 启动器运行目录（process.cwd()）的读写探针与失败指引。
 *
 * 为什么用真实探针而不是 fs.accessSync：Windows 的写入许可 = DACL 访问检查 +
 * 完整性强制策略（NO_WRITE_UP）叠加；accessSync 只测 DACL 的一部分，且目录的
 * 写权限语义要靠"能否真的创建文件"来证明。探针用唯一文件名 create → read →
 * delete，任何一步失败都带原始 errno/code 抛给调用方。
 *
 * 探针文件前缀固定（.stl-access-probe-），正常与失败路径都尽力清理；清理失败
 * 只在没有更早错误时才作为主错误抛出（不掩盖根因）。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatMoveLauncherGuide } from './launcherDirectoryGuide'

export const ACCESS_PROBE_PREFIX = '.stl-access-probe-'

/**
 * 真实读写探针：目录枚举（读+遍历）→ 创建探针文件（写）→ 读回校验（读）→
 * 删除。失败抛原始错误（ENOENT/EACCES/EPERM/EROFS 等），由调用方格式化。
 */
export function probeLauncherRootAccess(dir: string): void {
  readdirSync(dir)
  const probePath = join(dir, `${ACCESS_PROBE_PREFIX}${process.pid}-${randomUUID()}.tmp`)
  const payload = `stl-access-probe ${new Date().toISOString()}`
  let primaryError: unknown = null
  try {
    writeFileSync(probePath, payload, 'utf8')
    const readBack = readFileSync(probePath, 'utf8')
    if (readBack !== payload) {
      throw new Error(`探针文件读回不一致：${probePath}`)
    }
  } catch (err) {
    primaryError = err
  }
  if (existsSync(probePath)) {
    try {
      unlinkSync(probePath)
    } catch (err) {
      if (primaryError === null) primaryError = err
    }
  }
  if (primaryError !== null) throw primaryError
}

export interface RootAccessFailure {
  /** 现象（展示在错误对话框正文区，面向普通用户） */
  message: string
  /** 换目录步骤（对话框详情区） */
  detail: string
  /** 目录/原始错误/icacls 命令（只进 errorLog，不展示） */
  technicalDetail: string
}

function describeFsError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return `${code ?? 'UNKNOWN'}: ${err.message}`
  }
  return String(err)
}

export function formatRootAccessFailure(dir: string, err: unknown): RootAccessFailure {
  return {
    message: [
      `启动器所在的文件夹没有写入权限：${dir}`,
      '保存设置、日志和酒馆数据都会失败。',
    ].join('\n'),
    detail: formatMoveLauncherGuide(),
    technicalDetail: [
      `运行目录：${dir}`,
      `系统错误：${describeFsError(err)}`,
      '',
      '技术修复（可选；普通用户按界面步骤更换目录即可）：',
      `icacls "${dir}" /grant "<用户名>:(OI)(CI)M"`,
    ].join('\n'),
  }
}