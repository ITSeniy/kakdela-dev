import type { Attachment, ClipEmbed, GifEmbed, StickerRef } from '@kakdela/ginzu/api-types'

export interface PendingMessage {
  id: string
  channelId: string
  authorId: string
  content: string
  replyToId: string | null
  createdAt: string
  editedAt: null
  attachments: Attachment[]
  gif?: GifEmbed | null
  sticker?: StickerRef | null
  clip?: ClipEmbed | null
  _pending: 'sending' | 'error'
  _nonce: string
}
