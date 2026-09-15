import { useEffect, useRef } from 'react'

import type { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client'

import { Avatar } from '../../components/Avatar.js'

import { ScreenShareDiagnostics } from './ScreenShareDiagnostics.js'
import { useScreenShareStats } from './use-screen-share-stats.js'

interface ScreenTileProps {
  displayName: string
  isSelf: boolean
  /** Карточка сейчас развёрнута на всю область. */
  focused?: boolean
  busy?: boolean
  /** Компакт для нижней полосы: только видео + имя, без кнопок и бейджа. */
  compact?: boolean
  /** Кто сейчас смотрит эту демку — стопка аватарок внизу-справа. */
  watchers?: Array<{ name: string; avatarUrl: string | null }>
  onClick?(): void
  onSnapshot?(): void
  /** Перестать смотреть (только чужие демки). */
  onStopWatching?(): void
  screenTrack: LocalVideoTrack | RemoteVideoTrack
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

function PipIcon() {
  // Картинка-в-картинке: большой прямоугольник + маленький в углу.
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

// PiP поддерживается в WebView2/Chromium; в прочих средах кнопку прячем.
const PIP_SUPPORTED =
  typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled

/**
 * Карточка демки (отдельная от карточки человека, как в Discord). Клик —
 * развернуть на всю область / свернуть обратно; двойной клик — нативный
 * fullscreen. Видео attach'ится через LiveKit API — SDK сам управляет
 * `srcObject` и lifecycle. На unmount обязателен detach (тот же track может
 * оказаться в другом tile'е после ре-раскладки).
 *
 * Self-preview MUST быть muted: иначе ScreenShareAudio из своего же source'а
 * вернётся в наушники через спикеры. Для чужих экранов аудио рулится
 * deafen'ом на уровне Room (см. applyDeafenVolume).
 */
export function ScreenTile({
  displayName,
  isSelf,
  focused,
  busy,
  compact,
  watchers,
  onClick,
  onSnapshot,
  onStopWatching,
  screenTrack,
}: ScreenTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { sample, history } = useScreenShareStats(screenTrack, videoRef, isSelf, !compact)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    screenTrack.attach(el)
    return () => {
      try { screenTrack.detach(el) } catch { /* SDK already detached */ }
    }
  }, [screenTrack])

  const toggleFullscreen = (): void => {
    const container = containerRef.current
    if (!container) return
    if (document.fullscreenElement === container) {
      void document.exitFullscreen().catch(() => { /* ignore */ })
    } else {
      // requestFullscreen может реджектиться, если вызов не из user gesture
      // или fullscreen уже занят. Не паникуем — просто игнорируем.
      void container.requestFullscreen().catch(() => { /* ignore */ })
    }
  }

  // Picture-in-Picture: выносит демку в плавающее всегда-сверху окно — можно
  // продолжать смотреть, переключаясь на другие каналы/окна.
  const togglePip = (): void => {
    const el = videoRef.current
    if (!el) return
    const doc = document as Document & { pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> }
    const v = el as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }
    if (doc.pictureInPictureElement === el) {
      void doc.exitPictureInPicture?.().catch(() => { /* ignore */ })
    } else {
      void v.requestPictureInPicture?.().catch(() => { /* not allowed / no frames yet */ })
    }
  }

  return (
    <div
      ref={containerRef}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick() } : undefined}
      onDoubleClick={compact ? undefined : toggleFullscreen}
      title={compact ? displayName : focused ? 'свернуть' : 'развернуть на всю область'}
      className={[
        'group relative w-full h-full rounded-lg overflow-hidden bg-kd-stage min-w-0 min-h-0',
        compact ? 'min-h-[72px]' : '',
        onClick ? 'cursor-pointer' : '',
      ].join(' ')}
      style={{
        boxShadow: focused
          ? '0 0 0 2px var(--kd-warm), var(--kd-shadow-tile)'
          : 'var(--kd-shadow-tile)',
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isSelf}
        className="absolute inset-0 w-full h-full object-contain"
      />

      {/* Имя + LIVE-бейдж — внизу-слева, всегда видны. */}
      <div className="absolute left-1.5 bottom-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded font-mono bg-kd-overlay-strong text-kd-stage-text max-w-[85%]">
        <span className="text-[10px] font-semibold truncate">{displayName}</span>
        <span className="text-[9px] font-bold text-kd-warm shrink-0">· LIVE</span>
      </div>

      {/* Кто смотрит — стопка аватарок внизу-справа. */}
      {!compact && watchers && watchers.length > 0 && (
        <div
          className="absolute right-1.5 bottom-1.5 flex items-center pl-1 pr-2 py-1 rounded-lg bg-kd-overlay-strong"
          title={`смотрят: ${watchers.map((w) => w.name).join(', ')}`}
        >
          {watchers.slice(0, 4).map((w, i) => (
            <span key={i} className={i > 0 ? '-ml-2 ring-2 ring-kd-stage rounded-full' : 'ring-2 ring-kd-stage rounded-full'}>
              <Avatar name={w.name} avatarUrl={w.avatarUrl} size={28} />
            </span>
          ))}
          {watchers.length > 4 && (
            <span className="ml-1.5 text-[11px] font-mono font-bold text-kd-stage-text">+{watchers.length - 4}</span>
          )}
        </div>
      )}

      {!compact && <ScreenShareDiagnostics sample={sample} history={history} />}

      {/* Hover-оверлей с кнопками. Прячем opacity'ью, чтобы не дёргать DOM
          на каждое движение мыши. */}
      {!compact && (
        <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {onStopWatching && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onStopWatching()
              }}
              title="перестать смотреть"
              className="inline-flex items-center justify-center px-1.5 h-6 rounded bg-kd-overlay-strong text-kd-stage-text text-[9px] font-mono"
            >
              ✕ стрим
            </button>
          )}
          {onSnapshot && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (!busy) onSnapshot()
              }}
              disabled={busy}
              title={busy ? 'отправляется…' : 'снимок в чат звонка'}
              className="inline-flex items-center justify-center w-6 h-6 rounded bg-kd-overlay-strong text-kd-stage-text disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CameraIcon />
            </button>
          )}
          {PIP_SUPPORTED && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                togglePip()
              }}
              title="картинка-в-картинке"
              className="inline-flex items-center justify-center w-6 h-6 rounded bg-kd-overlay-strong text-kd-stage-text"
            >
              <PipIcon />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              toggleFullscreen()
            }}
            title="на весь экран (двойной клик тоже работает)"
            className="inline-flex items-center justify-center w-6 h-6 rounded bg-kd-overlay-strong text-kd-stage-text"
          >
            <ExpandIcon />
          </button>
        </div>
      )}
    </div>
  )
}
