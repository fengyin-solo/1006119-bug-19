import type { EntryRow } from './types'

/**
 * 进度节点种子：模拟月底报建设单位的真实台账。
 * 共 31 条登记，其中 JD-028/JD-029 是同一节点的两次重复登记（rehouse 时只留最早一条），
 * 去重后 30 条：在办 27（未开始/进行中/已延期且未确认完成），已完成 3；补录 4 条。
 * 个别节点故意缺实际掘进量等栏，用于导出/册子的逐列缺栏标注。
 */

type SeedInput = {
  code: string
  name: string
  plan: string
  actual?: string
  planAmount: number
  actualAmount?: number
  status: string
  backfill?: boolean
  createdAt: string
}

const RAW: SeedInput[] = [
  { code: 'JD-001', name: '始发井围护结构封闭', plan: '2026-09-12', actual: '2026-09-10', planAmount: 12, actualAmount: 12, status: '已完成', createdAt: '2026-09-01T01:00:00.000Z' },
  { code: 'JD-002', name: '盾构机下井组装', plan: '2026-09-15', actual: '2026-09-16', planAmount: 8, actualAmount: 8, status: '已完成', createdAt: '2026-09-01T02:00:00.000Z' },
  { code: 'JD-003', name: '始发条件验收', plan: '2026-09-18', actual: '2026-09-18', planAmount: 6, actualAmount: 6, status: '已完成', createdAt: '2026-09-02T01:00:00.000Z' },
  { code: 'JD-004', name: '右线始发掘进', plan: '2026-09-20', planAmount: 30, actualAmount: 26, status: '进行中', createdAt: '2026-09-05T01:00:00.000Z' },
  { code: 'JD-005', name: '前50环试掘进参数固化', plan: '2026-09-23', planAmount: 50, actualAmount: 41, status: '进行中', createdAt: '2026-09-06T01:00:00.000Z' },
  { code: 'JD-006', name: '联络通道冻结孔开孔', plan: '2026-09-25', planAmount: 18, actualAmount: 9, status: '进行中', createdAt: '2026-09-07T01:00:00.000Z' },
  { code: 'JD-007', name: '1号车架后配套就位', plan: '2026-09-26', planAmount: 4, status: '未开始', createdAt: '2026-09-08T01:00:00.000Z' },
  { code: 'JD-008', name: '掘进至100环', plan: '2026-09-28', planAmount: 100, actualAmount: 63, status: '进行中', createdAt: '2026-09-08T02:00:00.000Z' },
  { code: 'JD-009', name: '同步注浆配比首轮复核', plan: '2026-09-29', planAmount: 10, actualAmount: 7, status: '已延期', createdAt: '2026-09-09T01:00:00.000Z' },
  { code: 'JD-010', name: '渣土消纳协议续签', plan: '2026-09-30', planAmount: 1, actualAmount: 1, status: '进行中', createdAt: '2026-09-09T02:00:00.000Z' },
  { code: 'JD-011', name: '左线洞门凿除', plan: '2026-10-02', planAmount: 6, actualAmount: 2, status: '进行中', createdAt: '2026-09-10T01:00:00.000Z' },
  { code: 'JD-012', name: '左线盾构始发', plan: '2026-10-05', planAmount: 24, actualAmount: 0, status: '未开始', createdAt: '2026-09-10T02:00:00.000Z' },
  { code: 'JD-013', name: '百环验收（右线）', plan: '2026-10-06', planAmount: 100, actualAmount: 63, status: '进行中', createdAt: '2026-09-11T01:00:00.000Z' },
  { code: 'JD-014', name: '掘进至150环', plan: '2026-10-08', planAmount: 150, actualAmount: 63, status: '进行中', createdAt: '2026-09-11T02:00:00.000Z' },
  { code: 'JD-015', name: '2号联络通道冻结交圈', plan: '2026-10-09', planAmount: 32, status: '未开始', createdAt: '2026-09-12T01:00:00.000Z' },
  { code: 'JD-016', name: '中段地表沉降首次复测', plan: '2026-10-10', planAmount: 24, actualAmount: 12, status: '进行中', createdAt: '2026-09-12T02:00:00.000Z' },
  { code: 'JD-017', name: '刀具开仓检查', plan: '2026-10-11', planAmount: 1, status: '未开始', createdAt: '2026-09-13T01:00:00.000Z' },
  { code: 'JD-018', name: '掘进至200环', plan: '2026-10-12', planAmount: 200, actualAmount: 63, status: '进行中', createdAt: '2026-09-13T02:00:00.000Z' },
  { code: 'JD-019', name: '管片进场质量抽检', plan: '2026-10-13', planAmount: 60, actualAmount: 20, status: '进行中', createdAt: '2026-09-14T01:00:00.000Z' },
  { code: 'JD-020', name: '轴线测量阶段性报审', plan: '2026-10-14', planAmount: 40, actualAmount: 18, status: '进行中', createdAt: '2026-09-14T02:00:00.000Z' },
  { code: 'JD-021', name: '右线掘进至260环', plan: '2026-10-15', planAmount: 260, actualAmount: 63, status: '进行中', createdAt: '2026-09-15T01:00:00.000Z' },
  { code: 'JD-022', name: '月度安全综合检查', plan: '2026-10-16', planAmount: 1, status: '未开始', createdAt: '2026-09-15T02:00:00.000Z' },
  { code: 'JD-023', name: '1号联络通道开挖', plan: '2026-10-17', planAmount: 12, status: '未开始', createdAt: '2026-09-16T01:00:00.000Z' },
  { code: 'JD-024', name: '废水泵房结构施工', plan: '2026-10-18', planAmount: 8, status: '未开始', createdAt: '2026-09-16T02:00:00.000Z' },
  { code: 'JD-025', name: '右线掘进至320环', plan: '2026-10-20', planAmount: 320, actualAmount: 63, status: '进行中', createdAt: '2026-09-17T01:00:00.000Z' },
  { code: 'JD-026', name: '中段建筑物沉降加密观测', plan: '2026-10-21', planAmount: 36, status: '未开始', createdAt: '2026-09-17T02:00:00.000Z' },
  { code: 'JD-027', name: '左线掘进至80环', plan: '2026-10-22', planAmount: 80, actualAmount: 0, status: '未开始', createdAt: '2026-09-18T01:00:00.000Z' },
  { code: 'JD-028', name: '盾构接收端头加固', plan: '2026-10-23', planAmount: 20, status: '未开始', createdAt: '2026-09-18T02:00:00.000Z' },
  // JD-028 的重复登记：晚登记，rehouse 必须丢弃这条，保留上面那条。
  { code: 'JD-028', name: '盾构接收端头加固(重复登记)', plan: '2026-10-23', planAmount: 20, status: '未开始', createdAt: '2026-09-25T03:00:00.000Z' },
  { code: 'JD-029', name: '右线掘进至380环', plan: '2026-10-24', planAmount: 380, actualAmount: 63, status: '进行中', createdAt: '2026-09-19T01:00:00.000Z' },
  { code: 'JD-030', name: '月度进度节点报建设单位', plan: '2026-10-25', planAmount: 1, status: '未开始', createdAt: '2026-09-19T02:00:00.000Z' },
]

// 事后补录的 4 个节点（现场漏登后补），导出/册子必须带上，不能只在页面里看得见。
const BACKFILL_CODES = new Set(['JD-006', 'JD-015', 'JD-022', 'JD-026'])

export const SEED_PROGRESS: EntryRow[] = RAW.map((item, index) => ({
  id: index + 1,
  status: item.status,
  pending: item.status !== '已完成',
  abnormal: item.status === '已延期',
  节点编号: item.code,
  节点名称: item.name,
  计划完成日: item.plan,
  实际完成日: item.actual ?? '',
  计划掘进量: item.planAmount,
  // JD-016 故意漏填实际掘进量：导出时这一栏要逐列标缺。
  实际掘进量: item.code === 'JD-016' ? '' : (item.actualAmount ?? 0),
  偏差天数: '', // 不预置，统一算法现算
  节点状态: item.status,
  补录标记: BACKFILL_CODES.has(item.code) ? '补录' : '',
  登记时间: item.createdAt,
}))
