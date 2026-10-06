/**
 * 极简键值存储：默认落到浏览器 localStorage，测试时可注入内存实现。
 * 领域台账只认这一层，方便在 Node 里无浏览器也能跑迁移/导出/续打的用例。
 */
export interface KvStore {
  get<T>(key: string): T | null
  set(key: string, value: unknown): void
  remove(key: string): void
}

const PREFIX = 'shield-tunnel-construction:progress:'

export const KV_KEYS = {
  ledger: `${PREFIX}ledger`,
  packages: `${PREFIX}packages`,
  deliveries: `${PREFIX}deliveries`,
  idempotency: `${PREFIX}idempotency`,
  migrated: `${PREFIX}migrated-at`,
}

class BrowserKv implements KvStore {
  get<T>(key: string): T | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    const raw = window.localStorage.getItem(key)
    if (raw === null) {
      return null
    }
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  set(key: string, value: unknown): void {
    if (typeof window === 'undefined' || !window.localStorage) {
      return
    }
    window.localStorage.setItem(key, JSON.stringify(value))
  }

  remove(key: string): void {
    if (typeof window === 'undefined' || !window.localStorage) {
      return
    }
    window.localStorage.removeItem(key)
  }
}

export function createMemoryKv(initial: Record<string, unknown> = {}): KvStore {
  const map = new Map<string, unknown>(Object.entries(initial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
  return {
    get<T>(key: string): T | null {
      return map.has(key) ? (JSON.parse(JSON.stringify(map.get(key))) as T) : null
    },
    set(key: string, value: unknown): void {
      map.set(key, JSON.parse(JSON.stringify(value)))
    },
    remove(key: string): void {
      map.delete(key)
    },
  }
}

let driver: KvStore = new BrowserKv()

/** 测试可替换底层存储；页面代码用默认浏览器实现。 */
export function bindKv(store: KvStore): void {
  driver = store
}

export function getKv(): KvStore {
  return driver
}
