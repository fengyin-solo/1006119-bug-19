/**
 * 进度节点领域：列表页、导出文件、下载册子、掘进环次交付清单共用的一份数据与规则。
 * 这里的类型不再依附通用 EntryRow，避免“页面临时拼字段、导出另走一条路”。
 */

export type NodeStatus = '未开始' | '进行中' | '已完成' | '已延期'

/** 计划完成日冻结审批涉及的角色，数值越大权限越高。 */
export type Role = '班组' | '项目部' | '监理' | '建设单位'

/** 台账里的进度节点：字段全部持久化，偏差天数不落库、读取时按统一算法现算。 */
export interface ProgressNode {
  id: number
  /** 节点编号，业务唯一键，重复登记按它去重。 */
  code: string
  name: string
  /** 计划完成日 YYYY-MM-DD；已完成节点该字段冻结。 */
  planDate: string
  /** 实际完成日 YYYY-MM-DD，未完成时为空串。 */
  actualDate: string
  planQty: number
  actualQty: number
  status: NodeStatus
  /** 登记/补录时间，重号时只留最早登记那条。 */
  createdAt: string
  /** 重入库后按计划完成日排出的序号（从 1 开始）。 */
  ordinal: number
}

/** 交给页面、导出、册子共同消费的投影：含统一算法现算的偏差天数与逐格缺列标记。 */
export interface NodeProjection {
  id: number
  code: string
  name: string
  planDate: string
  actualDate: string
  planQty: number
  actualQty: number
  /** 统一算法算出的偏差天数；日期缺失为 null。 */
  deviationDays: number | null
  status: NodeStatus
  ordinal: number
  /** 该节点缺了哪些台账字段（如只在表单里存在、未入库的计划完成日）。 */
  missingColumns: string[]
}

export type RejectCode = 'APPROVED' | 'REJECTED_LOCKED' | 'REJECTED_FORBIDDEN' | 'REJECTED_NOT_FOUND'

export interface ApprovalResult {
  ok: boolean
  code: RejectCode
  /** 卡在哪一步，驳回时必须说明。 */
  step: string
  message: string
}

export type VolumeStatus = 'pending' | 'done'

export interface PackageVolume {
  index: number
  status: VolumeStatus
  /** 该卷承担的节点 id；卷未完成时保持空，绝不留半包。 */
  nodeIds: number[]
  /** 完成后才写入整卷 CSV 文本。 */
  csv: string
}

export interface ExportPackage {
  packageId: string
  idemKey: string
  volumeSize: number
  status: 'packing' | 'complete'
  volumes: PackageVolume[]
  /** 最近一次从哪一卷断掉（续打起点），无中断为 null。 */
  lastFailedVolume: number | null
  createdAt: string
  updatedAt: string
}

export interface DeliveryItem {
  id: number
  packageId: string
  at: string
  /** 本次导出的节点条数。 */
  exportedCount: number
  /** 台账口径的已完成节点数（与进度页同源）。 */
  completedCount: number
  /** 结论：通过 / 驳回原因。 */
  conclusion: string
  /** 生成该条清单时使用的偏差算法版本。 */
  deviationVersion: string
  /** 当时已完成节点的偏差快照，算法升级后会被重算。 */
  deviationSnapshot: { code: string; deviationDays: number | null }[]
}
