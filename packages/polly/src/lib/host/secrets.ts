// Persistent хранилище мелких секретов (JWT-сессия; прикладные мелочи).
//
// Приоритет бэкендов (аудит 2026-08, M-3):
//   1. OS-keychain через rust-команды os_secret_* (Windows Credential Manager /
//      macOS Keychain / Linux secret-service). Основной путь desktop-клиента.
//   2. Non-extractable AES-GCM ключ + шифртекст в IndexedDB — софтверный
//      фолбэк (keychain недоступен / ошибка IPC). Значения из п.1 при чтении
//      лениво мигрируются сюда → в п.1 обратно не пишем (см. osSecrets.get).
//   3. sessionStorage — только web-dev без WebCrypto/IndexedDB.
//
// localStorage не используем (CONVENTIONS). Access-токен в рантайме живёт
// только в памяти Zustand-store (features/auth/store.ts).

export interface Secrets {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

const DB_NAME = 'kd-secure'
const DB_VERSION = 1
const STORE_KEYS = 'meta'   // держит CryptoKey под id 'aesKey'
const STORE_VAULT = 'vault' // держит { iv, ct } под именем секрета
const AES_KEY_ID = 'aesKey'

function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

function cryptoAvailable(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined'
  )
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS)
      if (!db.objectStoreNames.contains(STORE_VAULT)) db.createObjectStore(STORE_VAULT)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke<T>(cmd, args)
}

// ───── 1. OS-keychain (основной desktop-бэкенд) ─────

const osSecrets: Secrets = {
  async get(key) {
    const value = await invoke<string | null>('os_secret_get', { key })
    if (value != null) return value

    // Ленивая миграция софтверного стора прошлых версий: значение нашлось
    // в IndexedDB → переносим в keychain и стираем из IDB.
    if (isTauri() && cryptoAvailable()) {
      try {
        const legacy = await cryptoSecrets.get(key)
        if (legacy != null) {
          await invoke('os_secret_set', { key, value: legacy })
          await cryptoSecrets.delete(key)
          return legacy
        }
      } catch { /* миграция best-effort */ }
    }
    return null
  },
  set(key, value) {
    return invoke('os_secret_set', { key, value })
  },
  async delete(key) {
    try { await invoke('os_secret_delete', { key }) } catch { /* уже нет записи */ }
  },
}

// ───── 2. Софтверный фолбэк: AES-GCM в IndexedDB ─────

// Достаём (или единожды создаём) non-extractable AES-GCM ключ. Хранится прямо в
// IndexedDB как CryptoKey — structured clone это умеет, и ключ остаётся
// non-extractable после восстановления.
let keyPromise: Promise<CryptoKey> | null = null
function getAesKey(db: IDBDatabase): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await idbGet<CryptoKey>(db, STORE_KEYS, AES_KEY_ID)
      if (existing) return existing
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false, // extractable = false: сырые байты ключа недоступны из JS
        ['encrypt', 'decrypt'],
      )
      await idbPut(db, STORE_KEYS, AES_KEY_ID, key)
      return key
    })().catch((err) => {
      keyPromise = null
      throw err
    })
  }
  return keyPromise
}

interface VaultRecord {
  iv: ArrayBuffer
  ct: ArrayBuffer
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const cryptoSecrets: Secrets = {
  async get(key) {
    const db = await openDb()
    const rec = await idbGet<VaultRecord>(db, STORE_VAULT, key)
    if (!rec) return null
    const aesKey = await getAesKey(db)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, aesKey, rec.ct)
    return dec.decode(plain)
  },
  async set(key, value) {
    const db = await openDb()
    const aesKey = await getAesKey(db)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(value))
    await idbPut(db, STORE_VAULT, key, { iv: iv.buffer, ct } satisfies VaultRecord)
  },
  async delete(key) {
    const db = await openDb()
    await idbDelete(db, STORE_VAULT, key)
  },
}

// ───── 3. Последний фолбэк для web-dev ─────

const sessionSecrets: Secrets = {
  async get(key) { return sessionStorage.getItem(key) },
  async set(key, value) { sessionStorage.setItem(key, value) },
  async delete(key) { sessionStorage.removeItem(key) },
}

// Обёртка: первый доступный бэкенд основной, второй — фолбэк на случай ошибки
// (keychain залочен, IPC упал). Решение кешируется на уровне модуля.
function makeSecrets(): Secrets {
  const backends: Secrets[] = []
  if (isTauri()) backends.push(osSecrets)
  if (cryptoAvailable()) backends.push(cryptoSecrets)
  if (backends.length === 0) return sessionSecrets

  const primary = backends[0]!
  const fallback = backends[1] ?? sessionSecrets
  return {
    async get(key) {
      try { return await primary.get(key) } catch { return fallback.get(key) }
    },
    async set(key, value) {
      try { await primary.set(key, value) } catch { await fallback.set(key, value) }
    },
    async delete(key) {
      try { await primary.delete(key) } catch { /* ignore */ }
      // Секрет не должен «протекать» мимо — чистим все прочие бэкенды.
      try { await fallback.delete(key) } catch { /* ignore */ }
      try { await sessionSecrets.delete(key) } catch { /* ignore */ }
    },
  }
}

export const secrets: Secrets = makeSecrets()
