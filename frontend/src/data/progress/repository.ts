import { deviationDays } from './deviation'
import { LEGACY_DELIVERIES, LEGACY_FORM_ONLY_NODES, LEGACY_LIST_NODES, type LegacyNode } from './legacy'
import { KV_KEYS, getKv, type KvStore } from './storage'
import type {
  ApprovalResult,
  DeliveryItem,
  NodeProjection,
  NodeStatus,
  ProgressNode,
  Role,
} from './types'
import { isValidDate } from './deviation'

const LEDGER_VERSION = 1
const COMPLETED_STATUS: NodeStatus = '已完成'
/** 交付清单当前使用的偏差算法版本，升级时随 deviation.ts 一起更新。 */
export const LEDGER_DEV_VERSION = '2026-10-01:actual-or-today-minus-plan'

/** 台账快照：这就是列表页、导出、册子共同读的“同一份数据”。 */
export interface Ledger {
  version: number
  migratedAt: string
  nodes: ProgressNode[]
}

export interface RegisterInput {
  code: string
  name: string
  planDate: string
  actualDate?: string
  planQty?: number
  actualQty?: number
  status?: NodeStatus
  createdAt?: string
}

function nowISO(): string {
  return new Date().toISOString()
}

/** 已完成节点的计划完成日冻结，任何角色都不能改；未完成节点改计划日需监理及以上。 */
const ROLE_RANK: Record<Role, number> = { 班组: 1, 项目部: 2, 监理: 3, 建设单位: 4 }
const MIN_ROLE_CHANGE_PLAN: Role = '监理'

function normalizeStatus(value: string): NodeStatus {
  return (['未开始', '进行中', '已完成', '已延期'] as NodeStatus[]).includes(value as NodeStatus)
    ? (value as NodeStatus)
    : '未开始'
}

/** 页面临时拼进去的字段在这里并回台账：计划完成日以表单补录值兜底。 */
function normalizeLegacy(raw: LegacyNode): ProgressNode {
  const planDate = isValidDate(raw.planDate)
    ? raw.planDate
    : raw.formOnly?.planDate && isValidDate(raw.formOnly.planDate)
      ? raw.formOnly.planDate
      : raw.planDate ?? ''
  return {
    id: raw.id,
    code: raw.code,
    name: raw.name,
    planDate,
    actualDate: raw.actualDate ?? '',
    planQty: Number(raw.planQty ?? 0),
    actualQty: Number(raw.actualQty ?? 0),
    status: normalizeStatus(raw.status),
    createdAt: raw.createdAt,
    ordinal: 0,
  }
}

/** 重复登记只留最早登记那条：createdAt 最小；并列时取 id 更小。 */
export function dedupeEarliest(nodes: ProgressNode[]): ProgressNode[] {
  const byCode = new Map<string, ProgressNode>()
  for (const node of nodes) {
    const kept = byCode.get(node.code)
    if (
      !kept ||
      node.createdAt < kept.createdAt ||
      (node.createdAt === kept.createdAt && node.id < kept.id)
    ) {
      byCode.set(node.code, node)
    }
  }
  return [...byCode.values()]
}

/** 处理顺序（拍板）：计划完成日升序；无计划完成日的排最后；同日按 id 升序。 */
export function sortByPlanDate(nodes: ProgressNode[]): ProgressNode[] {
  return [...nodes].sort((a, b) => {
    const av = isValidDate(a.planDate) ? 0 : 1
    const bv = isValidDate(b.planDate) ? 0 : 1
    if (av !== bv) {
      return av - bv
    }
    if (av === 0 && a.planDate !== b.planDate) {
      return a.planDate < b.planDate ? -1 : 1
    }
    return a.id - b.id
  })
}

/** 存量节点按计划完成日重新入库：先重号去重（留最早），再按计划完成日排序编号。 */
export function reindex(nodes: ProgressNode[]): ProgressNode[] {
  return sortByPlanDate(dedupeEarliest(nodes)).map((node, index) => ({
    ...node,
    ordinal: index + 1,
  }))
}

function buildLedger(rawNodes: LegacyNode[], at: string): Ledger {
  const merged = rawNodes.map(normalizeLegacy)
  return { version: LEDGER_VERSION, migratedAt: at, nodes: reindex(merged) }
}

/**
 * 一次性迁移：把“库内节点 + 只在表单里的补录节点”并成同一份台账，
 * 同时把旧交付清单按新偏差算法重算。任何一步失败都不写半成品（回滚）。
 */
export function migrate(
  kv: KvStore = getKv(),
  now: string = nowISO(),
): { ledger: Ledger; mergedFromForm: number; deduped: number } {
  if (kv.get<string>(KV_KEYS.migrated)) {
    return {
      ledger: requireLedger(kv),
      mergedFromForm: 0,
      deduped: 0,
    }
  }

  const rawAll = [...LEGACY_LIST_NODES, ...LEGACY_FORM_ONLY_NODES]
  const ledger = buildLedger(rawAll, now)
  const deduped = rawAll.length - new Set(rawAll.map((n) => n.code)).size
  const deliveries = recalcDeliveries(
    LEGACY_DELIVERIES.map((d) => ({ ...d, deviationSnapshot: d.deviationSnapshot.map((s) => ({ ...s })) })),
    ledger,
    now,
  )

  // 多键写入放进同一“事务”：任一落库失败整套撤回，不允许留半包状态。
  commit(kv, [
    [KV_KEYS.ledger, ledger],
    [KV_KEYS.deliveries, deliveries],
    [KV_KEYS.packages, []],
    [KV_KEYS.migrated, now],
  ])
  return { ledger, mergedFromForm: LEGACY_FORM_ONLY_NODES.length, deduped }
}

/** 多键原子提交：全部写成功才算，否则把已写的回滚、抛出错误。 */
function commit(kv: KvStore, writes: [string, unknown][]): void {
  const backups = writes.map(([key]) => [key, kv.get(key)] as const)
  try {
    for (const [key, value] of writes) {
      kv.set(key, value)
    }
  } catch (error) {
    for (const [key, value] of backups) {
      if (value === null) {
        kv.remove(key)
      } else {
        kv.set(key, value)
      }
    }
    throw error
  }
}

export function requireLedger(kv: KvStore = getKv()): Ledger {
  const ledger = kv.get<Ledger>(KV_KEYS.ledger)
  if (!ledger) {
    // 任何读取入口前都先确保迁移完成，保证“两条路读到同一份”。
    return migrate(kv).ledger
  }
  return ledger
}

export function saveLedger(ledger: Ledger, kv: KvStore = getKv()): void {
  kv.set(KV_KEYS.ledger, ledger)
}

const COLUMN_DEFAULTS: Record<string, string> = {
  计划完成日: '',
}

/** 台账 → 统一投影：偏差天数在此现算，并逐行标记缺失列。所有出口共用。 */
export function projectNode(
  node: ProgressNode,
  nowISO: string,
): NodeProjection {
  const missingColumns: string[] = []
  if (!isValidDate(node.planDate)) {
    missingColumns.push('计划完成日')
  }
  if (node.status === COMPLETED_STATUS && !isValidDate(node.actualDate)) {
    missingColumns.push('实际完成日')
  }
  if (!(node.planQty > 0)) {
    missingColumns.push('计划掘进量')
  }
  return {
    id: node.id,
    code: node.code,
    name: node.name,
    planDate: node.planDate,
    actualDate: node.actualDate,
    planQty: node.planQty,
    actualQty: node.actualQty,
    deviationDays: deviationDays(node.planDate, node.actualDate, node.status, nowISO),
    status: node.status,
    ordinal: node.ordinal,
    missingColumns,
  }
}

export function listNodes(kv: KvStore = getKv()): ProgressNode[] {
  return requireLedger(kv).nodes
}

export function projectAll(
  nowISO: string = new Date().toISOString().slice(0, 10),
  kv: KvStore = getKv(),
): NodeProjection[] {
  return listNodes(kv).map((n) => projectNode(n, nowISO))
}

export interface NodeStats {
  total: number
  inProgress: number
  completed: number
  delayed: number
  notStarted: number
}

/** 计数唯一口径：进度页卡片和掘进环次交付清单都从这里取已完成数。 */
export function nodeStats(kv: KvStore = getKv()): NodeStats {
  const nodes = listNodes(kv)
  return {
    total: nodes.length,
    inProgress: nodes.filter((n) => n.status === '进行中').length,
    completed: nodes.filter((n) => n.status === COMPLETED_STATUS).length,
    delayed: nodes.filter((n) => n.status === '已延期').length,
    notStarted: nodes.filter((n) => n.status === '未开始').length,
  }
}

function nextId(nodes: ProgressNode[]): number {
  return nodes.reduce((max, n) => Math.max(max, n.id), 0) + 1
}

/**
 * 补录/登记节点：与台账里的重号只保留最早登记那条。
 * 整批为一个事务：落库失败整套撤回。idemKey 相同的重复提交只生效一次。
 */
export function registerNodes(
  inputs: RegisterInput[],
  idemKey: string,
  kv: KvStore = getKv(),
  now: string = nowISO(),
): { accepted: ProgressNode[]; droppedDuplicates: string[]; idempotentReplay: boolean } {
  const ledger = requireLedger(kv)
  const seen = kv.get<Record<string, { at: string }>>(KV_KEYS.idempotency) ?? {}
  if (idemKey && seen[idemKey]) {
    // 重复提交：不再改写台账，直接回放上一次语义。
    return { accepted: [], droppedDuplicates: [], idempotentReplay: true }
  }

  const candidates: ProgressNode[] = inputs.map((input, i) => ({
    id: nextId(ledger.nodes) + i,
    code: input.code.trim(),
    name: input.name.trim(),
    planDate: input.planDate ?? COLUMN_DEFAULTS['计划完成日'],
    actualDate: input.actualDate ?? '',
    planQty: Number(input.planQty ?? 0),
    actualQty: Number(input.actualQty ?? 0),
    status: input.status ?? '未开始',
    createdAt: input.createdAt ?? now,
    ordinal: 0,
  }))

  const beforeCodes = new Set(ledger.nodes.map((n) => n.code))
  const combined = reindex([...ledger.nodes, ...candidates])

  // reindex 后按重号留最早，统计哪些新提交被当作重复丢弃。
  const keptCodes = new Set(combined.map((n) => n.code))
  const dropped = candidates
    .filter((c) => beforeCodes.has(c.code) && keptCodes.has(c.code))
    .filter((c) => !combined.some((n) => n.id === c.id))
    .map((c) => c.code)

  const nextLedger: Ledger = { ...ledger, nodes: combined }
  const nextSeen = idemKey ? { ...seen, [idemKey]: { at: now } } : seen
  commit(kv, [
    [KV_KEYS.ledger, nextLedger],
    [KV_KEYS.idempotency, nextSeen],
  ])
  return { accepted: combined.filter((n) => candidates.some((c) => c.id === n.id)), droppedDuplicates: dropped, idempotentReplay: false }
}

/**
 * 修改计划完成日的越权/越级闸门。
 * 已完成节点：计划完成日已冻结，直接驳回，说明卡在“计划完成日冻结”这一步（建设单位也不行）。
 * 未完成节点：需要监理及以上；低于监理的越权改动直接驳回，说明卡在“权限不足”这一步。
 */
export function approvePlanDateChange(
  code: string,
  nextPlanDate: string,
  role: Role,
  kv: KvStore = getKv(),
  now: string = nowISO(),
): ApprovalResult {
  const ledger = requireLedger(kv)
  const node = ledger.nodes.find((n) => n.code === code)
  if (!node) {
    return {
      ok: false,
      code: 'REJECTED_NOT_FOUND',
      step: '定位节点',
      message: `节点 ${code} 不在台账中，改动驳回`,
    }
  }
  if (node.status === COMPLETED_STATUS) {
    return {
      ok: false,
      code: 'REJECTED_LOCKED',
      step: '计划完成日冻结校验',
      message: `节点 ${code} 已确认完成，计划完成日已冻结，禁止改动（含建设单位），导出不会修改该日期`,
    }
  }
  if (ROLE_RANK[role] < ROLE_RANK[MIN_ROLE_CHANGE_PLAN]) {
    return {
      ok: false,
      code: 'REJECTED_FORBIDDEN',
      step: '权限层级校验',
      message: `${role}无权调整计划完成日，需${MIN_ROLE_CHANGE_PLAN}及以上，越权改动驳回`,
    }
  }
  if (!isValidDate(nextPlanDate)) {
    return {
      ok: false,
      code: 'REJECTED_FORBIDDEN',
      step: '计划完成日格式校验',
      message: `计划完成日 ${nextPlanDate} 不是合法日期(YYYY-MM-DD)，改动驳回`,
    }
  }

  const updated = reindex(ledger.nodes.map((n) => (n.code === code ? { ...n, planDate: nextPlanDate } : n)))
  commit(kv, [[KV_KEYS.ledger, { ...ledger, nodes: updated, migratedAt: ledger.migratedAt } satisfies Ledger]])
  void now
  return {
    ok: true,
    code: 'APPROVED',
    step: '已落库重排',
    message: `节点 ${code} 计划完成日已由 ${node.planDate || '空'} 调整为 ${nextPlanDate}，并按计划完成日重新入库`,
  }
}

/** 确认完成：只写实际完成日/状态/完成量，绝不动计划完成日。 */
export function confirmComplete(
  code: string,
  actualDate: string,
  actualQty: number,
  kv: KvStore = getKv(),
): ApprovalResult {
  const ledger = requireLedger(kv)
  const node = ledger.nodes.find((n) => n.code === code)
  if (!node) {
    return { ok: false, code: 'REJECTED_NOT_FOUND', step: '定位节点', message: `节点 ${code} 不在台账中` }
  }
  if (!isValidDate(actualDate)) {
    return { ok: false, code: 'REJECTED_FORBIDDEN', step: '实际完成日校验', message: '实际完成日不合法，确认驳回' }
  }
  const nodes = ledger.nodes.map((n) =>
    n.code === code
      ? // 计划完成日原样保留：导出/确认都不许改它。
        { ...n, status: COMPLETED_STATUS, actualDate, actualQty }
      : n,
  )
  commit(kv, [[KV_KEYS.ledger, { ...ledger, nodes }]])
  return { ok: true, code: 'APPROVED', step: '确认完成', message: `节点 ${code} 已确认完成，计划完成日 ${node.planDate} 保持不变` }
}

/** 非完成类状态流转（开始节点→进行中、登记延期→已延期），同样不触碰计划完成日。 */
export function transitionStatus(
  code: string,
  next: Exclude<NodeStatus, '已完成'>,
  kv: KvStore = getKv(),
): ApprovalResult {
  const ledger = requireLedger(kv)
  const node = ledger.nodes.find((n) => n.code === code)
  if (!node) {
    return { ok: false, code: 'REJECTED_NOT_FOUND', step: '定位节点', message: `节点 ${code} 不在台账中` }
  }
  const nodes = ledger.nodes.map((n) => (n.code === code ? { ...n, status: next } : n))
  commit(kv, [[KV_KEYS.ledger, { ...ledger, nodes }]])
  return { ok: true, code: 'APPROVED', step: '状态流转', message: `节点 ${code} 已流转为「${next}」，计划完成日保持不变` }
}

export function listDeliveries(kv: KvStore = getKv()): DeliveryItem[] {
  requireLedger(kv)
  return kv.get<DeliveryItem[]>(KV_KEYS.deliveries) ?? []
}

export function appendDelivery(item: DeliveryItem, kv: KvStore = getKv()): DeliveryItem[] {
  const deliveries = listDeliveries(kv)
  const next = [...deliveries, item]
  kv.set(KV_KEYS.deliveries, next)
  return next
}

/** 交付清单里的偏差快照统一按节点台账的当前算法重算；已完成数也按台账重取，确保对得上。 */
export function recalcDeliveries(
  deliveries: DeliveryItem[],
  ledger: Ledger,
  at: string = nowISO(),
): DeliveryItem[] {
  return deliveries.map((item) => {
    const snapshot = item.deviationSnapshot
      .map((s) => {
        const node = ledger.nodes.find((n) => n.code === s.code)
        if (!node) {
          return null
        }
        return { code: node.code, deviationDays: deviationDays(node.planDate, node.actualDate, node.status, at.slice(0, 10)) }
      })
      .filter((x): x is { code: string; deviationDays: number | null } => x !== null)
    return {
      ...item,
      completedCount: ledger.nodes.filter((n) => n.status === COMPLETED_STATUS).length,
      deviationVersion: LEDGER_DEV_VERSION,
      deviationSnapshot: snapshot,
    }
  })
}

/** 算法升级后，对已生成的交付清单整体重算一遍（题面要求）。 */
export function recomputeExistingDeliveries(
  kv: KvStore = getKv(),
  now: string = nowISO(),
): DeliveryItem[] {
  const ledger = requireLedger(kv)
  const deliveries = listDeliveries(kv)
  const recalculated = recalcDeliveries(deliveries, ledger, now)
  kv.set(KV_KEYS.deliveries, recalculated)
  return recalculated
}
