/**
 * 进度节点台账（唯一事实源）
 *
 * 列表页、导出文件、下载册子、掘进环次交付清单都只能从这里取数，
 * 任何「在页面上临时拼字段」的旁路都不允许。
 *
 * 偏差天数算法（DEVIATION_ALGORITHM_VERSION）：
 *   偏差天数 = 实际完成日 − 计划完成日（单位：天，早于计划为负）
 *   尚无实际完成日的在办节点：以 today 为基准 = today − 计划完成日
 * 台账字段里只保留登记值，偏差天数一律由 calcDeviationDays 现算，算法升级只改这一处。
 */

import { KV_KEYS, commitKv, readKv } from './kv-store'
import { listRows, saveRows } from './local-store'
import { SEED_PROGRESS } from './progress-seed'
import type { EntryRow } from './types'

export const DEVIATION_ALGORITHM_VERSION = 'v2.0'
export const LEDGER_VERSION = 2

export const PROGRESS_COLUMNS = [
  '节点编号',
  '节点名称',
  '计划完成日',
  '实际完成日',
  '计划掘进量',
  '实际掘进量',
  '偏差天数',
  '节点状态',
  '补录标记',
] as const

export const STATUS = {
  notStarted: '未开始',
  inProgress: '进行中',
  done: '已完成',
  delayed: '已延期',
} as const

export type ProgressNode = {
  id: number
  nodeCode: string
  nodeName: string
  planDate: string // YYYY-MM-DD
  actualDate: string // YYYY-MM-DD，未完成留空
  planAmount: number
  actualAmount: number // 未完成可为 0
  status: string
  backfilled: boolean // 补录节点
  createdAt: string // 登记时间 ISO
}

export type LedgerMeta = {
  version: number
  deviationAlgorithm: string
  installedAt: string
}

export type ProgressStats = {
  total: number
  active: number // 在办：未开始 + 进行中 + 已延期（还在办）
  done: number
  delayed: number
  backfilled: number
}

export type RehouseReport = {
  imported: number
  droppedDuplicates: number
  firstNodeCode: string
}

export type WriteResult<T = void> = {
  ok: boolean
  message: string
  step?: string // 卡在第几步
  data?: T
}

/** 角色与权限等级：计划工程师(2) 及以上才能动计划完成日。 */
export const ROLE_LEVELS: Record<string, number> = {
  值班员: 1,
  计划工程师: 2,
  建设单位代表: 3,
}
export const MIN_LEVEL_CHANGE_PLAN = 2

function emptyLedger(): ProgressNode[] {
  return []
}

export function readLedger(): ProgressNode[] {
  return readKv<ProgressNode[]>(KV_KEYS.progressLedger, emptyLedger())
}

function readMeta(): LedgerMeta | null {
  return readKv<LedgerMeta | null>(KV_KEYS.progressMeta, null)
}

function writeLedger(ledger: ProgressNode[], meta?: LedgerMeta): void {
  // ledger 先落、meta 后落：一旦第二枪失败，commitKv 会删掉新建的 ledger 键并回滚，模拟真实半包。
  const entries: { key: string; value: unknown }[] = [{ key: KV_KEYS.progressLedger, value: ledger }]
  if (meta) {
    entries.push({ key: KV_KEYS.progressMeta, value: meta })
  }
  commitKv(entries)
}

// ---- 日期与偏差 ----------------------------------------------------------------

export function dayDiff(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00Z`).getTime()
  const to = new Date(`${toDate}T00:00:00Z`).getTime()
  return Math.round((to - from) / 86_400_000)
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 唯一偏差天数算法：实际完成日优先，没有就按今天算在办偏差。 */
export function calcDeviationDays(node: Pick<ProgressNode, 'planDate' | 'actualDate'>, today = todayISO()): number {
  const anchor = node.actualDate || today
  return dayDiff(node.planDate, anchor)
}

// ---- 行 <-> 台账 ----------------------------------------------------------------

function toLegacyRow(node: ProgressNode): EntryRow {
  return {
    id: node.id,
    status: node.status,
    pending: node.status !== STATUS.done,
    abnormal: node.status === STATUS.delayed,
    节点编号: node.nodeCode,
    节点名称: node.nodeName,
    计划完成日: node.planDate,
    实际完成日: node.actualDate,
    计划掘进量: node.planAmount,
    实际掘进量: node.actualAmount,
    // 偏差天数不入库，读的时候按统一算法现算，保证全平台一份算法。
    偏差天数: calcDeviationDays(node),
    节点状态: node.status,
    补录标记: node.backfilled ? '补录' : '',
  }
}

function normalizeDate(value: unknown): string {
  return String(value ?? '').trim()
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 旧清单行 / 种子行 → 台账节点；createdAt 缺省时按「补录在前、编号靠后」兜底。 */
export function nodeFromRow(row: EntryRow, fallbackIndex = 0): ProgressNode {
  const backfilled = String(row['补录标记'] ?? '').includes('补录')
  return {
    id: Number(row.id),
    nodeCode: String(row['节点编号'] ?? ''),
    nodeName: String(row['节点名称'] ?? ''),
    planDate: normalizeDate(row['计划完成日']),
    actualDate: normalizeDate(row['实际完成日']),
    planAmount: toNumber(row['计划掘进量']),
    actualAmount: toNumber(row['实际掘进量']),
    status: String(row.status ?? row['节点状态'] ?? STATUS.notStarted),
    backfilled,
    createdAt:
      normalizeDate(row['登记时间']) ||
      (backfilled ? `2026-09-01T0${Math.min(fallbackIndex, 9)}:00:00.000Z` : `2026-09-15T0${Math.min(fallbackIndex, 9)}:00:00.000Z`),
  }
}

/** 台账 → 页面/导出通用行（唯一出门方式，偏差天数在这里统一拼上）。 */
export function presentNode(node: ProgressNode, today = todayISO()): EntryRow {
  const row = toLegacyRow(node)
  row['偏差天数'] = calcDeviationDays(node, today)
  return row
}

export function presentLedger(today = todayISO()): EntryRow[] {
  return readLedger().map((node) => presentNode(node, today))
}

// ---- 统计（所有页面共用这一份） --------------------------------------------------

export function progressStats(today = todayISO()): ProgressStats {
  const ledger = readLedger()
  return {
    total: ledger.length,
    active: ledger.filter((node) => node.status !== STATUS.done).length,
    done: ledger.filter((node) => node.status === STATUS.done).length,
    delayed: ledger.filter((node) => node.status === STATUS.delayed).length,
    backfilled: ledger.filter((node) => node.backfilled).length,
  }
}

/** 已完成节点数：掘进环次交付清单和进度页必须读同一个函数，两边数字才对得上。 */
export function completedNodeCount(): number {
  return readLedger().filter((node) => node.status === STATUS.done).length
}

// ---- 重新入库（rehouse） ---------------------------------------------------------

function earliestFirst(a: ProgressNode, b: ProgressNode): number {
  const ta = Date.parse(a.createdAt)
  const tb = Date.parse(b.createdAt)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
    return ta - tb
  }
  // 登记时间一样：补录节点（事后补）视为更早登记的业务事实 → 仍取 id 小的
  return a.id - b.id
}

/**
 * 存量节点按计划完成日重新入库（事务）：
 * 执行顺序由本模块拍板——先去重、后排序、再编号、最后原子落库；
 * 落库放在最后一步，保证前面任何一步失败都还没动存储。
 * 1) 读入旧清单/种子 → 2) 同节点编号重复登记只留登记最早的一条 →
 * 3) 按计划完成日升序重排并重编号 → 4) 原子落库（失败由 commitKv 整体回滚）。
 * 返回被丢弃的重复条数。
 */
export function rehouseProgress(source?: EntryRow[], now = new Date().toISOString()): WriteResult<RehouseReport> {
  const raw = (source ?? listRows('progress')).map(nodeFromRow)
  if (raw.length === 0) {
    return { ok: false, message: '没有可重新入库的进度节点', step: '第1步 读存量节点' }
  }

  // 第2步：重复登记只留最早那条。earliestFirst(a,b) < 0 表示 a 更早。
  const earliestByCode = new Map<string, ProgressNode>()
  let dropped = 0
  for (const node of raw) {
    const exist = earliestByCode.get(node.nodeCode)
    if (!exist) {
      earliestByCode.set(node.nodeCode, node)
    } else {
      earliestByCode.set(node.nodeCode, earliestFirst(exist, node) <= 0 ? exist : node)
      dropped += 1
    }
  }

  // 第3步：按计划完成日升序（非法日期沉底），同日按登记先后
  const reordered = [...earliestByCode.values()].sort((a, b) => {
    const ta = Date.parse(`${a.planDate}T00:00:00Z`)
    const tb = Date.parse(`${b.planDate}T00:00:00Z`)
    const va = Number.isFinite(ta) ? ta : Number.MAX_SAFE_INTEGER
    const vb = Number.isFinite(tb) ? tb : Number.MAX_SAFE_INTEGER
    if (va !== vb) {
      return va - vb
    }
    return earliestFirst(a, b)
  })
  const ledger = reordered.map((node, index) => ({ ...node, id: index + 1 }))

  // 第4步：落库不成（配额/适配器抛错）→ commitKv 已回滚，调用方整套撤回
  try {
    writeLedger(ledger, {
      version: LEDGER_VERSION,
      deviationAlgorithm: DEVIATION_ALGORITHM_VERSION,
      installedAt: now,
    })
  } catch (error) {
    return {
      ok: false,
      message: `节点重新入库失败，已整套撤回：${error instanceof Error ? error.message : '存储不可用'}`,
      step: '第4步 原子落库',
    }
  }
  return {
    ok: true,
    message: `重新入库完成：导入 ${ledger.length} 条，丢弃重复登记 ${dropped} 条，已按计划完成日升序排列`,
    data: { imported: ledger.length, droppedDuplicates: dropped, firstNodeCode: ledger[0]?.nodeCode ?? '' },
  }
}

/** 首次装载：台账不存在或版本旧时，用种子节点做一次重新入库（幂等，v2 不重复搬）。 */
export function ensureProgressLedger(): boolean {
  const meta = readMeta()
  if (meta && meta.version >= LEDGER_VERSION && readLedger().length > 0) {
    return false
  }
  // 老版本（v1）：旧清单里有合法计划完成日的真实数据就原样搬迁；占位样例（日期列是文字）换新种子。
  const legacy = listRows('progress')
  const hasLegacyData = legacy.some((row) => /^\d{4}-\d{2}-\d{2}$/.test(normalizeDate(row['计划完成日'])))
  const source = hasLegacyData ? legacy : SEED_PROGRESS
  const result = rehouseProgress(source)
  if (!result.ok) {
    throw new Error(result.message)
  }
  return true
}

// ---- 写入与权限 -----------------------------------------------------------------

export type PlanChangeInput = {
  nodeId: number
  newPlanDate: string
  operator: string
  role: string
}

/**
 * 已确认完成的节点，任何环节（页面改、导出顺手改、补录改）都不许再动计划完成日；
 * 越权（角色等级不够）或越级（绕过该入口）改动直接驳回，并说明卡在哪一步。
 */
export function changePlanDate(input: PlanChangeInput): WriteResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.newPlanDate)) {
    return { ok: false, step: '第1步 入参校验', message: `驳回：计划完成日格式应为 YYYY-MM-DD，收到「${input.newPlanDate}」` }
  }
  const level = ROLE_LEVELS[input.role] ?? 0
  if (level < MIN_LEVEL_CHANGE_PLAN) {
    return {
      ok: false,
      step: '第2步 权限校验',
      message: `驳回（越权）：${input.operator}/${input.role} 等级 ${level}，修改计划完成日需等级 ≥ ${MIN_LEVEL_CHANGE_PLAN}（计划工程师及以上）`,
    }
  }
  const ledger = readLedger()
  const index = ledger.findIndex((node) => node.id === input.nodeId)
  if (index < 0) {
    return { ok: false, step: '第3步 台账定位', message: `驳回：台账里找不到编号 ${input.nodeId} 的节点` }
  }
  if (ledger[index].status === STATUS.done) {
    return {
      ok: false,
      step: '第4步 完成态冻结',
      message: `驳回：节点「${ledger[index].nodeCode}」已确认完成，计划完成日 ${ledger[index].planDate} 已冻结，禁止修改`,
    }
  }
  const next = [...ledger]
  next[index] = { ...next[index], planDate: input.newPlanDate }
  try {
    writeLedger(next)
  } catch (error) {
    return { ok: false, step: '第5步 原子落库', message: `驳回：落库失败已撤回，${error instanceof Error ? error.message : '存储不可用'}` }
  }
  return { ok: true, message: `节点「${next[index].nodeCode}」计划完成日已改为 ${input.newPlanDate}` }
}

export type CreateNodeInput = {
  nodeCode: string
  nodeName: string
  planDate: string
  actualDate?: string
  planAmount: number
  actualAmount?: number
  status?: string
  backfilled?: boolean
}

/** 补录/登记新节点：同编号重复登记直接驳回（重新入库场景才按最早保留去重）。 */
export function createNode(input: CreateNodeInput, now = new Date().toISOString()): WriteResult<{ id: number }> {
  if (!input.nodeCode.trim()) {
    return { ok: false, step: '第1步 入参校验', message: '驳回：节点编号不能为空' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.planDate)) {
    return { ok: false, step: '第1步 入参校验', message: '驳回：计划完成日格式应为 YYYY-MM-DD' }
  }
  const ledger = readLedger()
  if (ledger.some((node) => node.nodeCode === input.nodeCode.trim())) {
    return { ok: false, step: '第2步 重复登记校验', message: `驳回：节点「${input.nodeCode.trim()}」已登记，不允许重复提交` }
  }
  const status = input.status ?? STATUS.notStarted
  const node: ProgressNode = {
    id: ledger.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    nodeCode: input.nodeCode.trim(),
    nodeName: input.nodeName.trim() || input.nodeCode.trim(),
    planDate: input.planDate,
    actualDate: input.actualDate ?? '',
    planAmount: input.planAmount,
    actualAmount: input.actualAmount ?? 0,
    status,
    backfilled: input.backfilled ?? false,
    createdAt: now,
  }
  try {
    // 新节点统一按计划完成日归位重排（存量顺序不变，只动新条目的落点），id 保持稳定。
    const next = [...ledger, node].sort(
      (a, b) => Date.parse(`${a.planDate}T00:00:00Z`) - Date.parse(`${b.planDate}T00:00:00Z`),
    )
    writeLedger(next)
  } catch (error) {
    return { ok: false, step: '第3步 原子落库', message: `驳回：登记落库失败已撤回，${error instanceof Error ? error.message : '存储不可用'}` }
  }
  return { ok: true, message: `节点「${node.nodeCode}」已${node.backfilled ? '补录' : '登记'}`, data: { id: node.id } }
}

/** 节点动作（开始/确认完成/登记延期）：确认完成时冻结实际完成日，之后计划日不可改。 */
export function applyNodeAction(nodeId: number, action: string, today = todayISO()): WriteResult {
  const targetByAction: Record<string, string> = {
    开始节点: STATUS.inProgress,
    确认完成: STATUS.done,
    登记延期: STATUS.delayed,
  }
  const target = targetByAction[action]
  if (!target) {
    return { ok: false, step: '第1步 动作校验', message: `驳回：节点没有登记「${action}」这个动作` }
  }
  const ledger = readLedger()
  const index = ledger.findIndex((node) => node.id === nodeId)
  if (index < 0) {
    return { ok: false, step: '第2步 台账定位', message: `驳回：找不到编号 ${nodeId} 的节点` }
  }
  const node = ledger[index]
  if (node.status === target) {
    return { ok: false, message: `节点「${node.nodeCode}」已经是「${target}」，不用重复操作` }
  }
  if (node.status === STATUS.done) {
    return { ok: false, step: '第3步 完成态冻结', message: `驳回：节点「${node.nodeCode}」已确认完成，状态与计划日均已冻结` }
  }
  const updated: ProgressNode = { ...node, status: target }
  if (target === STATUS.done && !updated.actualDate) {
    updated.actualDate = today
  }
  const next = [...ledger]
  next[index] = updated
  try {
    writeLedger(next)
  } catch (error) {
    return { ok: false, step: '第4步 原子落库', message: `驳回：状态落库失败已撤回，${error instanceof Error ? error.message : '存储不可用'}` }
  }
  return { ok: true, message: `节点「${node.nodeCode}」已${action}，当前状态「${target}」` }
}

/** 仅供运维/测试：把台账刷成给定节点（同样按计划完成日入库）。 */
export function replaceLedger(nodes: ProgressNode[]): void {
  const ledger = [...nodes].sort(
    (a, b) => Date.parse(`${a.planDate}T00:00:00Z`) - Date.parse(`${b.planDate}T00:00:00Z`),
  )
  writeLedger(ledger, readMeta() ?? undefined)
}

export function ledgerMeta(): LedgerMeta | null {
  return readMeta()
}

/** 旧清单同步一份到通用存储，供运营概览等通用页面计数（另一个页面的条数一起更新）。 */
export function syncLegacyProgress(): void {
  const rows = presentLedger()
  saveRows('progress', rows)
}

/** 应用启动引导：确保台账就位并把派生数据同步进通用清单，幂等，可反复调用。 */
export function bootstrapProgress(): void {
  ensureProgressLedger()
  syncLegacyProgress()
}
