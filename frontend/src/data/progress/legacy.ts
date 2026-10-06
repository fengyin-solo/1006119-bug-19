import { SEED_LEGACY_NODES, SEED_FORM_ONLY_NODES } from './seed'

/**
 * 迁移前的两份旧数据：
 *  - list：已入库的节点，页面另存时漏掉了补录与部分字段
 *  - formOnly：只在“节点表单”里临时存在、从未落库的节点与字段（本次 bug 根因）
 * 迁移把两份并成同一份台账，之后列表/导出/册子都只读台账。
 */

export interface LegacyNode {
  id: number
  code: string
  name: string
  planDate: string
  actualDate: string
  planQty: number
  actualQty: number
  status: string
  createdAt: string
  /** 只在表单里存在、没写进台账的字段（如计划完成日）。 */
  formOnly?: { planDate?: string }
}

export const LEGACY_LIST_NODES: LegacyNode[] = SEED_LEGACY_NODES
export const LEGACY_FORM_ONLY_NODES: LegacyNode[] = SEED_FORM_ONLY_NODES

/** 迁移前遗留的交付清单：用旧偏差算法（当时把“缺日期”当 0）生成，升级后需重算。 */
export interface LegacyDelivery {
  id: number
  packageId: string
  at: string
  exportedCount: number
  completedCount: number
  conclusion: string
  deviationVersion: string
  deviationSnapshot: { code: string; deviationDays: number | null }[]
}

export const LEGACY_DELIVERIES: LegacyDelivery[] = [
  {
    id: 1,
    packageId: 'PKG-2026-09',
    at: '2026-09-30T18:00:00.000Z',
    exportedCount: 21,
    completedCount: 10,
    conclusion: '已出册（旧口径，待重算）',
    deviationVersion: 'legacy:missing-date-as-zero',
    deviationSnapshot: [
      { code: 'PROG-0001', deviationDays: 0 },
      { code: 'PROG-0003', deviationDays: 0 },
    ],
  },
]
