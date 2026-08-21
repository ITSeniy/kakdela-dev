// Общие типы media-слоя (guido). Держим их отдельно от guido.ts,
// чтобы клиентские роуты могли импортировать только типы без подтягивания
// тяжёлого livekit-server-sdk.

export interface VoiceTokenIssueArgs {
  userId: string
  channelId: string
  displayName: string
  /**
   * Стабильный id устройства клиента. Задан → LiveKit identity будет
   * `userId:deviceId`: два устройства одного аккаунта — два независимых
   * участника комнаты, а не «второй выбил первого» (аудит 2026-08, C-2).
   * Не задан (старый клиент) → identity = userId, как раньше.
   */
  deviceId?: string
  /**
   * Явное имя LiveKit-комнаты. По умолчанию `voice-${channelId}`; DM-звонок
   * (T-087) передаёт `dm-${channelId}`, чтобы комната жила в отдельном
   * неймспейсе (webhook её намеренно игнорит, см. media/webhook.ts).
   */
  room?: string
  canPublish?: boolean
  canSubscribe?: boolean
  canPublishData?: boolean
}

export interface VoiceToken {
  token: string
  url: string
  room: string
}

export interface VoiceParticipant {
  userId: string
  displayName: string
  joinedAt: string
  isPublishing: boolean
  isScreenSharing: boolean
  isMuted: boolean
}

export interface VoiceRoom {
  channelId: string
  room: string
  participants: VoiceParticipant[]
}

// Кладётся в JSON-метадате LiveKit-токена. В webhook'ах распарсим обратно
// и узнаем, какой userId за каким participant'ом стоит.
export interface VoiceTokenMetadata {
  userId: string
}
