/**
 * 通用 KV 持久层：台账、导出任务、交付清单都落在 localStorage 的独立命名空间下。
 * 关键约束：
 * - 落库是原子提交，先写新值再改内存缓存；落库失败整体回滚（恢复旧快照），不留半包。
 * - 存储适配可注入，浏览器用 localStorage，Node 测试用内存 Map，业务逻辑不碰 window。
 */

export type StorageAdapter = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const NAMESPACE = 'shield-tunnel-construction'

export const KV_KEYS = {
  progressLedger: `${NAMESPACE}:progress-ledger`,
  progressMeta: `${NAMESPACE}:progress-meta`,
  exportJobs: `${NAMESPACE}:export-jobs`,
  deliveries: `${NAMESPACE}:ring-deliveries`,
} as const

export type KvSnapshot = Record<string, unknown>

function browserAdapter(): StorageAdapter | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  }
}

// 内存兜底 + 测试注入用。Map 里没有的键视为「未存储」。
const memoryFallback = new Map<string, string>()
let injected: StorageAdapter | null = null

export function useStorageAdapter(adapter: StorageAdapter | null): void {
  injected = adapter
}

export function activeAdapter(): StorageAdapter {
  if (injected) {
    return injected
  }
  const browser = browserAdapter()
  if (browser) {
    return browser
  }
  return {
    getItem: (key) => (memoryFallback.has(key) ? memoryFallback.get(key)! : null),
    setItem: (key, value) => {
      memoryFallback.set(key, value)
    },
    removeItem: (key) => {
      memoryFallback.delete(key)
    },
  }
}

export function readKv<T>(key: string, fallback: T): T {
  const raw = activeAdapter().getItem(key)
  if (raw === null) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 读当前全部 KV 的深拷贝，作为事务回滚快照。 */
export function snapshotKv(keys: readonly string[]): KvSnapshot {
  const snap: KvSnapshot = {}
  for (const key of keys) {
    const raw = activeAdapter().getItem(key)
    if (raw !== null) {
      snap[key] = JSON.parse(raw) as unknown
    }
  }
  return snap
}

export function restoreSnapshot(snap: KvSnapshot, touchedKeys?: readonly string[]): void {
  const adapter = activeAdapter()
  for (const [key, value] of Object.entries(snap)) {
    adapter.setItem(key, JSON.stringify(value))
  }
  // 快照里没有、但本次碰过的键是「新建后失败」的，必须删掉，不能留下半包。
  for (const key of touchedKeys ?? []) {
    if (!(key in snap)) {
      adapter.removeItem(key)
    }
  }
}

/**
 * 原子提交：任一键落库抛错（例如配额超限），已写入的键全部恢复旧值后再抛出，
 * 调用方拿到的一定是「全成」或「全没成」，不会出现半套数据。
 */
export function commitKv(entries: { key: string; value: unknown }[]): void {
  const adapter = activeAdapter()
  const touched = entries.map((entry) => entry.key)
  const snap = snapshotKv(touched)
  try {
    for (const entry of entries) {
      adapter.setItem(entry.key, JSON.stringify(entry.value))
    }
  } catch (error) {
    restoreSnapshot(snap, touched)
    throw error
  }
}

export function removeKv(keys: readonly string[]): void {
  const adapter = activeAdapter()
  const snap = snapshotKv(keys)
  try {
    for (const key of keys) {
      adapter.removeItem(key)
    }
  } catch (error) {
    restoreSnapshot(snap)
    throw error
  }
}
