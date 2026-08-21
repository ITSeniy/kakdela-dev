// T-102 — host-абстракция над локальной зашифрованной историей секретных чатов.
//
// Обёртка над tauri::command'ами из src-tauri/src/commands.rs (secret_history_*).
// История — источник истины секретных переписок, живёт ТОЛЬКО на устройстве в
// зашифрованном at-rest снапшоте (см. store/local_db.rs). Web-путь не поддержан —
// бросает { code: 'secret-chats-unsupported' }.

import type { CryptoError } from './crypto.js'

export type SecretDirection = 'in' | 'out'
export type SecretStatus = 'sent' | 'delivered' | 'read'

/** Одно сохранённое текстовое сообщение (зеркало Rust StoredMessage). */
export interface StoredSecretMessage {
  id: number
  peerUserId: string
  direction: SecretDirection
  body: string
  sentAtMs: number
  readAtMs: number | null
  status: SecretStatus
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

const UNSUPPORTED: CryptoError = {
  code: 'secret-chats-unsupported',
  message: 'secret chats are available only on the mobile (device-bound) client',
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw UNSUPPORTED
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke<T>(cmd, args)
}

/** Записать своё исходящее сообщение (после успешной отправки на релей). */
export async function appendOutgoing(
  peerUserId: string,
  body: string,
  sentAtMs: number,
): Promise<StoredSecretMessage> {
  return call<StoredSecretMessage>('secret_history_append_outgoing', { peerUserId, body, sentAtMs })
}

/**
 * Записать входящее сообщение (после расшифровки крипто-ядром) и запомнить
 * конверт. null — конверт уже обработан (повторная доставка после креша
 * между показом и ack, аудит M-10): дубликат в историю не пишется.
 */
export async function appendIncoming(
  peerUserId: string,
  body: string,
  sentAtMs: number,
  envelopeId: string,
): Promise<StoredSecretMessage | null> {
  return call<StoredSecretMessage | null>('secret_history_append_incoming', {
    peerUserId,
    body,
    sentAtMs,
    envelopeId,
  })
}

/** Обработан ли уже этот конверт (дедуп повторной доставки, M-10). */
export async function isEnvelopeSeen(peerUserId: string, envelopeId: string): Promise<boolean> {
  return call<boolean>('secret_history_is_envelope_seen', { peerUserId, envelopeId })
}

/** Запомнить конверт обработанным без записи в историю (read/typing). */
export async function markEnvelopeSeen(peerUserId: string, envelopeId: string): Promise<void> {
  await call('secret_history_mark_envelope_seen', { peerUserId, envelopeId })
}

/** Пометить исходящие прочитанными (по входящему read-конверту) → галочки ✓✓. */
export async function markRead(peerUserId: string, beforeMs: number): Promise<number> {
  return call<number>('secret_history_mark_read', { peerUserId, beforeMs })
}

/** Вся история с собеседником, по возрастанию id. */
export async function listMessages(peerUserId: string): Promise<StoredSecretMessage[]> {
  return call<StoredSecretMessage[]>('secret_history_list', { peerUserId })
}

/** userId'ы всех собеседников с историей (для списка секретных чатов). */
export async function listPeers(): Promise<string[]> {
  return call<string[]>('secret_history_peers')
}
