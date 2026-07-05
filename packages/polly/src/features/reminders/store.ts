// «Напомнить об этом»: локальные (per-device) напоминания о сообщениях.
// Persist-стор + планировщик: раз в 30 секунд ищем просроченные, шлём
// нативное уведомление с deep-link на сообщение и убираем из списка.
// Если клиент был закрыт в момент срабатывания — напоминание догоняет
// при следующем запуске (проверка на маунте).

import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { notify } from '../../lib/host/notify.js'
import { playSound } from '../sounds/sounds.js'

export interface Reminder {
  id: string
  messageId: string
  /** Путь для перехода по клику: `/servers/…/channels/…#msg:id` или `/dm/…#msg:id`. */
  link: string
  /** Кто написал сообщение — заголовок тоста. */
  authorName: string
  /** Обрезанный текст сообщения — тело тоста. */
  preview: string
  dueAt: number
}

interface RemindersState {
  reminders: Reminder[]
  add(r: Reminder): void
  remove(id: string): void
}

export const useReminders = create<RemindersState>()(
  persist(
    (set) => ({
      reminders: [],
      add: (r) => set((s) => ({ reminders: [...s.reminders, r] })),
      remove: (id) => set((s) => ({ reminders: s.reminders.filter((r) => r.id !== id) })),
    }),
    { name: 'kd:reminders' },
  ),
)

/** Пресеты для контекст-меню: подпись → момент срабатывания. */
export function reminderPresets(): { label: string; dueAt: number }[] {
  const now = Date.now()
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(10, 0, 0, 0)
  return [
    { label: 'через 1 час',    dueAt: now + 3_600_000 },
    { label: 'через 3 часа',   dueAt: now + 3 * 3_600_000 },
    { label: 'завтра в 10:00', dueAt: tomorrow.getTime() },
  ]
}

export function addReminder(r: Omit<Reminder, 'id'>): void {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  useReminders.getState().add({ ...r, id })
}

const CHECK_INTERVAL_MS = 30_000

function fireDue(): void {
  const { reminders, remove } = useReminders.getState()
  const now = Date.now()
  for (const r of reminders) {
    if (r.dueAt > now) continue
    remove(r.id)
    playSound('notification')
    void notify({
      title: 'напоминание',
      body: r.preview ? `${r.authorName}: ${r.preview}` : `сообщение от ${r.authorName}`,
      tag: `remind:${r.id}`,
      navigateTo: r.link,
    })
  }
}

/** Монтируется один раз (App): тикает планировщик напоминаний. */
export function useReminderScheduler(): void {
  useEffect(() => {
    fireDue() // догоняем просроченные после закрытого клиента
    const t = setInterval(fireDue, CHECK_INTERVAL_MS)
    return () => clearInterval(t)
  }, [])
}
