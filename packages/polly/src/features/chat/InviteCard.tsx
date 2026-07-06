// Карточка приглашения на сервер: рендерится под сообщением, где есть
// инвайт-ссылка (в ЛС и в каналах). Показывает иконку/имя сервера и число
// участников, кнопка «присоединиться» (или «перейти», если уже состоишь).

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'

import { toast } from '../../components/toast/index.js'
import { acceptInvite, getInvitePublic, listServers } from '../servers/api.js'

// /invite/<code> или ?invite=<code>; код — 6..12 символов из base32-алфавита.
const INVITE_RE = /(?:\/invite\/|[?&]invite=)([a-z0-9]{6,12})/gi

/** URL ведёт на приглашение — его OG-превью избыточно (карточка уже есть). */
export function isInviteUrl(url: string): boolean {
  INVITE_RE.lastIndex = 0
  return INVITE_RE.test(url)
}

/**
 * Сообщение состоит только из инвайт-ссылок (плюс пробелы): текст — «служебный»,
 * его прячем и показываем одну карточку приглашения.
 */
export function isInviteOnlyContent(content: string): boolean {
  if (extractInviteCodes(content).length === 0) return false
  const rest = content.replace(/https?:\/\/\S+/gi, (url) => (isInviteUrl(url) ? '' : url))
  return rest.trim() === ''
}

/** Уникальные коды инвайтов из текста (не больше 3 карточек на сообщение). */
export function extractInviteCodes(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  INVITE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INVITE_RE.exec(content)) !== null) {
    const code = m[1]!.toLowerCase()
    if (!seen.has(code)) {
      seen.add(code)
      out.push(code)
    }
  }
  return out.slice(0, 3)
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[340px] p-2.5 rounded-kd bg-kd-panel-alt border border-kd-border flex items-center gap-3">
      {children}
    </div>
  )
}

function InviteCard({ code }: { code: string }) {
  const [, navigate] = useLocation()
  const queryClient = useQueryClient()
  const [joining, setJoining] = useState(false)

  const { data: servers } = useQuery({ queryKey: ['servers'], queryFn: listServers, staleTime: 30_000 })
  const { data: invite, isLoading, isError } = useQuery({
    queryKey: ['invite', code],
    queryFn: () => getInvitePublic(code),
    staleTime: 30_000,
    retry: false,
  })

  if (isLoading) {
    return <CardShell><span className="text-[11px] font-mono text-kd-text-mute py-3">загружаем приглашение…</span></CardShell>
  }
  if (isError || !invite) {
    return (
      <CardShell>
        <span className="w-10 h-10 rounded-kd bg-kd-panel border border-kd-border flex items-center justify-center text-kd-text-mute shrink-0">✕</span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-kd-text">приглашение недействительно</div>
          <div className="text-[10px] font-mono text-kd-text-mute">истекло, отозвано или исчерпано</div>
        </div>
      </CardShell>
    )
  }

  const isMember = servers?.some((s) => s.id === invite.serverId) ?? false

  async function join() {
    if (!invite) return
    setJoining(true)
    try {
      await acceptInvite(code)
      await queryClient.invalidateQueries({ queryKey: ['servers'] })
      navigate(`/servers/${invite.serverId}`)
    } catch {
      toast.error('не удалось присоединиться — приглашение могло устареть')
    } finally {
      setJoining(false)
    }
  }

  return (
    <CardShell>
      <div className="w-10 h-10 rounded-kd bg-kd-accent text-white flex items-center justify-center text-[15px] font-bold shrink-0 overflow-hidden">
        {invite.serverIcon
          ? <img src={invite.serverIcon} alt="" className="w-full h-full object-cover" />
          : invite.serverName.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[9px] font-mono text-kd-text-mute uppercase tracking-[0.05em]">приглашение на сервер</div>
        <div className="text-[13px] font-bold text-kd-text truncate">{invite.serverName}</div>
        <div className="text-[10px] font-mono text-kd-text-mute">
          {invite.memberCount} {invite.memberCount === 1 ? 'участник' : 'участников'}
        </div>
      </div>
      {isMember ? (
        <button
          type="button"
          onClick={() => navigate(`/servers/${invite.serverId}`)}
          className="shrink-0 px-3 py-1.5 rounded-kd bg-kd-panel border border-kd-border text-[11px] font-semibold text-kd-text hover:bg-kd-panel-hi transition-colors"
        >
          перейти
        </button>
      ) : (
        <button
          type="button"
          disabled={joining}
          onClick={() => void join()}
          className="shrink-0 px-3 py-1.5 rounded-kd bg-kd-accent text-white text-[11px] font-semibold hover:bg-kd-accent-deep disabled:opacity-50 transition-colors"
        >
          {joining ? '…' : 'присоединиться'}
        </button>
      )}
    </CardShell>
  )
}

/** Рендерит карточки для всех инвайт-ссылок в тексте сообщения (или ничего). */
export function InviteEmbeds({ content }: { content: string }) {
  const codes = extractInviteCodes(content)
  if (codes.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {codes.map((code) => <InviteCard key={code} code={code} />)}
    </div>
  )
}
