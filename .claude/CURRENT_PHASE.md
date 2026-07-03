# CURRENT_PHASE

> Этот файл обновляется руками каждый раз, когда мы переходим к новой фазе или серии задач.
> Claude Code читает его, чтобы понимать «где мы сейчас» и не предлагать фичи из будущего.

## ✅ Фаза 0 — Фундамент — **ЗАВЕРШЕНА**

Монорепо, docker-compose, `/healthz`, Tauri-окно, ginzu-типы, drizzle-миграция — всё готово.

## ✅ Фаза 1 — Текстовый дом — **ЗАВЕРШЕНА**

Auth, инвайты, сервер, каналы, сообщения, WebSocket real-time, шелл, markdown, presence, переключение тем — всё готово.

## ✅ Фаза 2 — Голос — **ЗАВЕРШЕНА**

Guido (LiveKit-токены), `/api/voice/*` эндпоинты, webhook participant_joined/left, клиентский useVoiceRoom + UI голосового канала, push-to-talk, active speaker, корректный teardown — всё готово.

## ✅ Фаза 3 — Демонстрация экрана — **ЗАВЕРШЕНА** ⭐ MVP достигнут

Screen share через LiveKit: кнопка «демо», grid layout с тайлами, bitrate-настройки (auto / 1080p30 / 720p30), скриншот кадра → MinIO → ephemeral чат, корректный teardown. T-050a (захват системного звука на Win10/11) — код готов, статус ждёт ручного прогона (см. ARCHITECTURE.md §3.5).

## ✅ Фаза 4 — Социалка — **ЗАВЕРШЕНА**

Reactions, replies, edit/delete, attachments (T-063 — с magic-bytes валидацией), DM (T-064 — отдельная dm_channels таблица, hot-attach по WS), Inbox с упоминаниями (T-065 — `mentions` таблица + `mention-extractor`, auto-mark-read через IntersectionObserver), поиск через postgres tsvector + GIN (T-066), профиль участника как модалка с avatar-cropper и сменой пароля (T-068). **T-067 (Web Push) — пропущен**, доделается отдельно: для self-host'а на 15-20 друзей менее критично, чем threads.

---

## Сейчас: **Фаза 5 — Полировка**

### Цель фазы

Превратить «работает» в «приятно». Threads для длинных обсуждений, custom emoji, видео с камеры, бэкапы и аудит-лог для админа. После этой фазы продукт ощущается законченным.

### Статус задач фазы 5 (актуализировано 2026-05-24 после аудита)

- [x] T-080 — Threads: schema (`parentChannelId`/`parentMessageId`/`archivedAt`), backend routes, ThreadPanel sidebar, ThreadBadge на parent сообщении, hot-attach по WS.
- [x] T-081 — Custom emoji: server-scope, upload PNG/GIF (magic-bytes + ≤256KB + ≤128×128), `:name:` shortcode в markdown, picker tab «Сервер», EmojiManagement в settings.
- [x] T-082 — Аудит-лог: таблица `audit_log`, `routes/audit.ts`, `AuditLog.tsx` в server settings, инфраструктура для записи действий.
- [x] T-083 — Multi-server UI: `POST /servers`, CreateServerModal, JoinServerModal, ServerRail кнопка «+», InviteManagement, GeneralSettings (rename/leave/delete), **WelcomeScreen** (post-auth hub, переехал из T-013).
- [x] T-084 — Бэкапы: `ops/backup/` с backup.sh + restore.sh + Dockerfile + cron @ 04:00 UTC, pg_dump.gz + MinIO mirror + ротация 14 дней, off-site rsync опционально.
- [x] T-085 — Шумоподавление: noiseSettings store (persist), VoiceSettings toggle, useNoiseSuppressionSync через MediaTrackConstraints (не WASM — упрощено для MVP, см. карточку T-085).
- [x] T-086 — Native OS notifications + tray: `lib/host/notify.ts` + `lib/host/tray.ts`, Tauri tray icon + badge, debounce 60s на канал, click → focus + jump.
- [ ] T-067 — Web Push: пропущен intentionally (карточка сама говорит «можно пропустить для desktop»).

### Дополнительные задачи (добавлены 2026-05-24 после аудита фаз 1-4)

- [x] T-087 — Звонок и демо экрана в DM: action-кнопки в DmScreen, voice room `dm-${id}`, IncomingCall toast, decline/cancel. **Реализовано** (ветка feat/phase-6-mobile); остаётся ручной A→B прогон на двух клиентах (см. карточку).
- [ ] T-088 — DM welcome card («начало переписки с <name>, вы оба в <X>, <Y>») при пустом DM.
- [ ] T-089 — Профиль: timezone + about (расширение `users`, рендер в ProfileModal с «МСК · 11:24»).
- [ ] T-090 — Кастомные роли: per-server теги с цветами (`server_roles` + `member_role_assignments`), pills в профиле, admin-UI. **Большая фича — обсудить с юзером, нужна ли вообще для 15-20 друзей.**
- [ ] T-091 — Search filters UI: channel / author / date sidebar. Backend уже принимает параметры (T-066).
- [ ] T-092 — Toast-система: `lib/toast.ts` через sonner или самописный, замена `console.error` + `window.confirm` на toast с undo.
- [~] T-093 — Надёжность голоса/демо: TURN/TURNS на проде, UDP-mux, VP9+SVC+contentHint для демки, RED/DTX для голоса, диагностика `kdVoiceStats()`. **Код готов, typecheck чистый; остаётся ручной прогон на VPS** (TURNS-серт + звонок с другого NAT, см. карточку). Решение «не мигрировать на Mediasoup, не писать свой SFU» — осознанное (обсуждение 2026-06-29).
- [~] T-094 — Нативный захват звука для демонстрации (Windows/WASAPI), по-дискордовски. **Stage 0/A/B + Stage C шаг 1 — код готов.** Stage 0: `RtlGetVersion` → ступень + билд (порог Win10 19041). Stage A: системный loopback. Stage B: process-loopback (`ActivateAudioInterfaceAsync` + handler + PROPVARIANT/blob) — **прогнан на железе, звук только нужного процесса**. Stage C (C1, WebView) — **весь код готов**: шаг 1 транспорт Rust→JS (прогнан, 561/563 КБ), шаг 2 JS-сink `nativeAudioTrack.ts` (ArrayBuffer→AudioData→MSTG→живой трек, прогнан — звук чистый), шаг 3 интеграция в `useScreenShare` (нативный звук публикуется как ScreenShareAudio на Windows + teardown во всех путях; заменяет getDisplayMedia-audio T-050a). typecheck + cargo check чистые. **Остаётся прогон шага 3 на двух клиентах A→B** (B слышит системный звук A при «смотреть»). Эхо от системного loopback решено пикером (см. ниже). Транспорт остаётся LiveKit.
- [~] T-095 — Пикер демонстрации «как в Discord» (2026-07-02). Кнопка «демо» открывает модал `ScreenSharePicker.tsx`: плитки источника звука (без звука / **звук окна — дефолт** / вся система / конкретное звучащее приложение, live-список раз в 2 с) + качество + «в эфир» → системный выбор окна/экрана (программно выбрать видео-источник WebView2 не даёт — см. ARCHITECTURE.md §3.5). «Звук окна» (audioSource `auto`) — автопривязка: заголовок окна из `track.label` матчится на pid через новую команду `audio_list_windows` (EnumWindows), захватывается звук именно транслируемого приложения; весь экран / opaque-label / нет матча → фолбэк на весь системный звук. Persist-миграция v0→v1 переводит старый дефолт `system` на `auto`. ▾-меню настроек демо и рестарт «на лету» убраны — качество выбирается в пикере перед стартом. typecheck + cargo check чистые; **остаётся ручной прогон**: (а) шарим окно с YouTube → у зрителя только его звук, в логе `[voice] auto audio: … -> pid`; (б) шарим весь экран → системный звук; (в) проверить, что `track.label` в WebView2 — заголовок окна, не opaque-ID (иначе авто тихо падает на «вся система» — тоже рабочий режим).

### Заметка: «видео с камеры»

В предыдущей версии этого файла T-082 был ошибочно записан как «Видео с камеры». Реальная карточка `tasks/T-082.md` — это аудит-лог. Если функционал camera-track в голосовом канале нужен — он логически попадает в T-087 (DM voice + video) или может быть выделен отдельной задачей T-093.

### Чего НЕ делаем в этой фазе

- Friends list / friend requests — мы all-friends-by-default, не нужны.
- Discovery / server listing — не маркетплейс.
- E2EE на desktop / для cloud-каналов — overkill, ломает поиск и превью. **Сквозное шифрование появляется только в секретных чатах мобильного клиента (Фаза 6, device-bound) и не затрагивает desktop, cloud-DM и поиск.**
- AutoMod, аналитика, server insights, Activities — out forever.

### Что прочесть Claude Code перед задачей

1. `ARCHITECTURE.md` §12 (Фаза 5 roadmap, если ещё нет — добавить), §5 (data flow), §6 (DB schema)
2. `.claude/CONVENTIONS.md`
3. Эту страницу
4. Карточку задачи `tasks/T-XXX.md`
5. Файлы из «Files in scope» в карточке

---

## Следующая фаза — **Фаза 6 — Мобильный клиент / Секретные чаты**

> Статус: **запланирована**. Карточки T-100…T-103 готовы, старт реализации — по команде.
> Дизайн-референс всего мобильного приложения — Claude Design (см. блок «Дизайн-контекст» ниже),
> будет оформлен как `designs/final-mobile.jsx`.

### Видение

Android-клиент — **личный мессенджер 1:1, НЕ «мобильный Discord»**. На мобиле нет серверов,
каналов, серверных голос-комнат и демо экрана. Две поверхности:

- **Cloud-DM** (незашифрованные) — единственное, что стыкуется с desktop-версией. Те же
  сообщения на телефоне и на десктопе.
- **Секретные чаты** (E2EE через libsignal, **device-bound**) — живут только на устройстве,
  на desktop не уезжают; потеря телефона = потеря истории (by design).

Голос на мобиле — только **звонок 1:1 внутри DM** (LiveKit `dm-${id}`, T-087), не серверная комната.

### Задачи

- [ ] T-100 — Android bootstrap (`tauri android init`, мобильный shell, Android-ветка host-layer). Sonnet.
- [ ] T-101 — Крипто-ядро: libsignal в Rust, ключи в Android Keystore, сервер как слепой каталог prekey'ев. **Opus high (security).**
- [ ] T-102 — Транспорт: сервер-слепой релей шифр-конвертов + зашифрованная локальная история на устройстве. **Opus high (security).**
- [ ] T-103 — Мобильный UI секретных чатов + верификация (safety number). Sonnet.

### Чего НЕ делаем в Фазе 6

- Серверов / каналов на мобиле — нет (это личный мессенджер).
- Групповых секретных чатов (MLS) — нет, только 1:1.
- Мульти-девайс / синк ключей / бэкап секретной истории — нет (device-bound).
- E2EE для cloud-DM и desktop — нет; шифруются только отдельные секретные чаты на мобиле.
- iOS — нет (Android-first).

### Дизайн-контекст (Claude Design)

Макет всего мобильного приложения ведётся в Claude Design:
- Проект: `7d516a7f-52f6-4e07-87ad-e853d6957f1f`, файл `designs/КакДела мобильное.html`.
- Подключение: claude_design MCP (`https://api.anthropic.com/v1/design/mcp`, auth через `/design-login`).
- При реализации T-100/T-103 сверяться с этим макетом, не выдумывать элементы из головы.
