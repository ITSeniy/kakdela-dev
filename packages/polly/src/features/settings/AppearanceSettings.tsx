// Страница «внешний вид» (designs/final-settings.jsx → FinalSettings).
// Тема, акцентный цвет, плотность сообщений, скругление углов.

import { Field } from '../../components/form/Field.js'
import { Swatch } from '../../components/form/Swatch.js'
import { Toggle } from '../../components/form/Toggle.js'
import { ACCENTS, UI_SCALES, useAppearance } from './appearance.js'
import { DensityPicker } from './DensityPicker.js'
import { ThemePicker } from './ThemePicker.js'

export function AppearanceSettings() {
  const accentId = useAppearance((s) => s.accentId)
  const hoverHighlight = useAppearance((s) => s.hoverHighlight)
  const reduceMotion = useAppearance((s) => s.reduceMotion)
  const uiScale = useAppearance((s) => s.uiScale)
  const setAccent = useAppearance((s) => s.setAccent)
  const setHoverHighlight = useAppearance((s) => s.setHoverHighlight)
  const setReduceMotion = useAppearance((s) => s.setReduceMotion)
  const setUiScale = useAppearance((s) => s.setUiScale)

  return (
    <div className="flex flex-col gap-[18px]">
      <Field label="тема" hint="следуем системе или фиксируем вручную">
        <ThemePicker />
      </Field>

      <Field label="акцентный цвет" hint="используется в активных каналах, кнопках и ссылках">
        <div role="radiogroup" aria-label="акцентный цвет" className="flex gap-3.5 flex-wrap">
          {ACCENTS.map((a) => (
            <Swatch
              key={a.id}
              color={a.color}
              label={a.label}
              active={a.id === accentId}
              onClick={() => setAccent(a.id)}
            />
          ))}
        </div>
      </Field>

      <Field label="плотность" hint="как близко друг к другу располагаются сообщения">
        <DensityPicker />
      </Field>

      <Field label="масштаб" hint="размер всего интерфейса — применяется сразу">
        <div role="radiogroup" className="flex bg-kd-panel border border-kd-border rounded-kd p-[3px] gap-0.5">
          {UI_SCALES.map((s) => {
            const active = s.id === uiScale
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setUiScale(s.id)}
                className={[
                  'flex-1 px-2.5 py-2 rounded text-center transition-colors',
                  active ? 'bg-kd-panel-hi' : 'hover:bg-kd-panel-soft',
                ].join(' ')}
              >
                <div className={`text-[12px] font-semibold ${active ? 'text-kd-text' : 'text-kd-text-soft'}`}>
                  {s.label}
                </div>
              </button>
            )
          })}
        </div>
      </Field>

      <Field label="прочее">
        <Toggle
          on={hoverHighlight}
          onChange={setHoverHighlight}
          label="подсветка при наведении"
          hint="заливка строки под курсором — в чате и списках голосовых"
        />
        <Toggle
          on={reduceMotion}
          onChange={setReduceMotion}
          label="уменьшить движение"
          hint="отключает анимации интерфейса (поверх системной настройки)"
        />
      </Field>

      <div className="px-3.5 py-3 bg-kd-warm-bg border border-kd-warm-soft rounded-kd text-[12px] text-kd-text flex items-center gap-2.5">
        <span className="text-[18px]">🌿</span>
        <span>настройки внешнего вида сохраняются на этом устройстве.</span>
      </div>
    </div>
  )
}
