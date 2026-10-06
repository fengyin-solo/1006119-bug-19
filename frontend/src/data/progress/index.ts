/**
 * 进度节点领域对外门面：页面、导出、册子、看板、掘进环次交付清单都只走这里。
 * 保证“列表页、导出文件、下载册子读同一份数据”。
 */
import {
  buildBooklet,
  buildExportSnapshot,
  getPackage,
  recordExportConclusion,
  resumePackage,
  startPackage,
  type ExportSnapshot,
} from './export'
import {
  approvePlanDateChange,
  confirmComplete,
  listDeliveries,
  migrate,
  nodeStats,
  projectAll,
  recomputeExistingDeliveries,
  registerNodes,
  transitionStatus,
  type NodeStats,
  type RegisterInput,
} from './repository'
import { bindKv, createMemoryKv } from './storage'
import { todayISO } from './deviation'
import type { ApprovalResult, DeliveryItem, ExportPackage, NodeProjection, Role } from './types'

export function ensureMigrated() {
  return migrate()
}

export function getProgressRows(nowISO: string = todayISO()): NodeProjection[] {
  ensureMigrated()
  return projectAll(nowISO)
}

export function getProgressStats(): NodeStats {
  ensureMigrated()
  return nodeStats()
}

export function exportProgress(): ExportSnapshot {
  ensureMigrated()
  return buildExportSnapshot()
}

export function startProgressPackage(packageId: string, idemKey: string, volumeSize: number) {
  ensureMigrated()
  return startPackage(packageId, idemKey, volumeSize)
}

export function resumeProgressPackage(packageId: string, failAtVolume?: number): ExportPackage {
  ensureMigrated()
  return resumePackage(packageId, getKvForExport(), { failAtVolume })
}

export function buildProgressBooklet(packageId: string) {
  ensureMigrated()
  return buildBooklet(packageId)
}

export function getProgressPackage(packageId: string) {
  ensureMigrated()
  return getPackage(packageId)
}

export function writeProgressExportConclusion(packageId: string, conclusion: string): DeliveryItem[] {
  ensureMigrated()
  return recordExportConclusion(packageId, conclusion)
}

export function listProgressDeliveries(): DeliveryItem[] {
  ensureMigrated()
  return listDeliveries()
}

export function recomputeProgressDeliveries(): DeliveryItem[] {
  ensureMigrated()
  return recomputeExistingDeliveries()
}

export function registerProgressNodes(inputs: RegisterInput[], idemKey: string) {
  ensureMigrated()
  return registerNodes(inputs, idemKey)
}

export function changePlanDate(code: string, nextPlanDate: string, role: Role): ApprovalResult {
  ensureMigrated()
  return approvePlanDateChange(code, nextPlanDate, role)
}

export function completeProgressNode(code: string, actualDate: string, actualQty: number): ApprovalResult {
  ensureMigrated()
  return confirmComplete(code, actualDate, actualQty)
}

export function transitionProgressNode(code: string, next: '进行中' | '已延期' | '未开始'): ApprovalResult {
  ensureMigrated()
  return transitionStatus(code, next)
}

export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 内部：测试与门面共享一个可注入存储句柄。
import { getKv } from './storage'
function getKvForExport() {
  return getKv()
}

export const progressService = {
  ensureMigrated,
  getProgressRows,
  getProgressStats,
  exportProgress,
  startProgressPackage,
  resumeProgressPackage,
  buildProgressBooklet,
  getProgressPackage,
  writeProgressExportConclusion,
  listProgressDeliveries,
  recomputeProgressDeliveries,
  registerProgressNodes,
  changePlanDate,
  completeProgressNode,
  transitionProgressNode,
  downloadTextFile,
}

export { bindKv, createMemoryKv }
export type { ApprovalResult, DeliveryItem, ExportPackage, ExportSnapshot, NodeProjection, Role }
