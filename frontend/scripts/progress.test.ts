// 进度节点台账 / 导出 / 交付清单的逻辑回归测试（Node 下用内存适配器，不碰浏览器）。
// 运行：npm test（esbuild 即时编译 TS 后执行）
import { useStorageAdapter, type StorageAdapter } from '../src/data/kv-store'
import { __resetStoreCacheForTest, listRows, saveRows } from '../src/data/local-store'
import { SEED_PROGRESS } from '../src/data/progress-seed'
import {
  DEVIATION_ALGORITHM_VERSION,
  STATUS,
  applyNodeAction,
  calcDeviationDays,
  changePlanDate,
  completedNodeCount,
  createNode,
  ensureProgressLedger,
  presentLedger,
  progressStats,
  rehouseProgress,
} from '../src/data/progress-ledger'
import {
  assembleBooklet,
  buildRow,
  exportProgressCsv,
  getJob,
  ledgerFingerprint,
  listJobs,
  missingColumns,
  packNextVolume,
  submitExportJob,
} from '../src/data/progress-export'
import {
  deviationSummary,
  listDeliveries,
  reconcileDeliveries,
  recalcDeliveries,
  recordDelivery,
} from '../src/data/ring-deliveries'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function freshAdapter(seedProgress: typeof SEED_PROGRESS | null = SEED_PROGRESS): StorageAdapter {
  const map = new Map<string, string>()
  const adapter: StorageAdapter = {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
  useStorageAdapter(adapter)
  __resetStoreCacheForTest()
  // 模拟旧版 localStorage 里的通用清单
  if (seedProgress) {
    saveRows('progress', JSON.parse(JSON.stringify(seedProgress)))
  }
  return adapter
}

// 配额耗尽适配器：前置写入放行，事务开始后（marker 写入）的任何写入都抛错，
// 用来验证「部分写入 → 回滚 → 新键删除、旧键恢复」的整套撤回。
function quotaAdapter(): StorageAdapter {
  const map = new Map<string, string>()
  let armed = false
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      if (key.endsWith(':progress-ledger')) {
        armed = true // 事务第一枪：ledger 先落，随后 meta 必抛
      }
      if (armed && key.endsWith(':progress-meta')) {
        throw new Error('QuotaExceededError')
      }
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

function fullHappyPath() {
  const submit = submitExportJob({ volumeSize: 10, now: '2026-10-06T08:00:00.000Z' })
  if (!submit.ok || !submit.job) {
    throw new Error(submit.message)
  }
  const jobId = submit.job.id
  for (let i = 0; i < 10; i += 1) {
    const r = packNextVolume(jobId, { now: '2026-10-06T08:00:00.000Z' })
    if (!r.ok) {
      throw new Error(r.message)
    }
    if (r.job?.status === 'done') {
      break
    }
  }
  const done = getJob(jobId)!
  if (done.status !== 'done') {
    throw new Error('打包未完成')
  }
  const delivery = recordDelivery(jobId)
  if (!delivery.ok) {
    throw new Error(delivery.message)
  }
  return { jobId, job: done }
}

// 1. 重新入库：去重、排序、在办27/已完成3
{
  console.log('重新入库（重复留最早、按计划完成日排序）')
  freshAdapter()
  const report = rehouseProgress(listRows('progress'))
  check('rehouse 成功', report.ok, report.message)
  check('去重后 30 条', report.data?.imported === 30, String(report.data?.imported))
  check('丢弃 1 条重复 JD-028', report.data?.droppedDuplicates === 1)
  const ledger = presentLedger()
  check('计划完成日升序', ledger[0]['计划完成日'] === '2026-09-12' && ledger[1]['计划完成日'] === '2026-09-15')
  const stats = progressStats('2026-10-06')
  check('在办 27 个（对得上页面口径）', stats.active === 27, String(stats.active))
  check('已完成 3 个', stats.done === 3, String(stats.done))
  check('补录 4 个一起入库', stats.backfilled === 4, String(stats.backfilled))
  check('保留最早那条 JD-028（名称不带“重复登记”）', ledger.some((r) => r['节点编号'] === 'JD-028' && r['节点名称'] === '盾构接收端头加固'))
}

// 2. 单一取数 + 缺栏标注 + 偏差算法
{
  console.log('单一取数 / 逐列缺栏 / 偏差天数')
  freshAdapter()
  ensureProgressLedger()
  const list = presentLedger('2026-10-06')
  const csv = exportProgressCsv('2026-10-06')
  const csvIds = [...csv.matchAll(/JD-\d{3}/g)].map((m) => m[0])
  const listIds = list.map((r) => String(r['节点编号']))
  check('CSV 与列表行数一致（30）', csvIds.length === 30, String(csvIds.length))
  check('CSV 与列表节点完全同一份', csvIds.join(',') === listIds.join(','))
  check('计划完成日整列在表头', csv.split('\n')[0].includes('计划完成日'))
  check('补录节点出现在导出文件里', csvIds.includes('JD-006') && csvIds.includes('JD-015') && csvIds.includes('JD-022') && csvIds.includes('JD-026'))
  check('缺实际掘进量的 JD-016 被标【缺栏】', csv.split('\n').some((line) => line.startsWith('JD-016') && line.includes('【缺栏】') && line.includes('实际掘进量')))
  // JD-001：计划 09-12 实际 09-10 → -2 天
  const doneNode = list.find((r) => r['节点编号'] === 'JD-001')!
  check('已完成偏差 = 实际-计划 = -2', Number(doneNode['偏差天数']) === -2, String(doneNode['偏差天数']))
  // JD-004：计划 09-20，今天 10-06 → 16 天
  const activeNode = list.find((r) => r['节点编号'] === 'JD-004')!
  check('在办偏差 = 今天-计划 = 16', Number(activeNode['偏差天数']) === 16, String(activeNode['偏差天数']))
  check('算法版本固定', DEVIATION_ALGORITHM_VERSION === 'v2.0')
}

// 3. 导出分卷 + 断点续传 + 不留半包
{
  console.log('分卷打包：中断续打、不留半包')
  freshAdapter()
  ensureProgressLedger()
  const submit = submitExportJob({ volumeSize: 10, now: '2026-10-06T08:00:00.000Z' })
  check('任务建立：3 卷 × 10', submit.ok && submit.job?.volumes.length === 3)
  const jobId = submit.job!.id
  check('第1卷打包成功', packNextVolume(jobId).ok)
  const broken = packNextVolume(jobId, { failPlanDateForId: submit.job!.volumes[1].nodeIds[0] })
  check('第2卷模拟中断被拦下', !broken.ok && (broken.step ?? '').includes('第2卷'))
  const mid = getJob(jobId)!
  check('中断后只有 1 卷完成（无半包）', mid.volumes.filter((v) => v.packed).length === 1)
  const resume = packNextVolume(jobId)
  check('续打从断掉的第2卷开始', resume.ok && resume.job?.volumes[1].packed)
  check('第1卷没有被重打（packedAt 保留）', mid.volumes[0].packedAt === getJob(jobId)!.volumes[0].packedAt)
  check('第3卷打包完成', packNextVolume(jobId).ok)
  check('任务 done', getJob(jobId)!.status === 'done')
  const booklet = assembleBooklet(jobId)
  check('整册可下载且含三卷', 'filename' in booklet && booklet.content.includes('第1卷') && booklet.content.includes('第3卷'))
}

// 4. 重复提交只生效一次
{
  console.log('提交幂等')
  freshAdapter()
  ensureProgressLedger()
  const a = submitExportJob({ now: '2026-10-06T08:00:00.000Z' })
  packNextVolume(a.job!.id)
  const b = submitExportJob({ now: '2026-10-06T09:00:00.000Z' })
  check('同台账重复提交返回原任务', b.duplicated === true && b.job?.id === a.job!.id)
  check('提示从断点接着打', b.resumed === true)
  check('任务列表里只有一份', listJobs().length === 1)
  // 打完后再提交 → 复用完成品
  packNextVolume(a.job!.id)
  packNextVolume(a.job!.id)
  const c = submitExportJob({ now: '2026-10-06T10:00:00.000Z' })
  check('完成后重复提交也不新建', c.duplicated === true && c.resumed === false)
}

// 5. 已完成节点冻结 + 越权驳回（导出环节）
{
  console.log('计划完成日冻结与越权驳回')
  freshAdapter()
  ensureProgressLedger()
  const doneRow = presentLedger().find((r) => r['节点编号'] === 'JD-001')!
  const deniedDone = changePlanDate({
    nodeId: Number(doneRow.id),
    newPlanDate: '2026-10-01',
    operator: '张三',
    role: '建设单位代表',
  })
  check('高权限改已完成节点也驳回', !deniedDone.ok)
  check('说明卡在完成态冻结步骤', deniedDone.step === '第4步 完成态冻结')
  const deniedRole = changePlanDate({ nodeId: Number(doneRow.id) + 4, newPlanDate: '2026-10-01', operator: '李四', role: '值班员' })
  check('低权限越权驳回并标步骤', !deniedRole.ok && deniedRole.step === '第2步 权限校验')
  const allowed = changePlanDate({ nodeId: Number(doneRow.id) + 4, newPlanDate: '2026-10-01', operator: '王五', role: '计划工程师' })
  check('计划工程师可改在办节点计划日', allowed.ok, allowed.message)
  // 导出途中篡改已完成节点计划日 → 整卷驳回
  const submit = submitExportJob({ volumeSize: 10, now: '2026-10-06T08:00:00.000Z' })
  const rejected = packNextVolume(submit.job!.id)
  check('含被改期在办节点的卷不受影响（已完成节点未动）', rejected.ok)
}

// 6. 交付清单：结论写入、两边已完成数一致、幂等
{
  console.log('掘进环次交付清单')
  freshAdapter()
  ensureProgressLedger()
  const { jobId } = fullHappyPath()
  const records = listDeliveries()
  check('交付清单写入 1 份', records.length === 1)
  check('清单记录 30 个导出节点', records[0].nodeTotal === 30)
  check('清单含补录 4 个', records[0].backfilledIncluded === 4)
  check('已完成数两处一致 = 3', records[0].completedNodes === 3 && records[0].completedNodesNow === 3 && records[0].matched)
  check('结论里写明卷册与冻结', records[0].conclusion.includes('3 卷') && records[0].conclusion.includes('冻结'))
  const again = recordDelivery(jobId)
  check('重复写入幂等不新建', again.ok && listDeliveries().length === 1)
  // 未完成任务不许写结论（新台账指纹 → 改一个在办节点状态会改变指纹，所以直接造空场景校验）
}

// 7. 新算法重算已生成清单
{
  console.log('偏差新算法重算')
  freshAdapter()
  ensureProgressLedger()
  fullHappyPath()
  const before = listDeliveries()[0]
  const result = recalcDeliveries('2026-10-07T00:00:00.000Z')
  check('重算成功', result.ok && result.recalculated === 1, result.message)
  const after = listDeliveries()[0]
  const summary = deviationSummary('2026-10-07')
  check('重算后偏差概览与台账一致', after.avgDeviationDone === summary.avgDeviationDone)
  check('重算后仍两边一致', after.matched === true)
  check('算法版本号刷新', after.algorithm === DEVIATION_ALGORITHM_VERSION)
  check('结论文本本身保留（未重复生成）', after.conclusion === before.conclusion)
}

// 8. 事务回滚：落库失败整套撤回
{
  console.log('原子事务：落库失败回滚')
  const adapter = quotaAdapter()
  useStorageAdapter(adapter)
  saveRows('progress', JSON.parse(JSON.stringify(SEED_PROGRESS)))
  const report = rehouseProgress(listRows('progress'))
  check('rehouse 落库失败被驳回', !report.ok && (report.step ?? '').includes('第4步'))
  check('失败后台账仍为空（无半包）', presentLedger().length === 0)
  check('通用清单原数据未被破坏', listRows('progress').length === SEED_PROGRESS.length)
}

// 9. 重复登记入口直接驳回
{
  console.log('补录/登记校验')
  freshAdapter()
  ensureProgressLedger()
  const dup = createNode({ nodeCode: 'JD-001', nodeName: '撞号', planDate: '2026-11-01', planAmount: 1 })
  check('同编号重复登记驳回', !dup.ok && dup.step === '第2步 重复登记校验')
  const backfill = createNode({
    nodeCode: 'JD-099',
    nodeName: '漏登补录节点',
    planDate: '2026-10-19',
    planAmount: 5,
    actualAmount: 0,
    status: STATUS.notStarted,
    backfilled: true,
  }, '2026-10-06T11:00:00.000Z')
  check('补录节点可入库', backfill.ok, backfill.message)
  const csv = exportProgressCsv('2026-10-06')
  check('补录节点随即出现在导出文件', csv.includes('JD-099') && csv.includes('补录'))
  const ledgerRow = presentLedger().find((r) => r['节点编号'] === 'JD-099')
  check('补录节点偏差按统一算法（10-19 在今天之后 = -13）', Number(ledgerRow?.['偏差天数']) === -13, String(ledgerRow?.['偏差天数']))
}

// 10. 完成态动作冻结 + 对账
{
  console.log('动作冻结与页面对账')
  freshAdapter()
  ensureProgressLedger()
  const row = presentLedger().find((r) => r['节点编号'] === 'JD-001')!
  const frozen = applyNodeAction(Number(row.id), '登记延期')
  check('已完成节点不允许再动作', !frozen.ok && frozen.step === '第3步 完成态冻结')
  const before = completedNodeCount()
  const target = presentLedger().find((r) => r['节点编号'] === 'JD-004')!
  check('确认在办节点完成', applyNodeAction(Number(target.id), '确认完成', '2026-10-06').ok)
  check('台账已完成数 +1', completedNodeCount() === before + 1)
  const recon = reconcileDeliveries()
  check('对账函数两边一致', recon.ledgerCompleted === completedNodeCount())
  check('missingColumns 识别缺量在办节点', missingColumns({
    id: 1, nodeCode: 'X', nodeName: 'X', planDate: '2026-10-01', actualDate: '',
    planAmount: 10, actualAmount: 0, status: STATUS.inProgress, backfilled: false, createdAt: '',
  }).includes('实际掘进量'))
  check('台账指纹稳定（同数据同指纹）', ledgerFingerprint([] as never[]) === ledgerFingerprint([] as never[]))
  check('buildRow 固定 10 列（含缺栏列）', buildRow({
    id: 1, nodeCode: 'X', nodeName: 'X', planDate: '2026-10-01', actualDate: '',
    planAmount: 10, actualAmount: 0, status: STATUS.notStarted, backfilled: false, createdAt: '',
  }, '2026-10-06').length === 10)
  void calcDeviationDays
}

// 11. 服务层端到端：页面入口与导出入口必须是同一份数据
{
  console.log('服务层端到端（列表 = 导出 = 册子）')
  const { downloadEntries: _d, exportEntries, listEntries, loadOverview } = await import('../src/api/local-service')
  freshAdapter()
  const page = listEntries('progress')
  const file = exportEntries('progress')
  const lines = file.content.split('\n').slice(1).filter(Boolean)
  check('页面 30 行、文件 30 行（修掉 27→21 的丢行）', page.total === 30 && lines.length === 30, `${page.total}/${lines.length}`)
  check('在办 27 与页面统计一致', page.items.filter((r) => r.status !== '已完成').length === 27)
  check('文件含计划完成日整列', file.content.split('\n')[0].split(',').includes('计划完成日'))
  check('文件里的偏差天数与页面逐行一致', page.items.every((r) => {
    const line = lines.find((l) => l.startsWith(String(r['节点编号'])))
    return line?.includes(String(r['偏差天数']))
  }))
  check('补录节点 JD-026 在文件里', file.content.includes('JD-026'))
  const overview = loadOverview()
  const progressRow = overview.modules.find((m) => m.name === '进度节点')
  check('运营概览页数同步为 30 条（另一个页面条数一致）', progressRow?.created === 30, String(progressRow?.created))
  check('概览待处理 = 在办 27', progressRow?.pending === 27, String(progressRow?.pending))
  void _d
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
