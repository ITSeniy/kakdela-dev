// Выбор дня рождения без года: два селекта (день + месяц) и «не указывать».
// Значение — «MM-DD» (как хранит сервер) либо null.

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const SELECT_CLS = 'bg-kd-bg border border-kd-border rounded px-2.5 py-2 text-[12px] text-kd-text outline-none focus:border-kd-accent appearance-none cursor-pointer'

export function BirthdaySelect({
  value, onChange,
}: {
  value: string | null
  onChange: (v: string | null) => void
}) {
  const [mm, dd] = value ? value.split('-').map(Number) : [null, null]

  function update(nextMm: number | null, nextDd: number | null) {
    if (nextMm === null || nextDd === null) {
      onChange(null)
      return
    }
    const maxDay = DAYS_IN_MONTH[nextMm - 1] ?? 31
    const day = Math.min(nextDd, maxDay)
    onChange(`${String(nextMm).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={dd ?? ''}
        onChange={(e) => update(mm ?? 1, e.target.value === '' ? null : Number(e.target.value))}
        className={SELECT_CLS}
      >
        <option value="">—</option>
        {Array.from({ length: mm ? (DAYS_IN_MONTH[mm - 1] ?? 31) : 31 }, (_, i) => (
          <option key={i + 1} value={i + 1}>{i + 1}</option>
        ))}
      </select>
      <select
        value={mm ?? ''}
        onChange={(e) => update(e.target.value === '' ? null : Number(e.target.value), dd ?? 1)}
        className={`${SELECT_CLS} flex-1`}
      >
        <option value="">—</option>
        {MONTHS.map((name, i) => (
          <option key={name} value={i + 1}>{name}</option>
        ))}
      </select>
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[11px] font-mono text-kd-text-mute hover:text-kd-text-soft transition-colors shrink-0"
        >
          убрать
        </button>
      )}
    </div>
  )
}
