import { appendDelivery, LEDGER_DEV_VERSION, listNodes, nodeStats, projectNode, requireLedger } from './repository'
import { KV_KEYS, getKv, type KvStore } from './storage'
import { todayISO } from './deviation'
import type { ExportPackage, NodeProjection, PackageVolume } from './types'

/** 列表页、导出文件、下载册子共用的列与取值顺序，谁也不准再各写一份。 */
export const EXPORT_COLUMNS = [
  '序号',
  '节点编号',
  '节点名称',
  '计划完成日',
  '实际完成日',
  '计划掘进量',
  '实际完成量',
  '偏差天数',
  '节点状态',
] as const

/** 缺列时写进该格的标记，保证整列不丢、还能逐列指出缺哪一栏。 */
export const MISSING_MARK = '【缺列：{column}】'

export interface ExportSnapshot {
  filename: string
  content: string
  columns: string[]
  rows: NodeProjection[]
  /** 本次导出整体缺失了哪些列（去重汇总），用于逐列标出。 */
  missingColumns: { column: string; codes: string[] }[]
  total: number
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/** 单条节点 → 与 EXPORT_COLUMNS 严格对齐的一行；缺字段用逐格标记补齐，绝不删列。 */
export function projectionToCells(p: NodeProjection): string[] {
  const valueByColumn: Record<string, string | number | null> = {
    序号: p.ordinal,
    节点编号: p.code,
    节点名称: p.name,
    计划完成日: p.planDate,
    实际完成日: p.actualDate,
    计划掘进量: p.planQty,
    实际完成量: p.actualQty,
    偏差天数: p.deviationDays,
    节点状态: p.status,
  }
  return EXPORT_COLUMNS.map((column) => {
    if (p.missingColumns.includes(column)) {
      // 计划完成日这类“整列丢失”的根因字段：在文件里逐列、逐行标出来。
      return MISSING_MARK.replace('{column}', column)
    }
    const v = valueByColumn[column]
    return csvCell(v)
  })
}

function buildRows(nowISO: string, kv: KvStore): NodeProjection[] {
  return listNodes(kv).map((n) => projectNode(n, nowISO))
}

/**
 * 统一导出：列表页另存、导出文件、下载册子都调它。
 * 输出固定 9 列；末尾附“缺列核对”区，把缺了哪一栏、涉及哪些节点逐列列出。
 */
export function buildExportSnapshot(
  kv: KvStore = getKv(),
  nowISO: string = todayISO(),
): ExportSnapshot {
  const rows = buildRows(nowISO, kv)
  const missingMap = new Map<string, string[]>()
  for (const p of rows) {
    for (const column of p.missingColumns) {
      const codes = missingMap.get(column) ?? []
      codes.push(p.code)
      missingMap.set(column, codes)
    }
  }

  const lines = [EXPORT_COLUMNS.join(',')]
  for (const p of rows) {
    lines.push(projectionToCells(p).join(','))
  }
  lines.push('')
  lines.push('缺列核对,以下栏位在台账中缺失，已逐行标记，未做删列处理')
  if (missingMap.size === 0) {
    lines.push('(无缺列)')
  } else {
    for (const [column, codes] of missingMap) {
      lines.push([column, `涉及节点 ${codes.length} 条`, codes.join(' ')].map(csvCell).join(','))
    }
  }

  return {
    filename: '进度节点-清单.csv',
    content: `﻿${lines.join('\n')}`,
    columns: [...EXPORT_COLUMNS],
    rows,
    missingColumns: [...missingMap.entries()].map(([column, codes]) => ({ column, codes })),
    total: rows.length,
  }
}

// ===== 分卷打包 / 断点续打 =====

function readPackages(kv: KvStore): ExportPackage[] {
  return kv.get<ExportPackage[]>(KV_KEYS.packages) ?? []
}

function writePackages(packages: ExportPackage[], kv: KvStore): void {
  kv.set(KV_KEYS.packages, packages)
}

function loadPackage(packageId: string, kv: KvStore): ExportPackage | undefined {
  return readPackages(kv).find((p) => p.packageId === packageId)
}

/** 新建打包任务：按每卷 volumeSize 条切卷，全部 pending；册子只有全卷 done 才能下。 */
export function startPackage(
  packageId: string,
  idemKey: string,
  volumeSize: number,
  kv: KvStore = getKv(),
  now: string = new Date().toISOString(),
): { pkg: ExportPackage; idempotentReplay: boolean } {
  const existing = readPackages(kv)
  const replay = existing.find((p) => p.idemKey === idemKey)
  if (replay) {
    // 重复提交同一个打包请求：只生效一次，回放到原任务，不再另开一包。
    return { pkg: replay, idempotentReplay: true }
  }
  if (existing.some((p) => p.packageId === packageId)) {
    throw new Error(`打包任务 ${packageId} 已存在`)
  }
  if (volumeSize <= 0) {
    throw new Error('每卷条数必须大于 0')
  }

  const nodes = listNodes(kv)
  const volumes: PackageVolume[] = []
  for (let i = 0; i < nodes.length; i += volumeSize) {
    const slice = nodes.slice(i, i + volumeSize)
    volumes.push({ index: volumes.length, status: 'pending', nodeIds: slice.map((n) => n.id), csv: '' })
  }
  const pkg: ExportPackage = {
    packageId,
    idemKey,
    volumeSize,
    status: volumes.every((v) => v.status === 'done') ? 'complete' : 'packing',
    volumes,
    lastFailedVolume: null,
    createdAt: now,
    updatedAt: now,
  }
  writePackages([...existing, pkg], kv)
  return { pkg, idempotentReplay: false }
}

export interface PackOptions {
  /** 测试用：打到第几卷（index）时抛错，模拟中途断了。 */
  failAtVolume?: number
  nowISO?: string
}

/**
 * 从断掉的那一卷接着打：只处理 pending 卷；卷内全部节点投影完成才置 done。
 * 任何一卷失败：该卷保持 pending、不写半成品（不留半包），记录断点后向上抛。
 * 已 done 的卷不重打。
 */
export function resumePackage(packageId: string, kv: KvStore = getKv(), options: PackOptions = {}): ExportPackage {
  const packages = readPackages(kv)
  const pos = packages.findIndex((p) => p.packageId === packageId)
  if (pos < 0) {
    throw new Error(`没有找到打包任务 ${packageId}`)
  }
  const pkg = packages[pos]
  const nowISO = options.nowISO ?? todayISO()
  const nodesById = new Map(listNodes(kv).map((n) => [n.id, n]))
  const at = new Date().toISOString()

  for (const volume of pkg.volumes) {
    if (volume.status === 'done') {
      continue
    }
    if (options.failAtVolume === volume.index) {
      // 断点：先不写这一卷，保持 pending（无半包），落盘断点信息。
      pkg.lastFailedVolume = volume.index
      pkg.updatedAt = at
      writePackages(packages, kv)
      throw new Error(`第 ${volume.index + 1} 卷打包中断`)
    }
    // 整卷在内存里构造完整后再一次性落到该卷，避免写了半卷。
    const lines = [`# 第${volume.index + 1}卷`, EXPORT_COLUMNS.join(',')]
    for (const id of volume.nodeIds) {
      const node = nodesById.get(id)
      if (!node) {
        pkg.lastFailedVolume = volume.index
        pkg.updatedAt = at
        writePackages(packages, kv)
        throw new Error(`第 ${volume.index + 1} 卷缺少节点 ${id}，该卷保持未完成`)
      }
      lines.push(projectionToCells(projectNode(node, nowISO)).join(','))
    }
    volume.csv = lines.join('\n')
    volume.status = 'done'
    pkg.updatedAt = at
    pkg.lastFailedVolume = null
    // 每完成一卷立即落盘，后续断了可从下一卷续。
    writePackages(packages, kv)
  }

  pkg.status = pkg.volumes.every((v) => v.status === 'done') ? 'complete' : 'packing'
  pkg.updatedAt = at
  writePackages(packages, kv)
  return pkg
}

/** 只有全部卷都 done 才允许合成册子下载；只要还有 pending/半包卷就驳回。 */
export function buildBooklet(packageId: string, kv: KvStore = getKv()): { filename: string; content: string } {
  const pkg = loadPackage(packageId, kv)
  if (!pkg) {
    throw new Error(`没有找到打包任务 ${packageId}`)
  }
  const pending = pkg.volumes.filter((v) => v.status !== 'done')
  if (pending.length > 0) {
    const first = pending[0].index + 1
    throw new Error(`册子未完成：第 ${first} 卷还是半包/未打，请从该卷续打后再下载`)
  }
  const content = pkg.volumes.map((v) => v.csv).join('\n\n')
  return { filename: `进度节点-册子-${packageId}.csv`, content: `﻿${content}` }
}

export function getPackage(packageId: string, kv: KvStore = getKv()): ExportPackage | undefined {
  return loadPackage(packageId, kv)
}

/**
 * 导出处理结论写进掘进环次交付清单：已完成节点数取台账口径（与进度页同源），
 * 偏差快照随包内节点按统一算法记录。
 */
export function recordExportConclusion(
  packageId: string,
  conclusion: string,
  kv: KvStore = getKv(),
  now: string = new Date().toISOString(),
) {
  requireLedger(kv)
  const stats = nodeStats(kv)
  const snapshotNow = now.slice(0, 10)
  const rows = buildRows(snapshotNow, kv)
  const completedSnapshot = rows
    .filter((r) => r.status === '已完成')
    .map((r) => ({ code: r.code, deviationDays: r.deviationDays }))
  const item = {
    id: Date.now(),
    packageId,
    at: now,
    exportedCount: rows.length,
    completedCount: stats.completed,
    conclusion,
    deviationVersion: LEDGER_DEV_VERSION,
    deviationSnapshot: completedSnapshot,
  }
  return appendDelivery(item, kv)
}
