// T-103 — экран секретного чата. Стиль 1:1 с designs/final-secret-chat.jsx
// (SecretChatScreen): шапка с замком/«проверено», системный баннер, пузыри из
// локальной истории (T-102), composer (только текст) с E2EE-футером. Плюс
// E2EE-логика: верификация (safety number), баннер «ключ изменился» с блоком
// отправки, device-bound онбординг.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Avatar } from '../../components/Avatar.js'
import { DayDivider } from '../../components/DayDivider.js'
import { Icon } from '../../components/Icon.js'
import { toast } from '../../components/toast/index.js'
import { cryptoClearSession, cryptoSafetyNumber } from '../../lib/host/crypto.js'
import type { StoredSecretMessage } from '../../lib/host/secret-store.js'
import { getUserProfile } from '../profile/api.js'
import {
  ensureSecretSession,
  fetchSecretMessages,
  requestSecretDrain,
  secretMessagesKey,
  sendReadReceipt,
  sendSecretText,
  sendTyping,
} from './api.js'
import { KeyVerification } from './KeyVerification.js'
import { SecretBubble } from './SecretBubble.js'
import {
  DeviceBoundOnboarding,
  EstablishingBanner,
  KeyChangedBanner,
  ProtectedBanner,
} from './SessionBanner.js'
import { useSecretSession } from './sessionStore.js'
import {
  clearVerified,
  getVerifiedSafetyNumber,
  hasSeenOnboarding,
  markOnboardingSeen,
  setSeenTs,
  setVerifiedSafetyNumber,
} from './verifyStore.js'

const TYPING_TTL_MS = 6000

function sameDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'short' })
}

export function SecretChatScreen({ peerUserId, onBack }: { peerUserId: string; onBack?: () => void }) {
  const queryClient = useQueryClient()
  const [establishing, setEstablishing] = useState(false)
  const [establishError, setEstablishError] = useState<string | null>(null)
  const [showVerify, setShowVerify] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)

  const keyChanged = useSecretSession((s) => Boolean(s.keyChanged[peerUserId]))
  const clearKeyChanged = useSecretSession((s) => s.clearKeyChanged)
  const typingAt = useSecretSession((s) => s.typingAt[peerUserId] ?? 0)
  const [nowTick, setNowTick] = useState(() => Date.now())

  const { data: profile } = useQuery({
    queryKey: ['user-profile', peerUserId],
    queryFn: () => getUserProfile(peerUserId),
    staleTime: 30_000,
  })
  const name = profile?.displayName ?? '…'
  const status = profile?.status ?? 'offline'

  const { data: messages = [] } = useQuery({
    queryKey: secretMessagesKey(peerUserId),
    queryFn: () => fetchSecretMessages(peerUserId),
    staleTime: 2_000,
  })

  const { data: safetyNumber = null } = useQuery({
    queryKey: ['secret-safety', peerUserId, messages.length, keyChanged],
    queryFn: () => cryptoSafetyNumber(peerUserId).catch(() => null),
    staleTime: 30_000,
  })
  const { data: verifiedSn = null } = useQuery({
    queryKey: ['secret-verified', peerUserId, safetyNumber],
    queryFn: () => getVerifiedSafetyNumber(peerUserId),
    staleTime: 30_000,
  })
  const verified = Boolean(safetyNumber && verifiedSn && safetyNumber === verifiedSn)

  useEffect(() => {
    let cancelled = false
    setEstablishError(null)
    setEstablishing(true)
    ensureSecretSession(peerUserId)
      .then(() => { if (!cancelled) setEstablishing(false) })
      .catch((err: { code?: string }) => {
        if (cancelled) return
        setEstablishing(false)
        setEstablishError(
          err?.code === 'keys-not-found'
            ? 'у собеседника ещё нет ключей для секретного чата'
            : 'не удалось установить защищённое соединение',
        )
      })
    return () => { cancelled = true }
  }, [peerUserId])

  useEffect(() => {
    void hasSeenOnboarding().then((seen) => { if (!seen) setShowOnboarding(true) })
  }, [])

  // Гасим unread + шлём read-receipt собеседнику по времени последнего входящего.
  const lastIncomingTs = useMemo(() => {
    let ts = 0
    for (const m of messages) if (m.direction === 'in' && m.sentAtMs > ts) ts = m.sentAtMs
    return ts
  }, [messages])
  useEffect(() => {
    if (lastIncomingTs > 0 && !keyChanged) {
      void setSeenTs(peerUserId, lastIncomingTs)
      void queryClient.invalidateQueries({ queryKey: ['secret-peers'] })
      sendReadReceipt(peerUserId, lastIncomingTs).catch(() => { /* контрол не критичен */ })
    }
  }, [peerUserId, lastIncomingTs, keyChanged, queryClient])

  const typingVisible = typingAt > 0 && nowTick - typingAt < TYPING_TTL_MS
  useEffect(() => {
    if (typingAt === 0) return undefined
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [typingAt])

  async function handleVerifyConfirm() {
    if (!safetyNumber) return
    await setVerifiedSafetyNumber(peerUserId, safetyNumber)
    void queryClient.invalidateQueries({ queryKey: ['secret-verified', peerUserId] })
    setShowVerify(false)
  }

  async function handleReverify() {
    try {
      await clearVerified(peerUserId)
      await cryptoClearSession(peerUserId)
      clearKeyChanged(peerUserId)
      void queryClient.invalidateQueries({ queryKey: ['secret-verified', peerUserId] })
      requestSecretDrain()
      setShowVerify(true)
    } catch {
      toast.error('не удалось сбросить сессию')
    }
  }

  async function handleSend(text: string) {
    const trimmed = text.trim()
    if (!trimmed || keyChanged) return
    try {
      await sendSecretText(peerUserId, trimmed)
      void queryClient.invalidateQueries({ queryKey: secretMessagesKey(peerUserId) })
      void queryClient.invalidateQueries({ queryKey: ['secret-peers'] })
    } catch {
      toast.error('не удалось отправить')
    }
  }

  function dismissOnboarding() {
    setShowOnboarding(false)
    void markOnboardingSeen()
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-kd-bg">
      {/* шапка */}
      <div className="px-3 py-2 border-b border-kd-border bg-kd-panel-alt flex items-center gap-2.5 shrink-0">
        {onBack && (
          <button type="button" onClick={onBack} title="назад" className="shrink-0 text-kd-text-soft hover:text-kd-text transition-colors p-0.5">
            <Icon.ArrowLeft size={22} />
          </button>
        )}
        <Avatar name={name} avatarUrl={profile?.avatarUrl ?? null} size={38} status={status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[15px] font-bold text-kd-text truncate">{name}</span>
            {verified && (
              <span className="inline-flex items-center gap-1 text-[9px] font-mono font-bold text-kd-online bg-kd-accent-bg px-1.5 py-px rounded shrink-0">
                <Icon.Check size={9} /> проверено
              </span>
            )}
          </div>
          <div className="text-[10px] font-mono mt-px text-kd-accent">
            {typingVisible ? 'печатает…' : '🔒 секретный · только на этом устройстве'}
          </div>
        </div>
        <button type="button" onClick={() => setShowVerify(true)} title="сверка ключей" className="shrink-0 text-kd-text-mute hover:text-kd-text p-0.5">
          <Icon.More size={20} />
        </button>
      </div>

      {/* лента */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-1.5 flex flex-col">
        {showOnboarding && <DeviceBoundOnboarding onDismiss={dismissOnboarding} />}
        {keyChanged ? (
          <KeyChangedBanner name={name} onVerify={handleReverify} />
        ) : establishing ? (
          <EstablishingBanner />
        ) : (
          <ProtectedBanner />
        )}
        {establishError && !keyChanged && (
          <div className="mx-4 my-2 px-3 py-2 rounded-kd bg-kd-panel-alt border border-kd-danger text-[11px] text-kd-danger">
            {establishError}
          </div>
        )}
        <SecretMessageList messages={messages} peerName={name} peerAvatarUrl={profile?.avatarUrl ?? null} />
      </div>

      {/* composer */}
        <SecretComposer disabled={keyChanged} onSend={handleSend} peerUserId={peerUserId} />

      {showVerify && (
        <KeyVerification
          peerName={name}
          peerAvatarUrl={profile?.avatarUrl ?? null}
          safetyNumber={safetyNumber}
          verified={verified}
          onMarkVerified={handleVerifyConfirm}
          onClose={() => setShowVerify(false)}
        />
      )}
    </div>
  )
}

function SecretMessageList({
  messages, peerName, peerAvatarUrl,
}: {
  messages: StoredSecretMessage[]
  peerName: string
  peerAvatarUrl: string | null
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [messages.length])

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-10 gap-2 text-center">
        <div className="w-14 h-14 rounded-2xl bg-kd-warm-bg border border-dashed border-kd-warm text-kd-warm flex items-center justify-center">
          <Icon.Lock size={24} />
        </div>
        <div className="text-[15px] font-bold text-kd-text">секретный чат пуст</div>
        <div className="text-[12px] text-kd-text-soft max-w-[280px] leading-relaxed">
          напишите первое сообщение — оно уйдёт зашифрованным и осядет только на ваших устройствах.
        </div>
      </div>
    )
  }

  const rows: React.ReactNode[] = []
  let prevTs: number | null = null
  for (const m of messages) {
    if (prevTs === null || !sameDay(prevTs, m.sentAtMs)) {
      rows.push(<DayDivider key={`day-${m.id}`} label={formatDay(m.sentAtMs)} />)
    }
    rows.push(<SecretBubble key={m.id} message={m} peerName={peerName} peerAvatarUrl={peerAvatarUrl} />)
    prevTs = m.sentAtMs
  }
  return (
    <>
      {rows}
      <div ref={bottomRef} className="h-1" />
    </>
  )
}

// «Печатает» уходит не чаще раза в 3 с за набор (как в облачном Composer).
const TYPING_THROTTLE_MS = 3_000

function SecretComposer({
  disabled,
  onSend,
  peerUserId,
}: {
  disabled: boolean
  onSend: (text: string) => void
  peerUserId: string
}) {
  const [value, setValue] = useState('')
  const lastTypingSentRef = useRef(0)
  const submit = () => {
    const v = value.trim()
    if (!v || disabled) return
    onSend(v)
    setValue('')
  }
  // Typing-конверт (T-103): шифрованный, эфемерный. sendTyping сам no-op без
  // установленной сессии — набор текста не должен поднимать PQXDH.
  const notifyTyping = () => {
    if (disabled || !value.trim()) return
    const now = Date.now()
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return
    lastTypingSentRef.current = now
    void sendTyping(peerUserId).catch(() => { /* контрол-конверт — best effort */ })
  }
  return (
    <div className="px-3 py-2 shrink-0 kd-safe-bottom">
      {disabled && (
        <div className="text-[10px] font-mono text-kd-danger mb-1.5 text-center">
          отправка заблокирована — сверьте ключ заново
        </div>
      )}
      <div className="bg-kd-panel rounded-kd px-2.5 py-2 flex items-center gap-2.5 border border-kd-border">
        <Icon.Lock size={18} className="text-kd-text-mute shrink-0" />
        <input
          value={value}
          onChange={(e) => { setValue(e.target.value); notifyTyping() }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          disabled={disabled}
          placeholder={disabled ? 'сверьте ключ, чтобы продолжить' : 'напиши…'}
          className="flex-1 bg-transparent border-none outline-none text-[14px] text-kd-text font-sans py-0.5 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || value.trim().length === 0}
          title="отправить"
          className="w-9 h-9 rounded-full bg-kd-accent text-white flex items-center justify-center shrink-0 hover:bg-kd-accent-deep disabled:bg-kd-text-mute disabled:opacity-50 transition-colors"
        >
          <Icon.Send size={17} />
        </button>
      </div>
      <div className="text-[9px] font-mono text-kd-text-mute mt-1.5 flex items-center justify-center gap-1.5">
        <Icon.Lock size={9} /> E2EE · device-bound
      </div>
    </div>
  )
}
