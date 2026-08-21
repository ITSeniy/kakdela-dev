// Единый набор колонок канала для всех мест, где собирается Channel-DTO
// (server detail, GET/PATCH/POST channel, WS channel.create/update). Держим в
// одном месте, чтобы новые поля «настроек канала» не забывались в части роутов.

import { channels } from '../db/schema.js'

export const CHANNEL_DTO_COLS = {
  id:             channels.id,
  serverId:       channels.serverId,
  name:           channels.name,
  kind:           channels.kind,
  category:       channels.category,
  topic:          channels.topic,
  position:       channels.position,
  parentChannelId: channels.parentChannelId,
  // Признак треда для клиента: deep-link на сообщение треда (из инбокса/
  // поиска/тостов) без этого поля не может понять, что канал — тред.
  parentMessageId: channels.parentMessageId,
  slowModeSec:    channels.slowModeSec,
  autoDeleteSec:  channels.autoDeleteSec,
  isDefault:      channels.isDefault,
  friendsOnly:    channels.friendsOnly,
  nsfw:           channels.nsfw,
  threadsAllowed: channels.threadsAllowed,
} as const
