/**
 * 偏差天数：全系统唯一口径，页面、导出、册子、交付清单都调它，不允许各自再算一遍。
 * 口径（由本次修复拍板）：
 *  - 已完成：实际完成日 − 计划完成日
 *  - 未完成：今天 − 计划完成日（在办节点当前的偏差趋势）
 *  - 任一日期缺失：返回 null（缺数据，不拿 0 冒充）
 *  - 早完为负、按期为 0、逾期为正
 */
export const DEVIATION_VERSION = '2026-10-01:actual-or-today-minus-plan'

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) {
    return false
  }
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

export function toDayIndex(value: string): number {
  const [y, m, d] = value.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86400000
}

export function dayDiff(later: string, earlier: string): number | null {
  if (!isValidDate(later) || !isValidDate(earlier)) {
    return null
  }
  return toDayIndex(later) - toDayIndex(earlier)
}

export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 统一偏差算法：返回整数天；无法计算返回 null。 */
export function deviationDays(
  planDate: string,
  actualDate: string,
  status: string,
  nowISO: string = todayISO(),
): number | null {
  if (!isValidDate(planDate)) {
    return null
  }
  const finishDate = status === '已完成' ? actualDate : nowISO
  if (!isValidDate(finishDate)) {
    return null
  }
  return dayDiff(finishDate, planDate)
}
