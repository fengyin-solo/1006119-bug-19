/**
 * 进度节点领域回归测试：在 Node 里用内存 KV 跑，不依赖浏览器。
 * 运行：npm test（经 esbuild 打包到 scripts/.tmp 后由 node 执行）
 */
import {
  buildBooklet,
  buildExportSnapshot,
  recordExportConclusion,
  resumePackage,
  startPackage,
} from '../src/data/progress/export'
import {
  LEDGER_DEV_VERSION,
  appendDelivery,
  confirmComplete,
  listDeliveries,
  migrate,
  nodeStats,
  projectAll,
  recalcDeliveries,
  registerNodes,
  requireLedger,
  approvePlanDateChange,
  transitionStatus,
  type Ledger,
} from '../src/data/progress/repository'
import { bindKv, createMemoryKv, KV_KEYS } from '../src/data/progress/storage'
import { deviationDays, DEVIATION_VERSION } from '../src/data/progress/deviation'
import type { DeliveryItem, ProgressNode } from '../src/data/progress/types'

let passed = 0
let failed = 0
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`✗ ${msg}`)
  }
}
function eq<T>(actual: T, expected: T, msg: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`)
}

const NOW = '2026-10-06'
function freshKv() {
  const kv = createMemoryKv()
  bindKv(kv)
  return kv
}

// 1. 迁移：库内 24 条真实节点 + 1 条重复登记 + 表单补录 3 条 = 28 条原始；去重后台账 27（页面在办/在册口径）。
{
  const kv = freshKv()
  const r = migrate(kv, '2026-10-06T00:00:00.000Z')
  eq(r.mergedFromForm, 3, '迁移并入 3 条补录节点')
  eq(r.deduped, 1, '迁移识别 1 条重号')
  const nodes = requireLedger(kv).nodes
  eq(nodes.length, 27, '迁移去重后台账为 27 条（28 原始 - 1 重号）')
  assert(nodes.some((n) => n.code === 'PROG-0025'), '补录节点 PROG-0025 已并入台账')
  assert(nodes.some((n) => n.code === 'PROG-0027'), '补录节点 PROG-0027 已并入台账')
  // 重号只留最早：保留 id=1（08-20），丢弃 id=91（09-10）
  const dup = nodes.filter((n) => n.code === 'PROG-0002')
  eq(dup.length, 1, 'PROG-0002 只剩一条')
  eq(dup[0].id, 2, '重号保留最早登记那条（id=2）')
  // PROG-0005 计划完成日只在表单里，迁移应并回为 2026-09-14
  eq(nodes.find((n) => n.code === 'PROG-0005')?.planDate, '2026-09-14', '只在表单里的计划完成日并回台账')
}

// 2. 存量节点按计划完成日重新入库：序号升序、空日期垫底。
{
  const kv = freshKv()
  migrate(kv)
  const nodes = requireLedger(kv).nodes
  let ok = true
  for (let i = 1; i < nodes.length; i++) {
    ok = ok && nodes[i - 1].ordinal === i
  }
  assert(ok, '序号连续从 1 开始')
  eq(nodes[0].code, 'PROG-0001', '计划完成日最早的排第一')
}

// 3. 偏差天数统一算法：已完成按实际-计划，未完成按今天-计划，缺失为 null。
{
  eq(deviationDays('2026-09-05', '2026-09-02', '已完成', NOW), -3, '提前完成偏差为负')
  eq(deviationDays('2026-09-08', '2026-09-10', '已完成', NOW), 2, '逾期完成偏差为正')
  eq(deviationDays('2026-09-28', '', '进行中', NOW), 8, '在办节点按今天-计划')
  eq(deviationDays('', '2026-09-15', '已完成', NOW), null, '缺计划完成日偏差为 null 而非 0')
  eq(deviationDays('2026-10-10', '', '未开始', NOW), -4, '未到期偏差为负')
}

// 4. 列表投影、导出快照读同一份；导出 9 列齐全、27 行、补录在列、缺列逐格标注。
{
  const kv = freshKv()
  migrate(kv)
  const rows = projectAll(NOW, kv)
  const snap = buildExportSnapshot(kv, NOW)
  eq(rows.length, snap.total, '列表与导出行数一致')
  eq(snap.total, 27, '导出共 27 行（含补录）')
  eq(snap.columns.length, 9, '导出固定 9 列，计划完成日整列不丢')
  assert(snap.columns.includes('计划完成日'), '计划完成日列存在')
  assert(snap.columns.includes('实际完成量'), '列名为实际完成量')
  const headerLine = snap.content.split('\n')[0]
  eq(headerLine.split(',').length, 9, '表头 9 列')
  const codesInExport = snap.rows.map((r) => r.code)
  assert(codesInExport.includes('PROG-0026'), '补录节点 PROG-0026 一并导出')
  // PROG-0005 已在迁移补齐计划日；当前没有缺列（构造数据全合法）。缺列机制单独验证。
  const fresh: ProgressNode = {
    id: 999, code: 'PROG-X', name: '缺计划日', planDate: '', actualDate: '',
    planQty: 0, actualQty: 0, status: '进行中', createdAt: '2026-10-01T00:00:00.000Z', ordinal: 1,
  }
  const badLedger: Ledger = { version: 1, migratedAt: NOW, nodes: [fresh] }
  kv.set(KV_KEYS.ledger, badLedger)
  const badSnap = buildExportSnapshot(kv, NOW)
  assert(badSnap.missingColumns.some((m) => m.column === '计划完成日'), '缺列汇总能识别计划完成日')
  const line = badSnap.content.split('\n').find((l) => l.includes('PROG-X')) ?? ''
  assert(line.includes('【缺列：计划完成日】'), '缺列在文件里逐格标出，未删列')
  eq(line.split(',').length, 9, '缺列行仍是 9 列')
}

// 5. 已完成节点计划完成日冻结：任何角色都驳回，并指出卡点。
{
  const kv = freshKv()
  migrate(kv)
  const owner = approvePlanDateChange('PROG-0001', '2026-12-01', '建设单位', kv)
  eq(owner.ok, false, '建设单位改已完成节点计划日被驳回')
  eq(owner.code, 'REJECTED_LOCKED', '驳回原因为冻结')
  assert(owner.step.includes('冻结'), `说明卡在冻结步骤：${owner.step}`)
  const unchanged = requireLedger(kv).nodes.find((n) => n.code === 'PROG-0001')
  eq(unchanged?.planDate, '2026-09-03', '已完成节点计划日原样保留')
  // 未完成：班组越权被驳，监理通过。
  const crew = approvePlanDateChange('PROG-0016', '2026-10-20', '班组', kv)
  eq(crew.ok, false, '班组越级改计划日被驳回')
  eq(crew.code, 'REJECTED_FORBIDDEN', '驳回原因为权限不足')
  const sup = approvePlanDateChange('PROG-0016', '2026-10-20', '监理', kv)
  eq(sup.ok, true, '监理可调整未完成节点计划日')
  eq(requireLedger(kv).nodes.find((n) => n.code === 'PROG-0016')?.planDate, '2026-10-20', '批准后落库并重排')
}

// 6. 确认完成不改计划完成日。
{
  const kv = freshKv()
  migrate(kv)
  const before = requireLedger(kv).nodes.find((n) => n.code === 'PROG-0011')
  const res = confirmComplete('PROG-0011', '2026-10-05', 300, kv)
  eq(res.ok, true, '确认完成成功')
  const after = requireLedger(kv).nodes.find((n) => n.code === 'PROG-0011')
  eq(after?.planDate, before?.planDate, '确认完成不改计划完成日')
  eq(after?.status, '已完成', '状态置为已完成')
  eq(after?.actualDate, '2026-10-05', '写入实际完成日')
}

// 7. 分卷打包：中途断卷不留半包、可从断卷续打、全部完成才出册子、重复提交只一次。
{
  const kv = freshKv()
  migrate(kv)
  const first = startPackage('PKG-T', 'idem-t', 10, kv, '2026-10-06T00:00:00.000Z')
  eq(first.pkg.volumes.length, 3, '27 条按每卷 10 条切成 3 卷')
  // 重复提交（相同幂等键）只生效一次。
  const again = startPackage('PKG-OTHER', 'idem-t', 10, kv)
  eq(again.idempotentReplay, true, '相同幂等键回放原任务，不另开包')
  // 第 2 卷（index=1）中断。
  let threw = false
  try {
    resumePackage('PKG-T', kv, { failAtVolume: 1, nowISO: NOW })
  } catch {
    threw = true
  }
  assert(threw, '打到第 2 卷时中断抛错')
  const packAfterFail = (kv.get<{ packageId: string; volumes: { status: string; csv: string }[]; lastFailedVolume: number | null }[]>(KV_KEYS.packages) ?? []).find((p) => p.packageId === 'PKG-T')
  eq(packAfterFail.volumes[0].status, 'done', '第 1 卷已成卷')
  eq(packAfterFail.volumes[1].status, 'pending', '第 2 卷保持 pending，不留半包')
  eq(packAfterFail.volumes[1].csv, '', '断卷无半卷内容')
  eq(packAfterFail.lastFailedVolume, 1, '记录断点为第 2 卷')
  // 册子此时必须被驳回。
  let bookletBlocked = false
  try {
    buildBooklet('PKG-T', kv)
  } catch {
    bookletBlocked = true
  }
  assert(bookletBlocked, '还有半包卷时禁止下载册子')
  // 从断掉那一卷续打。
  const resumed = resumePackage('PKG-T', kv, { nowISO: NOW })
  eq(resumed.status, 'complete', '续打后全部卷完成')
  assert(resumed.volumes.every((v) => v.status === 'done'), '三卷全部成卷')
  const booklet = buildBooklet('PKG-T', kv)
  const bookletLines = booklet.content.split('\n')
  assert(bookletLines.join('\n').includes('PROG-0025'), '册子里含补录节点')
  assert((booklet.content.match(/计划完成日/g) ?? []).length >= 3, '每卷都带计划完成日列头，整列不丢')
}

// 8. 交付清单：写入结论、已完成数与台账同源；两处计数一致。
{
  const kv = freshKv()
  migrate(kv)
  const stats = nodeStats(kv)
  recordExportConclusion('PKG-A', '已出册，无缺列', kv, '2026-10-06T12:00:00.000Z')
  const deliveries = listDeliveries(kv)
  const latest = deliveries[deliveries.length - 1]
  eq(latest.completedCount, stats.completed, '交付清单已完成数=台账已完成数')
  eq(latest.exportedCount, 27, '导出条数为 27（含补录）')
  eq(latest.deviationVersion, LEDGER_DEV_VERSION, '新清单使用新偏差算法版本')
  // 交付清单快照里的偏差与投影一致（同源算法）。
  const rows = projectAll('2026-10-06', kv).filter((r) => r.status === '已完成')
  const byCode = new Map(rows.map((r) => [r.code, r.deviationDays]))
  let consistent = true
  for (const s of latest.deviationSnapshot) {
    if (byCode.get(s.code) !== s.deviationDays) {
      consistent = false
    }
  }
  assert(consistent, '交付清单偏差快照与台账算法一致')
}

// 9. 存量交付清单按新算法重算（旧口径把缺日期当 0，重算后应为 null/真实值）。
{
  const kv = freshKv()
  migrate(kv)
  // 迁移已把 legacy 清单重算一次；再手动构造一条旧清单验证 recalcDeliveries。
  const ledger = requireLedger(kv)
  const stale: DeliveryItem[] = [{
    id: 555, packageId: 'OLD', at: '2026-09-30T00:00:00.000Z', exportedCount: 21, completedCount: 10,
    conclusion: '旧', deviationVersion: 'legacy:missing-date-as-zero',
    deviationSnapshot: [
      { code: 'PROG-0001', deviationDays: 0 },
      { code: 'PROG-0003', deviationDays: 0 },
    ],
  }]
  const recalculated = recalcDeliveries(stale, ledger, '2026-10-06T00:00:00.000Z')
  eq(recalculated[0].deviationVersion, DEVIATION_VERSION, '重算后算法版本更新')
  const snap = new Map(recalculated[0].deviationSnapshot.map((s) => [s.code, s.deviationDays]))
  eq(snap.get('PROG-0001'), -1, 'PROG-0001 按实际-计划重算为 -1（09-02 vs 09-03）')
  eq(snap.get('PROG-0003'), 2, 'PROG-0003 重算为 2（09-10 vs 09-08）')
  eq(recalculated[0].completedCount, nodeStats(kv).completed, '重算同步台账已完成数')
}

// 10. 登记整批原子、失败回滚；幂等重复提交只生效一次。
{
  const kv = freshKv()
  migrate(kv)
  const before = requireLedger(kv).nodes.length
  const r1 = registerNodes(
    [{ code: 'PROG-100', name: '新节点', planDate: '2026-11-01', planQty: 1, status: '未开始' }],
    'k1', kv, '2026-10-06T10:00:00.000Z',
  )
  eq(r1.idempotentReplay, false, '首次登记生效')
  eq(requireLedger(kv).nodes.length, before + 1, '台账增加 1 条')
  const r2 = registerNodes(
    [{ code: 'PROG-101', name: '不应入库', planDate: '2026-11-02' }],
    'k1', kv, '2026-10-06T11:00:00.000Z',
  )
  eq(r2.idempotentReplay, true, '相同幂等键重复提交不重复生效')
  eq(requireLedger(kv).nodes.length, before + 1, '重复提交后台账条数不变')
  // 重号登记保留最早。
  registerNodes(
    [{ code: 'PROG-0001', name: '想覆盖最早节点', planDate: '2026-12-31', status: '已完成' }],
    'k2', kv, '2026-10-07T00:00:00.000Z',
  )
  const kept = requireLedger(kv).nodes.filter((n) => n.code === 'PROG-0001')
  eq(kept.length, 1, '重号仍只有一条')
  eq(kept[0].createdAt, '2026-08-20T01:00:00.000Z', '保留最早登记，新提交被丢弃')
}

// 11. 落库失败整套撤回：注入会抛错的 KV。
{
  const kv = createMemoryKv()
  const failing = {
    ...kv,
    set(key: string, value: unknown) {
      if (key === KV_KEYS.ledger) {
        throw new Error('磁盘满')
      }
      kv.set(key, value)
    },
  }
  bindKv(failing)
  let rolled = false
  try {
    migrate(failing)
  } catch {
    rolled = true
  }
  assert(rolled, '迁移落库失败抛错')
  eq(failing.get(KV_KEYS.migrated), null, '失败后不写迁移标记（整套撤回）')
}

// 12. 状态流转不改计划日。
{
  const kv = freshKv()
  migrate(kv)
  const before = requireLedger(kv).nodes.find((n) => n.code === 'PROG-0011')?.planDate
  transitionStatus('PROG-0011', '已延期', kv)
  const after = requireLedger(kv).nodes.find((n) => n.code === 'PROG-0011')
  eq(after?.status, '已延期', '登记延期生效')
  eq(after?.planDate, before, '延期流转不改计划完成日')
}

// 13. appendDelivery 幂等辅助存在性（确保导出结论可写进掘进环次清单）。
{
  const kv = freshKv()
  migrate(kv)
  const item: DeliveryItem = {
    id: 1, packageId: 'X', at: NOW, exportedCount: 27, completedCount: nodeStats(kv).completed,
    conclusion: 'c', deviationVersion: LEDGER_DEV_VERSION, deviationSnapshot: [],
  }
  appendDelivery(item, kv)
  eq(listDeliveries(kv).length, 2, '交付清单可追加（迁移遗留 1 条 + 新 1 条）')
}

console.log(`\n进度节点领域测试：通过 ${passed}，失败 ${failed}`)
if (failed > 0) {
  process.exit(1)
}
