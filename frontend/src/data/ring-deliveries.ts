/**
 * 掘进环次交付清单
 *
 * 进度节点导出打包完成后，把处理结论写进这里（按导出任务幂等，重复提交只写一次）。
 * 已完成节点数一律读 completedNodeCount()——和进度节点台账同一个函数，两边必须对得上；
 * 偏差概览按 DEVIATION_ALGORITHM_VERSION 统一算法现算，算法升级后 recalcDeliveries()
 * 把已生成的交付清单整体重算一遍。
 */

import { KV_KEYS, commitKv, readKv } from './kv-store'
import {
  DEVIATION_ALGORITHM_VERSION,
  STATUS,
  calcDeviationDays,
  completedNodeCount,
  readLedger,
  todayISO,
} from './progress-ledger'
import { getJob, type ExportJob } from './progress-export'

export type DeliveryRecord = {
  id: string
  jobId: string
  ringRef: string // 对应掘进环次/区间
  title: string
  conclusion: string
  nodeTotal: number
  backfilledIncluded: number
  completedNodes: number // 写入时的台账已完成数（与进度页同函数）
  completedNodesNow: number // 读取时现算的台账已完成数（对账用）
  matched: boolean
  avgDeviationDone: number // 已完成节点平均偏差天数
  maxDeviationActive: number // 在办节点最大偏差（按今天）
  missingCellRows: number // 导出时标了缺栏的行数
  volumes: number
  volumesPacked: number
  algorithm: string
  createdAt: string
  recalculatedAt?: string
}

const KEY = KV_KEYS.deliveries

function readAll(): DeliveryRecord[] {
  return readKv<DeliveryRecord[]>(KEY, [])
}

function writeAll(records: DeliveryRecord[]): void {
  commitKv([{ key: KEY, value: records }])
}

export type DeviationSummary = {
  avgDeviationDone: number
  maxDeviationActive: number
  completedNodes: number
}

/** 偏差概览：台账说了算，全平台唯一算法。 */
export function deviationSummary(today = todayISO()): DeviationSummary {
  const nodes = readLedger()
  const done = nodes.filter((n) => n.status === STATUS.done && n.actualDate)
  const active = nodes.filter((n) => n.status !== STATUS.done)
  const avg = done.length
    ? Math.round((done.reduce((sum, n) => sum + calcDeviationDays(n, today), 0) / done.length) * 10) / 10
    : 0
  const maxActive = active.reduce((max, n) => Math.max(max, calcDeviationDays(n, today)), 0)
  return { avgDeviationDone: avg, maxDeviationActive: maxActive, completedNodes: completedNodeCount() }
}

function countMissingCells(job: ExportJob): number {
  return job.volumes.reduce((sum, volume) => {
    if (!volume.packed) {
      return sum
    }
    return sum + volume.content.split('\n').slice(1).filter((line) => {
      const cols = line.split(',')
      return cols.length > 0 && cols[cols.length - 1]?.trim() !== ''
    }).length
  }, 0)
}

function buildRecord(job: ExportJob): DeliveryRecord {
  const nodes = readLedger()
  const summary = deviationSummary(job.today)
  const packed = job.volumes.filter((v) => v.packed)
  const backfillCount = nodes.filter((n) => n.backfilled).length
  const missingRows = countMissingCells(job)
  const completed = completedNodeCount()
  return {
    id: `DEL-${job.id}`,
    jobId: job.id,
    ringRef: '右线 R1 区间',
    title: `月底进度节点报建设单位交付清单（${job.today}）`,
    conclusion:
      `导出任务 ${job.id} 已全部打包完成：共 ${job.nodeIds.length} 个节点（含补录 ${backfillCount} 个），` +
      `分 ${job.volumes.length} 卷；已完成节点 ${completed} 个；` +
      (missingRows > 0 ? `其中 ${missingRows} 行存在缺栏，已在册子内逐列标注；` : '逐列体检无缺栏；') +
      `已完成节点计划完成日均已冻结，导出过程未做改动；偏差天数按台账算法 ${job.algorithm} 统一计算。`,
    nodeTotal: job.nodeIds.length,
    backfilledIncluded: backfillCount,
    completedNodes: completed,
    completedNodesNow: summary.completedNodes,
    matched: completed === summary.completedNodes,
    avgDeviationDone: summary.avgDeviationDone,
    maxDeviationActive: summary.maxDeviationActive,
    missingCellRows: missingRows,
    volumes: job.volumes.length,
    volumesPacked: packed.length,
    algorithm: job.algorithm,
    createdAt: new Date().toISOString(),
  }
}

/**
 * 导出处理结论写进掘进环次交付清单：
 * - 只有全卷打包完成的任务才能写；
 * - 按 jobId 幂等，重复提交只生效一次（已存在则只刷新对账数，不新建记录）。
 */
export function recordDelivery(jobId: string): {
  ok: boolean
  message: string
  step?: string
  record?: DeliveryRecord
} {
  const job = getJob(jobId)
  if (!job) {
    return { ok: false, step: '第1步 任务定位', message: `驳回：找不到导出任务 ${jobId}` }
  }
  if (job.status !== 'done' || !job.volumes.every((v) => v.packed)) {
    const packed = job.volumes.filter((v) => v.packed).length
    return {
      ok: false,
      step: '第2步 打包完成校验',
      message: `驳回：任务 ${jobId} 尚有卷未打完（${packed}/${job.volumes.length}），不许留半包，结论暂不写入交付清单`,
    }
  }
  const records = readAll()
  const index = records.findIndex((r) => r.jobId === jobId)
  const record = buildRecord(job)
  if (index >= 0) {
    // 幂等：保留首次结论与时间，只刷新台账对账数字。
    const refreshed: DeliveryRecord = {
      ...records[index],
      completedNodesNow: record.completedNodesNow,
      matched: record.matched,
      avgDeviationDone: record.avgDeviationDone,
      maxDeviationActive: record.maxDeviationActive,
    }
    const next = [...records]
    next[index] = refreshed
    try {
      writeAll(next)
    } catch (error) {
      return { ok: false, step: '第3步 清单落库', message: `驳回：清单刷新失败已撤回，${error instanceof Error ? error.message : '存储不可用'}` }
    }
    return { ok: true, record: refreshed, message: `交付结论已存在（${record.id}），重复提交不新建，仅刷新台账对账数` }
  }
  try {
    writeAll([record, ...records])
  } catch (error) {
    return { ok: false, step: '第3步 清单落库', message: `驳回：交付清单落库失败已撤回，${error instanceof Error ? error.message : '存储不可用'}` }
  }
  return { ok: true, record, message: `导出处理结论已写入掘进环次交付清单 ${record.id}` }
}

/** 对账：清单里记的已完成数 vs 台账现算，两边必须一致。 */
export function reconcileDeliveries(): { records: DeliveryRecord[]; allMatched: boolean; ledgerCompleted: number } {
  const ledgerCompleted = completedNodeCount()
  const records = readAll().map((record) => ({
    ...record,
    completedNodesNow: ledgerCompleted,
    matched: record.completedNodes === ledgerCompleted,
  }))
  return { records, allMatched: records.every((r) => r.matched), ledgerCompleted }
}

export function listDeliveries(): DeliveryRecord[] {
  const { records } = reconcileDeliveries()
  return records
}

/**
 * 偏差算法升级后：已生成的交付清单照新算法重算一遍（原子落库，失败回滚）。
 * 记录里的 completedNodes 是写入当时的事实快照不动，重算覆盖偏差概览与算法版本号。
 */
export function recalcDeliveries(now = new Date().toISOString()): {
  ok: boolean
  message: string
  recalculated: number
  records?: DeliveryRecord[]
} {
  const summary = deviationSummary()
  const records = readAll()
  if (records.length === 0) {
    return { ok: true, message: '暂无已生成的交付清单需要重算', recalculated: 0 }
  }
  const next = records.map((record) => ({
    ...record,
    avgDeviationDone: summary.avgDeviationDone,
    maxDeviationActive: summary.maxDeviationActive,
    completedNodesNow: summary.completedNodes,
    matched: record.completedNodes === summary.completedNodes,
    algorithm: DEVIATION_ALGORITHM_VERSION,
    recalculatedAt: now,
  }))
  try {
    writeAll(next)
  } catch (error) {
    return { ok: false, recalculated: 0, message: `重算结果落库失败已整套撤回：${error instanceof Error ? error.message : '存储不可用'}` }
  }
  return {
    ok: true,
    recalculated: next.length,
    records: next,
    message: `已按台账新算法 ${DEVIATION_ALGORITHM_VERSION} 重算 ${next.length} 份交付清单`,
  }
}
