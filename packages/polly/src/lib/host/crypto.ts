// T-101 — host-абстракция крипто-ядра секретных чатов.
//
// Оборачивает tauri::command'ы из src-tauri/src/commands.rs. Приватные ключи и
// ratchet-состояние живут ТОЛЬКО в нативной стороне (Rust), WebView их не видит:
// сюда приходят/уходят лишь публичные бандлы и base64 шифртекста.
//
// Web-путь (`pnpm dev:web`, браузер) секретных чатов НЕ поддерживает — он бросает
// { code: 'secret-chats-unsupported' }. Секретные чаты — мобайл-онли (device-bound).

import type {
  KyberPrekey,
  OneTimePrekey,
  PrekeyBundleResponse,
  SignedPrekey,
} from '@kakdela/ginzu/api-types'

/** Ошибка крипто-команды: тот же `{ code, message }`, что у REST/Rust-стороны. */
export interface CryptoError {
  code: string
  message: string
}

/** Публичный бандл, который клиент отправляет в POST /api/keys/bundle. */
export interface PublicBundle {
  identityKey: string
  registrationId: number
  signedPrekey: SignedPrekey
  kyberPrekey: KyberPrekey
  oneTimePrekeys: OneTimePrekey[]
}

/** Результат шифрования: base64 шифртекста + тип конверта libsignal. */
export interface EncryptResult {
  ciphertext: string
  /** 'prekey' — первое сообщение (PQXDH); 'message' — Double Ratchet. */
  msgType: 'prekey' | 'message'
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

const UNSUPPORTED: CryptoError = {
  code: 'secret-chats-unsupported',
  message: 'secret chats are available only on the mobile (device-bound) client',
}

/** Вызвать tauri-команду; на web-пути — бросить secret-chats-unsupported. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw UNSUPPORTED
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke<T>(cmd, args)
}

/** Идемпотентно создаёт identity при первом запуске устройства. */
export async function cryptoInit(selfUserId: string): Promise<void> {
  await call('crypto_init', { selfUserId })
}

/**
 * Сформировать публичный бандл (identity + signed + kyber + N одноразовых).
 * Отправляется в POST /api/keys/bundle. count по умолчанию 100.
 */
export async function cryptoPublishKeys(count?: number): Promise<PublicBundle> {
  return call<PublicBundle>('crypto_publish_keys', { count })
}

/** Долить одноразовые prekey'и (для POST /api/keys/topup). */
export async function cryptoTopup(count?: number): Promise<OneTimePrekey[]> {
  return call<OneTimePrekey[]>('crypto_topup', { count })
}

/** Установить сессию из бандла собеседника (PQXDH). */
export async function cryptoProcessBundle(
  userId: string,
  bundle: PrekeyBundleResponse,
): Promise<void> {
  await call('crypto_process_bundle', { userId, bundle })
}

/**
 * Зашифровать строку для собеседника. Если сессии ещё нет — передать его бандл
 * (из GET /api/keys/:userId/bundle): на первом сообщении произойдёт PQXDH.
 */
export async function cryptoEncrypt(
  toUserId: string,
  plaintext: string,
  bundle?: PrekeyBundleResponse,
): Promise<EncryptResult> {
  return call<EncryptResult>('crypto_encrypt', { toUserId, plaintext, bundle: bundle ?? null })
}

/** Расшифровать конверт от собеседника. */
export async function cryptoDecrypt(
  fromUserId: string,
  ciphertext: string,
  msgType: 'prekey' | 'message',
): Promise<string> {
  return call<string>('crypto_decrypt', { fromUserId, ciphertext, msgType })
}

/** Есть ли уже установленная сессия с собеседником. */
export async function cryptoSessionExists(userId: string): Promise<boolean> {
  return call<boolean>('crypto_session_exists', { userId })
}

/**
 * Забыть сессию и сохранённый identity собеседника (после смены его ключа).
 * Следующая отправка возьмёт свежий бандл и поднимет новую сессию (T-103
 * re-verify). Идемпотентно.
 */
export async function cryptoClearSession(userId: string): Promise<void> {
  await call('crypto_clear_session', { userId })
}

/**
 * Детерминированный симметричный safety number (для верификации, T-103).
 * Одинаков у обеих сторон сессии. Требует уже известного identity собеседника.
 */
export async function cryptoSafetyNumber(userId: string): Promise<string> {
  return call<string>('crypto_safety_number', { userId })
}

/** Поддерживаются ли секретные чаты в текущем окружении (нативный Tauri). */
export function secretChatsSupported(): boolean {
  return isTauri()
}

/** Drop in-memory crypto/history without deleting encrypted data. */
export async function cryptoClose(): Promise<void> { await call('crypto_close') }
