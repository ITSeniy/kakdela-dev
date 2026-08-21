// T-102 — pipeline секретных чатов (отправка / приём / контрол-конверты).
//
// Связывает три слоя:
//   • крипто-ядро    (lib/host/crypto.ts)       — PQXDH + Double Ratchet, T-101
//   • локальная история (lib/host/secret-store.ts) — источник истины переписки
//   • слепой релей    (REST /api/secret/*, /api/keys/*) — store-and-forward
//
// Принципы: все мутации через REST; WS — только «звоночек» secret.envelope без
// контента. Сервер видит лишь непрозрачный ciphertext. Вид сообщения
// (text/read/typing) зашифрован ВНУТРИ конверта (SecretFrame), серверу не виден.

import {
  SecretFrameSchema,
  type PrekeyBundleResponse,
  type PrekeyCountResponse,
  type SecretFrame,
  type SecretInboxResponse,
  type SecretSendResponse,
} from '@kakdela/ginzu/api-types'
import type { QueryClient } from '@tanstack/react-query'

import { apiFetch } from '../../lib/api.js'
import {
  cryptoDecrypt,
  cryptoEncrypt,
  cryptoInit,
  cryptoProcessBundle,
  cryptoPublishKeys,
  cryptoSessionExists,
  cryptoTopup,
  type EncryptResult,
} from '../../lib/host/crypto.js'
import {
  appendIncoming,
  appendOutgoing,
  isEnvelopeSeen,
  listMessages,
  listPeers,
  markEnvelopeSeen,
  markRead,
  type StoredSecretMessage,
} from '../../lib/host/secret-store.js'
import { wsClient } from '../../lib/ws.js'
import { useSecretSession } from './sessionStore.js'

// Долить one-time prekey'и, когда на сервере осталось меньше этого порога.
const PREKEY_LOW_WATERMARK = 20
const PREKEY_BATCH = 100

// ───────── query keys (хуки строит T-103) ─────────

export const secretMessagesKey = (peerUserId: string) => ['secret-messages', peerUserId] as const
export const secretPeersKey = ['secret-peers'] as const

/** Загрузить историю с собеседником (для useQuery в UI T-103). */
export function fetchSecretMessages(peerUserId: string): Promise<StoredSecretMessage[]> {
  return listMessages(peerUserId)
}

/** Список собеседников с историей (для списка секретных чатов). */
export function fetchSecretPeers(): Promise<string[]> {
  return listPeers()
}

// ───────── публикация ключей (слепой каталог, T-101) ─────────

/**
 * Поднять крипто-ядро и убедиться, что наш публичный бандл опубликован.
 * Идемпотентно: count===0 на сервере ⇒ ещё не публиковались (или израсходованы
 * все one-time) ⇒ публикуем полный бандл; иначе доливаем при нехватке.
 */
export async function initSecretChats(selfUserId: string): Promise<void> {
  await cryptoInit(selfUserId)
  const { oneTimePrekeys } = await apiFetch<PrekeyCountResponse>('/api/keys/count')
  if (oneTimePrekeys === 0) {
    await publishKeys()
  } else if (oneTimePrekeys < PREKEY_LOW_WATERMARK) {
    await topUpKeys()
  }
}

/** Сформировать публичный бандл и опубликовать в каталог. */
export async function publishKeys(count = PREKEY_BATCH): Promise<void> {
  const bundle = await cryptoPublishKeys(count)
  await apiFetch<void>('/api/keys/bundle', {
    method: 'POST',
    body: JSON.stringify(bundle),
  })
}

/** Долить one-time prekey'и в каталог. */
export async function topUpKeys(count = PREKEY_BATCH): Promise<void> {
  const oneTimePrekeys = await cryptoTopup(count)
  if (oneTimePrekeys.length === 0) return
  await apiFetch<void>('/api/keys/topup', {
    method: 'POST',
    body: JSON.stringify({ oneTimePrekeys }),
  })
}

// ───────── отправка ─────────

function fetchBundle(userId: string): Promise<PrekeyBundleResponse> {
  return apiFetch<PrekeyBundleResponse>(`/api/keys/${userId}/bundle`)
}

/**
 * Убедиться, что с собеседником есть сессия. Если нет — тянем его бандл и
 * стартуем PQXDH (для StartSecretChat: «устанавливаем защищённое соединение»).
 */
export async function ensureSecretSession(peerUserId: string): Promise<void> {
  if (await cryptoSessionExists(peerUserId)) return
  const bundle = await fetchBundle(peerUserId)
  await cryptoProcessBundle(peerUserId, bundle)
}

/**
 * Зашифровать frame для собеседника. Если сессии ещё нет — тянем его бандл и
 * стартуем PQXDH (первое сообщение будет msgType='prekey').
 */
async function encryptFrame(peerUserId: string, frame: SecretFrame): Promise<EncryptResult> {
  const json = JSON.stringify(frame)
  if (await cryptoSessionExists(peerUserId)) {
    return cryptoEncrypt(peerUserId, json)
  }
  const bundle = await fetchBundle(peerUserId)
  return cryptoEncrypt(peerUserId, json, bundle)
}

/** Положить конверт в очередь адресата на слепом релее. */
async function sendEnvelope(peerUserId: string, enc: EncryptResult): Promise<SecretSendResponse> {
  return apiFetch<SecretSendResponse>('/api/secret/send', {
    method: 'POST',
    body: JSON.stringify({ toUserId: peerUserId, ciphertext: enc.ciphertext, msgType: enc.msgType }),
  })
}

/**
 * Отправить текстовое сообщение: шифруем → кладём в очередь → пишем свою копию
 * в локальную историю (status='sent'). Возвращает сохранённое сообщение.
 */
export async function sendSecretText(peerUserId: string, body: string): Promise<StoredSecretMessage> {
  const ts = Date.now()
  const enc = await encryptFrame(peerUserId, { kind: 'text', body, ts })
  await sendEnvelope(peerUserId, enc)
  return appendOutgoing(peerUserId, body, ts)
}

/**
 * Отправить read-receipt: «прочитал вплоть до uptoTs» — у собеседника
 * проставятся ✓✓. В свою историю НЕ пишется (это контрол-конверт).
 */
export async function sendReadReceipt(peerUserId: string, uptoTs: number = Date.now()): Promise<void> {
  const enc = await encryptFrame(peerUserId, { kind: 'read', ts: uptoTs })
  await sendEnvelope(peerUserId, enc)
}

/** Отправить «печатает» (эфемерно, в историю не пишется). No-op без сессии —
 *  нажатие клавиши не должно поднимать PQXDH-рукопожатие. */
export async function sendTyping(peerUserId: string): Promise<void> {
  if (!(await cryptoSessionExists(peerUserId))) return
  const enc = await encryptFrame(peerUserId, { kind: 'typing', ts: Date.now() })
  await sendEnvelope(peerUserId, enc)
}

// ───────── приём ─────────

interface DrainResult {
  /** Собеседники, чья история изменилась (для точечной инвалидации). */
  touchedPeers: Set<string>
}

/**
 * Слить inbox: расшифровать конверты ПО ПОРЯДКУ (порядок важен для ratchet),
 * разложить по локальной истории, заack'ать обработанные. Конверты, которые не
 * удалось расшифровать, НЕ ack'аются (останутся до следующего раза / retention).
 */
async function drainOnce(): Promise<DrainResult> {
  const { envelopes } = await apiFetch<SecretInboxResponse>('/api/secret/inbox')
  const touchedPeers = new Set<string>()
  const ackIds: string[] = []

  // Строго последовательно: prekey-конверт устанавливает сессию для следующих.
  for (const env of envelopes) {
    try {
      // Уже обработанный конверт (креш между показом и ack — аудит M-10):
      // НЕ расшифровываем повторно — ratchet уже продвинулся, decrypt упал бы
      // и конверт завис до retention. Просто ack.
      if (await isEnvelopeSeen(env.fromUserId, env.id)) {
        ackIds.push(env.id)
        continue
      }

      const plaintext = await cryptoDecrypt(env.fromUserId, env.ciphertext, env.msgType)
      const frame = SecretFrameSchema.parse(JSON.parse(plaintext))
      if (frame.kind === 'text') {
        const added = await appendIncoming(env.fromUserId, frame.body, frame.ts, env.id)
        if (added) touchedPeers.add(env.fromUserId)
      } else if (frame.kind === 'read') {
        const changed = await markRead(env.fromUserId, frame.ts)
        await markEnvelopeSeen(env.fromUserId, env.id)
        if (changed > 0) touchedPeers.add(env.fromUserId)
      } else {
        useSecretSession.getState().setTyping(env.fromUserId, frame.ts)
        await markEnvelopeSeen(env.fromUserId, env.id)
      }
      ackIds.push(env.id)
    } catch (err) {
      // untrusted-identity = у собеседника сменился ключ (переустановка). Это
      // сигнал безопасности: помечаем чат, НЕ ack'аем (конверт переобработается
      // после re-verify → clear_session). Прочие ошибки — тоже оставляем в очереди.
      if ((err as { code?: string })?.code === 'untrusted-identity') {
        useSecretSession.getState().flagKeyChanged(env.fromUserId)
      }
      // Не логируем содержимое: только факт. retention-sweeper уберёт зависшее.
      console.warn('[secret] failed to process envelope', env.id)
    }
  }

  if (ackIds.length > 0) {
    await apiFetch<void>('/api/secret/ack', { method: 'POST', body: JSON.stringify({ ids: ackIds }) })
  }
  return { touchedPeers }
}

// Сериализуем сливы: параллельные drainOnce ломали бы порядок ratchet и могли
// бы дважды обработать один конверт. Если запрос пришёл во время активного
// слива — ставим ровно один повтор после него (новый конверт не потеряется).
let draining = false
let rerunQueued = false
let activeQueryClient: QueryClient | null = null

function triggerDrain(queryClient: QueryClient): void {
  if (draining) {
    rerunQueued = true
    return
  }
  draining = true
  void (async () => {
    try {
      const { touchedPeers } = await drainOnce()
      if (touchedPeers.size > 0) {
        void queryClient.invalidateQueries({ queryKey: secretPeersKey })
        for (const peer of touchedPeers) {
          void queryClient.invalidateQueries({ queryKey: secretMessagesKey(peer) })
        }
      }
    } catch (err) {
      console.warn('[secret] drain failed', (err as { code?: string })?.code ?? 'error')
    } finally {
      draining = false
      if (rerunQueued) {
        rerunQueued = false
        triggerDrain(queryClient)
      }
    }
  })()
}

/**
 * Подписаться на секретный транспорт: WS secret.envelope → слить inbox; на
 * ready/reconnect — тоже слить (backfill оффлайн-конвертов). Возвращает
 * функцию отписки. Вызывается на mobile из app-bootstrap (T-103).
 */
export function startSecretChatListener(queryClient: QueryClient): () => void {
  activeQueryClient = queryClient
  const off = wsClient.on((event) => {
    if (event.t === 'secret.envelope' || event.t === 'ready') {
      triggerDrain(queryClient)
    }
  })
  return () => {
    off()
    activeQueryClient = null
  }
}

/**
 * Вручную пнуть слив (после re-verify/clear_session — переобработать зависшие
 * prekey-конверты с новым identity). No-op, если слушатель не запущен.
 */
export function requestSecretDrain(): void {
  if (activeQueryClient) triggerDrain(activeQueryClient)
}
