// Форматтеры профиля. Вынесены из ProfileModal.tsx, чтобы переиспользовать в
// полноэкранном мобильном профиле (MobileProfileScreen).

// «с нами с осени 2023» — сезон читается теплее точного месяца.
export function fmtJoined(iso: string): string {
  const d = new Date(iso)
  const m = d.getMonth() + 1
  const season = m <= 2 || m === 12 ? 'зимы' : m <= 5 ? 'весны' : m <= 8 ? 'лета' : 'осени'
  // Декабрьская зима относится к следующему году по ощущению, но год
  // оставляем календарный — «с зимы 2023» для 2023-12 читается верно.
  return `${season} ${d.getFullYear()}`
}

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/** «7 июля» из «MM-DD»; null при кривом значении. */
export function fmtBirthday(mmdd: string): string | null {
  const [mm, dd] = mmdd.split('-').map(Number)
  if (!mm || !dd || mm > 12) return null
  return `${dd} ${MONTHS_GEN[mm - 1]}`
}

/** Сегодня ли день рождения (сравнение в локальной таймзоне смотрящего). */
export function isBirthdayToday(mmdd: string | null | undefined): boolean {
  if (!mmdd) return false
  const now = new Date()
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return mmdd === today
}

/** «МСК · 11:24» — короткое имя пояса + текущее время там. */
export function fmtTzNow(tz: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('ru', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).formatToParts(new Date())
    const get = (type: string) => parts.find((p) => p.type === type)?.value
    const hour = get('hour')
    const minute = get('minute')
    const name = get('timeZoneName')
    if (!hour || !minute) return null
    return `${name ?? tz} · ${hour}:${minute}`
  } catch {
    return null
  }
}
