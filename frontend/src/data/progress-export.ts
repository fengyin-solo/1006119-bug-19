/**
 * 进度节点导出打包（册子 = 分卷 CSV）
 *
 * 单一取数：列表页、导出文件、下载册子全部走 readLedger()/presentLedger()，
 * 包括补录节点；任何旁路取数都不允许。
 *
 * 打包语义：
 * - 节点在「创建导出任务」那一刻按计划完成日切成固定分卷并冻结 id 列表；
 * - packNextVolume 每次只打第一卷未完成的卷，已完成的卷原样保留 → 中断后从断掉的那一卷接着打；
 * - 提交幂等：同一份台账（指纹相同）重复提交只返回原任务，不新建、不重打；
 * - 冻结校验：打包时若发现已完成节点的计划完成日与任务快照不一致，整卷驳回，不留半包；
 * - 缺栏逐列标注：必填栏为空的单元格写「【缺栏】」，并在「缺栏列」里逐列列出列名。
 */

import { KV_KEYS, commitKv, readKv } from './kv-store'
import {
  DEVIATION_ALGORITHM_VERSION,
  PROGRESS_COLUMNS,
  STATUS,
  calcDeviationDays,
  readLedger,
  todayISO,
  type ProgressNode,
} from './progress-ledger'

export const EXPORT_COLUMNS = [...PROGRESS_COLUMNS, '缺栏列'] as const
export const DEFAULT_VOLUME_SIZE = 10

export type VolumeStatus = {
  index: number // 从 1 开始
  label: string // 第1卷
  nodeIds: number[]
  packed: boolean
  filename: string
  content: string
  packedAt: string
}

export type ExportJob = {
  id: string
  createdAt: string
  today: string
  volumeSize: number
  nodeIds: number[] // 任务快照：提交那一刻的节点顺序与 id
  planDateSnapshot: Record<number, string> // 已完成节点的计划日快照（冻结校验用）
  fingerprint: string
  volumes: VolumeStatus[]
  status: 'packing' | 'done' | 'rejected'
  finishedAt: string
  lastError: string
  algorithm: string
}

export type JobResult = {
  ok: boolean
  message: string
  step?: string
  job?: ExportJob
  resumed?: boolean
  duplicated?: boolean
}

const JOBS_KEY = KV_KEYS.exportJobs

function readJobs(): ExportJob[] {
  return readKv<ExportJob[]>(JOBS_KEY, [])
}

function writeJobs(jobs: ExportJob[]): void {
  commitKv([{ key: JOBS_KEY, value: jobs }])
}

export function listJobs(): ExportJob[] {
  return readJobs()
}

export function getJob(id: string): ExportJob | undefined {
  return readJobs().find((job) => job.id === id)
}

/** 台账指纹：节点 id + 更新时间无关，按「编号|计划日|实际日|状态|实际量|补录」拼哈希，重复提交据此识别。 */
export function ledgerFingerprint(nodes: ProgressNode[]): string {
  const body = nodes
    .map((n) => [n.nodeCode, n.planDate, n.actualDate, n.status, n.actualAmount, n.backfilled ? 1 : 0].join('|'))
    .join(';')
  let hash = 0
  for (let i = 0; i < body.length; i += 1) {
    hash = (hash << 5) - hash + body.charCodeAt(i)
    hash |= 0
  }
  return `fp-${(hash >>> 0).toString(16)}-${nodes.length}`
}

/** 导出/册子必填栏体检：已完成要交实际完成日和实际量；在办（进行/延期）也要有实际掘进量。 */
export function missingColumns(node: ProgressNode): string[] {
  const missing: string[] = []
  if (!node.nodeCode) missing.push('节点编号')
  if (!node.nodeName) missing.push('节点名称')
  if (!node.planDate) missing.push('计划完成日')
  if (node.status === STATUS.done) {
    if (!node.actualDate) missing.push('实际完成日')
    if (!Number(node.actualAmount)) missing.push('实际掘进量')
  }
  if (node.status === STATUS.inProgress || node.status === STATUS.delayed) {
    if (!Number(node.actualAmount)) missing.push('实际掘进量')
  }
  if (!Number(node.planAmount)) missing.push('计划掘进量')
  return missing
}

function csvCell(value: string | number, missing: boolean): string {
  const text = missing ? '【缺栏】' : String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 单行册子数据：列顺序固定，计划完成日整列永远在；缺哪栏单元格即标，末尾逐列汇总。 */
export function buildRow(node: ProgressNode, today: string): string[] {
  const missing = new Set(missingColumns(node))
  const values: (string | number)[] = [
    node.nodeCode,
    node.nodeName,
    node.planDate,
    node.actualDate,
    node.planAmount,
    node.actualAmount,
    calcDeviationDays(node, today),
    node.status,
    node.backfilled ? '补录' : '',
  ]
  const cells = EXPORT_COLUMNS.slice(0, -1).map((col, i) => csvCell(values[i], missing.has(col)))
  cells.push(missing.size ? [...missing].join('、') : '')
  return cells
}

export function buildVolumeCsv(nodes: ProgressNode[], volume: VolumeStatus, today: string): string {
  const header = [...EXPORT_COLUMNS].join(',')
  const lines = nodes.map((node) => buildRow(node, today).join(','))
  return `﻿${header}\n${lines.join('\n')}`
}

function makeVolumes(nodeIds: number[], size: number): VolumeStatus[] {
  const volumes: VolumeStatus[] = []
  for (let start = 0, index = 1; start < nodeIds.length; start += size, index += 1) {
    volumes.push({
      index,
      label: `第${index}卷`,
      nodeIds: nodeIds.slice(start, start + size),
      packed: false,
      filename: '',
      content: '',
      packedAt: '',
    })
  }
  return volumes
}

/**
 * 提交导出打包（幂等）：
 * - 同指纹已有任务（含中断的）→ 直接复用，从断点接着打，不重新建包；
 * - 新台账 → 建任务、切分卷、不打包（打包靠 packNextVolume 逐卷推进）。
 */
export function submitExportJob(options: { volumeSize?: number; now?: string } = {}): JobResult {
  const now = options.now ?? new Date().toISOString()
  const today = todayISO()
  const nodes = [...readLedger()].sort(
    (a, b) => Date.parse(`${a.planDate}T00:00:00Z`) - Date.parse(`${b.planDate}T00:00:00Z`),
  )
  if (nodes.length === 0) {
    return { ok: false, step: '第1步 台账取数', message: '驳回：进度节点台账为空，没有可导出的节点' }
  }
  const fingerprint = ledgerFingerprint(nodes)
  const jobs = readJobs()
  const existing = jobs.find((job) => job.fingerprint === fingerprint)
  if (existing) {
    return {
      ok: true,
      duplicated: true,
      resumed: existing.status === 'packing',
      job: existing,
      message:
        existing.status === 'packing'
          ? `该台账已提交过导出（任务 ${existing.id}），重复提交不另建包，从 ${nextVolumeLabel(existing)} 接着打`
          : `该台账的导出任务 ${existing.id} 已完成，重复提交只生效一次，直接复用原册子`,
    }
  }
  const size = Math.max(1, options.volumeSize ?? DEFAULT_VOLUME_SIZE)
  const job: ExportJob = {
    id: `JOB-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    createdAt: now,
    today,
    volumeSize: size,
    nodeIds: nodes.map((n) => n.id),
    planDateSnapshot: Object.fromEntries(
      nodes.filter((n) => n.status === STATUS.done).map((n) => [n.id, n.planDate]),
    ),
    fingerprint,
    volumes: makeVolumes(nodes.map((n) => n.id), size),
    status: 'packing',
    finishedAt: '',
    lastError: '',
    algorithm: DEVIATION_ALGORITHM_VERSION,
  }
  try {
    writeJobs([job, ...jobs])
  } catch (error) {
    return {
      ok: false,
      step: '第2步 任务落库',
      message: `驳回：导出任务落库失败已撤回，${error instanceof Error ? error.message : '存储不可用'}`,
    }
  }
  return { ok: true, job, message: `导出任务 ${job.id} 已建立，共 ${job.volumes.length} 卷，等待逐卷打包` }
}

function nextVolumeLabel(job: ExportJob): string {
  return job.volumes.find((v) => !v.packed)?.label ?? '已无待打卷'
}

/**
 * 打一卷：只推进第一个未完成卷。中断后再次调用仍是同一卷继续，已完成卷永不重打。
 * failPlanDateForId 仅用于演示「打包中途断了」：在内容生成后、落检查点前抛错，
 * 此时卷仍是未完成状态，下一次从这一卷接着打（不留半包）。
 */
export function packNextVolume(
  jobId: string,
  options: { failPlanDateForId?: number; now?: string } = {},
): JobResult {
  const now = options.now ?? new Date().toISOString()
  const jobs = readJobs()
  const index = jobs.findIndex((job) => job.id === jobId)
  if (index < 0) {
    return { ok: false, step: '第1步 任务定位', message: `驳回：找不到导出任务 ${jobId}` }
  }
  const job = jobs[index]
  if (job.status === 'done') {
    return { ok: true, job, message: `任务 ${job.id} 已全部打包完成，无需续打` }
  }
  if (job.status === 'rejected') {
    return { ok: false, step: '第2步 任务状态', job, message: `驳回：任务 ${job.id} 此前已被驳回：${job.lastError}` }
  }
  const volume = job.volumes.find((v) => !v.packed)
  if (!volume) {
    return { ok: false, step: '第2步 断点定位', job, message: '没有待打包的卷' }
  }

  const ledger = readLedger()
  const byId = new Map(ledger.map((n) => [n.id, n]))
  const nodes: ProgressNode[] = []
  for (const id of volume.nodeIds) {
    const node = byId.get(id)
    if (!node) {
      return rejectJob(jobs, index, job, volume, `第3步 台账取数：卷内节点 id=${id} 在台账中不存在（取数不一致），整卷驳回`)
    }
    nodes.push(node)
  }

  // 冻结校验：已经确认完成的节点，导出打包时不许改计划完成日。
  for (const node of nodes) {
    if (node.status === STATUS.done) {
      const frozen = job.planDateSnapshot[node.id]
      if (frozen !== undefined && frozen !== node.planDate) {
        return rejectJob(
          jobs,
          index,
          job,
          volume,
          `第4步 完成态冻结：已完成节点「${node.nodeCode}」的计划完成日被改动（${frozen} → ${node.planDate}），越权/越级改动驳回，卡在「${volume.label}打包前」，不留半包`,
        )
      }
    }
  }

  // 模拟打包中途断开：内容已算出，但检查点没写 → 下次仍从本卷续打。
  if (nodes.some((n) => n.id === options.failPlanDateForId)) {
    return {
      ok: false,
      step: `第5卷 ${volume.label} 写入`,
      job,
      message: `${volume.label}打包中途断开（模拟），检查点未写入；再次续打将从 ${volume.label} 开始，已完成各卷保留`,
    }
  }

  const filename = `${job.id}-${volume.label}.csv`
  const packed: VolumeStatus = {
    ...volume,
    packed: true,
    filename,
    content: buildVolumeCsv(nodes, volume, job.today),
    packedAt: now,
  }
  const nextJob: ExportJob = {
    ...job,
    volumes: job.volumes.map((v) => (v.index === volume.index ? packed : v)),
  }
  if (nextJob.volumes.every((v) => v.packed)) {
    nextJob.status = 'done'
    nextJob.finishedAt = now
  }
  try {
    const nextJobs = [...jobs]
    nextJobs[index] = nextJob
    writeJobs(nextJobs)
  } catch (error) {
    // commitKv 已回滚：本卷检查点没落下，任务仍是旧状态，下次续打本卷。
    return {
      ok: false,
      step: `第5卷 ${volume.label} 原子落库`,
      job,
      message: `${volume.label}落库失败已整体回滚：${error instanceof Error ? error.message : '存储不可用'}，可从本卷续打`,
    }
  }
  return {
    ok: true,
    job: nextJob,
    message:
      nextJob.status === 'done'
        ? `${volume.label}打包完成，全部 ${nextJob.volumes.length} 卷已齐，册子可下载`
        : `${volume.label}打包完成，下一卷从「${nextVolumeLabel(nextJob)}」继续`,
  }
}

function rejectJob(
  jobs: ExportJob[],
  index: number,
  job: ExportJob,
  volume: VolumeStatus,
  message: string,
): JobResult {
  const rejected: ExportJob = { ...job, status: 'rejected', lastError: message }
  const nextJobs = [...jobs]
  nextJobs[index] = rejected
  try {
    writeJobs(nextJobs)
  } catch {
    // 驳回状态也落不下时，至少把原因返回；原任务未被破坏（commitKv 回滚）。
  }
  return { ok: false, step: `打包 ${volume.label}`, job: rejected, message }
}

/** 整本进度节点清单 CSV：与分卷册子同一路取数、同一套缺栏标注（页面「导出清单」按钮用）。 */
export function exportProgressCsv(today = todayISO()): string {
  const nodes = [...readLedger()].sort(
    (a, b) => Date.parse(`${a.planDate}T00:00:00Z`) - Date.parse(`${b.planDate}T00:00:00Z`),
  )
  const header = [...EXPORT_COLUMNS].join(',')
  const lines = nodes.map((node) => buildRow(node, today).join(','))
  return `﻿${header}\n${lines.join('\n')}`
}

/** 把已经打好的各卷合成一份完整册子下载（未打好的卷不会混进来）。 */
export function assembleBooklet(jobId: string): { filename: string; content: string } | { ok: false; message: string } {
  const job = getJob(jobId)
  if (!job) {
    return { ok: false, message: `找不到导出任务 ${jobId}` }
  }
  const packed = job.volumes.filter((v) => v.packed)
  if (packed.length === 0) {
    return { ok: false, message: '还没有任何一卷打包完成' }
  }
  const sections = packed.map((v) => `# ${job.id} ${v.label}\n${v.content}`)
  return {
    filename: `进度节点报建设单位-册子-${job.id}.csv`,
    content: sections.join('\n'),
  }
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 单卷下载（断点状态下也能先拿已打好的卷）。 */
export function downloadVolume(jobId: string, volumeIndex: number): { ok: boolean; message: string } {
  const job = getJob(jobId)
  if (!job) {
    return { ok: false, message: `找不到导出任务 ${jobId}` }
  }
  const volume = job.volumes.find((v) => v.index === volumeIndex)
  if (!volume || !volume.packed) {
    return { ok: false, message: `第${volumeIndex}卷尚未打包完成，请先续打本卷` }
  }
  downloadText(volume.filename, volume.content)
  return { ok: true, message: `${volume.label}已下载` }
}

/** 一键续打到完（页面用）；任何一卷失败立即停下并返回卡点。 */
export function packAll(jobId: string, options: { failPlanDateForId?: number } = {}): JobResult {
  let last: JobResult = { ok: false, message: '未开始打包' }
  for (let guard = 0; guard < 100; guard += 1) {
    const current = getJob(jobId)
    if (!current) {
      return { ok: false, step: '第1步 任务定位', message: `找不到导出任务 ${jobId}` }
    }
    if (current.status === 'done') {
      return { ok: true, job: current, message: `任务 ${jobId} 全部 ${current.volumes.length} 卷已打包完成` }
    }
    last = packNextVolume(jobId, options)
    if (!last.ok) {
      return last
    }
  }
  return last
}
