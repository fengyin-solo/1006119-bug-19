import { SEED_ROWS } from './seed'
import { getProgressRows } from './progress'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const PROGRESS_KEY = 'progress'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 进度节点已收敛到独立领域台账（src/data/progress）。
 * 通用存储遇到 progress 一律从台账现取，保证看板等其它页面与进度页、导出读到同一份，
 * 不再让「另一个页面」自己留一份条数。
 */
function progressRowsFromLedger(): EntryRow[] {
  return getProgressRows().map<EntryRow>((p) => ({
    id: p.id,
    status: p.status,
    pending: p.status !== '已完成',
    abnormal: p.status === '已延期',
    节点编号: p.code,
    节点名称: p.name,
    计划完成日: p.planDate,
    实际完成日: p.actualDate,
    计划掘进量: p.planQty,
    实际完成量: p.actualQty,
    偏差天数: p.deviationDays ?? '',
    节点状态: p.status,
  }))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    fallback[PROGRESS_KEY] = progressRowsFromLedger()
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    fallback[PROGRESS_KEY] = progressRowsFromLedger()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    // progress 永远以领域台账为准，忽略旧通用桶里可能残留的那份。
    merged[PROGRESS_KEY] = progressRowsFromLedger()
    return merged
  } catch {
    const fresh = clone(SEED_ROWS)
    fresh[PROGRESS_KEY] = progressRowsFromLedger()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
    return fresh
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  } else {
    // 每次都从台账刷新 progress，避免迁移/登记后看板仍读旧条数。
    cache[PROGRESS_KEY] = progressRowsFromLedger()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  if (key === PROGRESS_KEY) {
    return progressRowsFromLedger()
  }
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  if (key === PROGRESS_KEY) {
    // 进度节点只允许走领域台账，通用直写一律忽略，防止再出现第二份数据。
    return
  }
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  if (key === PROGRESS_KEY) {
    return progressRowsFromLedger()
  }
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
