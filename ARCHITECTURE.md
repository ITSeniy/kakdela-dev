# КакДела — архитектурный документ

> Self-hosted уютный «дискорд» на 15–20 друзей. MVP-цель: голосовой канал с демонстрацией экрана.
> Кодовая тема: **Samurai Pizza Cats** (для имён сервисов и пакетов, а не пользовательского UI).

---

## 0. TL;DR (что мы строим, одной страницей)

* **Продукт для пользователя** — приложение «как дела?» (KD). Тёплая бежево-коричневая тема, серверы, текстовые и голосовые каналы, демонстрация экрана. Self-host на одном VPS.
* **Аудитория** — *одна* конкретная компания на 15–20 человек, все на Windows. Это сильно меняет требования: не нужны масштабирование, антиспам, дискавери серверов, премиум-фичи. Нужны *доверие, надёжность, низкая задержка* и пара «фирменных» уютных деталей.
* **Архитектурный слоган** — «делаем то, что Discord, без того, что есть в Discord только для $$$ и масштаба».
* **Клиент — десктопное приложение на Tauri 2** (Windows-first, Linux-задел). React/TS внутри, как обычно, но обёрнут в нативное окно. См. §3.5.
* **Технологический выбор без сюрпризов**: TypeScript везде, PostgreSQL, Redis, **LiveKit как WebRTC-SFU** (это ключевое решение), MinIO для файлов, всё в `docker-compose`.
* **Подход к разработке**: «вайб-код» по фазам — каждая фаза имеет чёткие *задачи-карточки* с DoD (definition of done), которые можно скопировать в Claude Code как промпты. Для разных типов задач — разные модели (Opus / Sonnet / Haiku).

---

## 1. Кодовые имена — Samurai Pizza Cats

Имена применяются к **сервисам, пакетам и репозиториям**. Пользовательские термины остаются нормальными русскими словами («сервер», «канал», «комната») — иначе никому, кроме тебя, не будет понятно.

| Кодовое имя | Что это | Почему |
|---|---|---|
| **speedy** | основной backend (REST + WebSocket gateway) | Speedy Cerviche — лидер пиццакотов, быстрый, командует |
| **polly** | веб-клиент (React + Vite) | Polly Esther — следит за внешним видом и стилем |
| **guido** | media-сервис (обвязка LiveKit, токены, комнаты) | Guido Anchovy — романтик и шумный, как голосовой чат |
| **francine** | миграции БД, сидинг, ETL-утилиты | Francine Manx — секретарша, держит документы в порядке |
| **ginzu** | shared package — общие TS-типы, протоколы, валидация | Магический меч Ginzu — общий «инструмент» для всех |
| **big-cheese** | admin CLI / TUI (создать инвайт, забанить, ребэкап) | The Big Cheese — главный антагонист, у него вся власть |
| **bad-bird** | будущий поиск/индексер (Postgres FTS → потом MeiliSearch) | Bad Bird налетает на сообщения — а индексер «налетает» на тексты |
| **pizza-parlor** | корневой repo с docker-compose, инфра, gh-actions | Cat's Eye Pizza — общее заведение, где все живут |

Это **необязательная** надстройка. Если в какой-то день надоест — заменишь на скучные `api`, `web`, `media` за час, всё импортируется из `package.json`. Кодовые имена живут только в названиях директорий и npm-скоупов: `@kakdela/speedy`, `@kakdela/polly`, и т. д.

**Что НЕ называем по-кошачьи**: таблицы БД, API-эндпоинты, переменные окружения, имена в UI. Иначе через три месяца сам не вспомнишь, что такое `BAD_BIRD_URL`.

---

## 2. MVP-скоуп vs всё остальное

Discord — гигантский продукт. Чтобы не утонуть, разделим фичи на **5 фаз**. Каждая фаза — это то, что *хочется и приятно показать*, законченный кусок.

### Легенда
- 🟢 — MVP, обязательно
- 🟡 — желательно после MVP
- 🔵 — приятно, на будущее
- ⚪ — не делаем никогда (для self-host группы друзей это лишнее)

### Фаза 1 — «Текстовый дом» 🟢

Минимум, чтобы можно было поздороваться.

- 🟢 Регистрация и вход по логину/паролю (один админ инвайтит остальных через ссылку)
- 🟢 Один сервер «по умолчанию» при первом запуске, без UI создания серверов
- 🟢 Текстовые каналы (создание/переименование/удаление — только админом)
- 🟢 Отправка сообщений, real-time через WebSocket
- 🟢 Список участников сервера, presence (online / offline)
- 🟢 Markdown в сообщениях (жирный, курсив, код, ссылки)
- 🟢 Эмодзи (системные, не custom)
- 🟢 История сообщений (пагинация при скролле вверх)
- 🟢 Базовые роли: `owner`, `admin`, `member`
- 🟢 Светлая / тёмная тема из дизайна (токены уже есть)

### Фаза 2 — «Голос» 🟢

- 🟢 Голосовые каналы (join/leave)
- 🟢 LiveKit-комната на канал (создаётся при первом джойне, убивается через N минут после ухода всех)
- 🟢 Mute / deafen, индикатор говорящего (active speaker)
- 🟢 Push-to-talk и voice-activated (выбор в настройках)
- 🟢 Чат «только в комнате» (ephemeral, привязан к голосовой сессии)

### Фаза 3 — «Демонстрация экрана» 🟢 ⭐ MVP-цель

- 🟢 Share экрана через LiveKit (`screen_share` + `screen_share_audio`)
- 🟢 Видеть до 5 одновременных демонстраций (grid layout как в `final-voice.jsx`)
- 🟢 Качество: 1080p / 30fps по умолчанию, fallback на 720p при слабой сети
- 🟢 Скриншот текущего кадра демки в чат комнаты (✂ из дизайна)
- 🟢 Корректный teardown при выходе/закрытии вкладки

**Этим заканчивается MVP**. Дальше — ништяки.

### Фаза 4 — «Социалка» 🟡

- 🟡 Reactions на сообщения (системные эмодзи)
- 🟡 Replies / цитаты
- 🟡 Edit / delete своих сообщений
- 🟡 Pinned messages в канале
- 🟡 Загрузка файлов и картинок (через MinIO, превью картинок и `<video>` инлайн)
- 🟡 Drag-and-drop / paste из буфера обмена
- 🟡 DM (личные сообщения 1:1) + групповые DM
- 🟡 Inbox с упоминаниями и ответами (экран уже есть)
- 🟡 Поиск по сообщениям (Postgres FTS на старте, MeiliSearch когда станет медленно)
- 🟡 Уведомления в браузере (Web Push API)
- 🟡 Профиль участника (модалка, экран есть)
- 🟡 Custom-статусы («сплю», «работаю», «варю кофе»)

### Фаза 5 — «Полировка» 🔵

- 🔵 Threads на сообщения
- 🔵 Custom emoji (загрузка PNG/GIF)
- 🔵 Аудит-лог сервера
- 🔵 Несколько серверов в одном инстансе (UI создания/выбора, рельса серверов уже работает)
- 🔵 Бэкапы БД и медиа по cron, восстановление одной командой
- 🔵 i18n (русский, английский — в дизайне всё русское, что замечательно для группы друзей)
- 🔵 Видео с камеры (не только демонстрация экрана)
- 🔵 Шумоподавление (Krisp SDK или RNNoise)
- 🔵 Системный трей с минимизацией в трей (Tauri trayicon plugin)
- 🔵 Native OS-уведомления (Tauri notification plugin) — на Windows показывает в action center
- 🔵 Deep links (`kakdela://channel/...`) для быстрого джампа из других приложений
- 🔵 Webhooks (для интеграций — github, ci, цитата дня)

### ⚪ Не делаем никогда

Это то, что в Discord есть, но для нас бессмысленно:

- Discovery / Server Listing (мы не маркетплейс)
- Nitro / премиум / boost'ы
- Activities (игры внутри звонка)
- AutoMod (15 человек договорятся словами)
- Stages / Forum channels (для группы друзей перегруз)
- Бот-маркетплейс, app directory
- Социальный граф «друзья», friend requests (все и так друг друга знают)
- Аналитика, server insights
- E2EE (звучит круто, но в реальности для группы друзей на своём сервере overkill и сильно ломает поиск/превью/etc.)
- Голосовая видеосвязь с десятками неизвестных людей (LiveKit умеет, но мы не оптимизируем под это)

---

## 3. Архитектура системы

### 3.1 Высокоуровневая схема

```
                ┌────────────────────────────┐
                │  polly (Tauri 2 + React)   │
                │  десктоп для Windows/Linux │
                │  ├─ WebView2 (Win) / WebKit│
                │  └─ Rust shell (нативное   │
                │     окно, трей, keychain)  │
                └────┬────────┬──────────────┘
                     │        │
             HTTPS / WSS      │ WebRTC (UDP)
                     │        │
                     ▼        ▼
                ┌──────────────┐ ┌──────────────────┐
                │ speedy       │ │  livekit-server  │
                │ Fastify      │ │ (SFU)            │
                │ - REST API   │ │ guido = тонкая   │
                │ - WS Gateway │◄┤ обвязка для      │
                │ - Auth       │ │ выдачи токенов   │
                └──┬───────────┘ └──────────────────┘
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
   ┌─────────┐ ┌──────┐  ┌────────┐
   │postgres │ │redis │  │ minio  │
   │  data   │ │ pres │  │ files  │
   └─────────┘ └──────┘  └────────┘

   Всё за Caddy reverse proxy с автоматическим TLS.
   Клиент скачивается с GitHub Releases как .msi / .deb / .AppImage.
```

### 3.2 Сервисы и их обязанности

#### `speedy` (Fastify, Node 20+, TypeScript)
- HTTP REST (см. §6.1): аутентификация, CRUD каналов/сообщений/участников, медиа-метаданные.
- WebSocket Gateway: real-time события (новые сообщения, presence, печатает-индикаторы, изменения состояния голосового канала).
- Auth: argon2id для паролей, JWT access (15 мин) + refresh (30 дней, ротация).
- **Source of truth** для всего, кроме медиапотока.
- Выдача LiveKit-токенов (через `livekit-server-sdk`).
- Rate limiting в Redis (per-IP и per-user).
- Health-чек `/healthz` для Caddy.

#### `guido` (LiveKit, Docker-образ + наш небольшой wrapper в speedy)
В первой итерации **отдельного сервиса не пишем** — берём готовый `livekit-server` Docker-образ и из speedy выдаём JWT-токены через LiveKit SDK. «guido» как кодовое имя живёт в файле `speedy/src/media/guido.ts` — модуль, отвечающий за выдачу токенов, конфиг комнат, webhooks от LiveKit (для обновления presence).

Если в будущем понадобится: своя логика записи звонков, кастомный SFU и т. п. — выделим в отдельный сервис.

#### `polly` (Tauri 2 + React 19 + Vite + TypeScript)
- **Десктопное приложение**, не браузер. Windows-first, Linux как побочный выход того же кода.
- TanStack Query для server state (кэш сообщений, инвалидация по WS-событиям).
- Zustand для UI state (открытый канал, тема, draft сообщения).
- React Router v7 для роутов.
- LiveKit client SDK для голоса и экрана.
- Все компоненты из `final-*.jsx` пересобираются в нормальный React с TypeScript + Tailwind (токены из дизайна выносим в CSS-переменные).
- **JWT-токены** хранятся не в localStorage, а через `tauri-plugin-stronghold` (Windows Credential Manager / Linux secret-service / macOS Keychain). Web-фолбэк — `sessionStorage`.
- **Auto-update** через встроенный Tauri Updater (подписанные релизы с GitHub Releases).

См. §3.5 про специфику Tauri.

#### `francine` (CLI на Node.js)
- `francine migrate` — применить миграции БД (drizzle-kit).
- `francine seed` — добавить тестовых пользователей и сообщения для разработки.
- `francine invite create --email --role` — сгенерировать инвайт-ссылку.
- `francine backup` — pg_dump + sync minio в локальный архив.

#### `big-cheese` (тот же CLI, но админ-операции в проде)
- `big-cheese promote <user> admin`
- `big-cheese kick <user>`
- `big-cheese channel create <name>`
- В будущем можно сделать TUI на Ink — это уже эстетика для души.

### 3.3 Почему LiveKit, а не Mediasoup / Janus / своё

| Кандидат | Плюсы | Минусы | Вердикт |
|---|---|---|---|
| **LiveKit** | Open-source, есть готовый Docker, JS SDK first-class, screen share «из коробки», webhook'и, токены через JWT, документация | Чуть больше памяти, чем чистый mediasoup | ✅ **Выбираем** |
| Mediasoup | Лёгкий, гибкий | Низкоуровневый, всю комнатную логику пишешь сам, SDK есть только Node.js (на клиенте — `mediasoup-client`), для MVP много работы | Нет |
| Jitsi/Janus | Готовые | Тяжёлые, заточены под другие сценарии | Нет |
| Своё на raw WebRTC | Романтика | На 15 человеках не нужна mesh-топология, нужен SFU, см. mediasoup | Нет |
| Matrix/Synapse | Готовый чат + voice (Element Call) | Дикий overkill, своя экосистема, идентификаторы юзеров через `@user:server.tld`, заметная learning curve | Нет |

### 3.4 Развёртывание

Один VPS, типовая конфигурация на 15–20 человек:
- 2 vCPU, 4 GB RAM, 80 GB SSD — хватит с запасом
- Ubuntu 24.04 LTS
- Caddy (TLS + reverse proxy)
- Docker + docker-compose

`docker-compose.yml` поднимает:
- `postgres:17`
- `redis:7-alpine`
- `minio/minio`
- `livekit/livekit-server:latest`
- `kakdela-speedy` (наш билд)

`polly` **не в Docker** — это десктоп-клиент, который раздаётся друзьям как `.msi` для Windows и `.deb` / `.AppImage` для Linux, собирается через CI и публикуется в GitHub Releases.

Caddy наружу слушает `:443`:
- `kakdela.example.com/api/*` → speedy:3001
- `kakdela.example.com/ws` → speedy:3001 (WebSocket upgrade)
- `kakdela.example.com/livekit/*` → livekit-server:7880 (WSS — только signaling)
- `kakdela.example.com/files/*` → minio:9000

**Важно про LiveKit**: для UDP-трафика (медиа) лучше прокидывать порты напрямую (`livekit-server` слушает 7881 TCP, 50000-50100 UDP), а не через Caddy. Иначе будет latency и потери. В compose'е делаем `network_mode: host` для livekit-server, либо явно публикуем диапазон UDP-портов.

### 3.5 Tauri — специфика клиента

**Почему Tauri 2, а не Electron**:
- ~10 МБ инсталлятор против ~100 МБ — приятнее друзьям при первой установке
- Кросс-платформа из коробки: один источник кода → `.msi` / `.deb` / `.AppImage`
- Память: ~150 МБ RAM в покое против ~400+ у Electron
- Современный стек (Rust + WebView), активная разработка

**Риск и митигация**:
Главный страх — поддержка `getDisplayMedia` (демонстрация экрана) в WebView2 на Windows. На Windows 10/11 с актуальным WebView2 Runtime API работает, в том числе выбор окна и захват системного звука. **Если** в какой-то момент поймаем edge-кейс, который WebView2 не покрывает, — мигрируем на Electron. Бизнес-логика на React, миграция = ~день работы. Всё, что специфично для Tauri, изолировано в `packages/polly/src-tauri/` и `packages/polly/src/lib/host/`.

**Транспорт голоса/демо — осознанный выбор (T-093):** остаёмся на LiveKit, **не** мигрируем на Mediasoup и не пишем свой SFU — оба SFU на одном libwebrtc-фундаменте, «рассыпание» лечится не сменой движка, а сетью/egress/энкодом. Что сделано для надёжности: TURN/TURNS на проде (реле для симметричного NAT, см. `docs/DEPLOY.md §3a`), UDP-mux вместо port-range, VP9+SVC+`contentHint` для демки (плавная деградация, чёткость текста), RED/DTX для голоса (устойчивость к packet loss), диагностика `collectVoiceStats()`/`getConnectionQuality()` в `lib/livekit.ts`. Кастомный нативный захват аудио процесса (WASAPI, по-дискордовски) — отдельный заход **T-094**, при этом SFU остаётся LiveKit (кастомный трек публикуется в существующую комнату). Stage 0 (определение возможностей ОС) уже в коде: `src-tauri/src/audio/mod.rs` через `RtlGetVersion` классифицирует ступень захвата — system-loopback везде (Vista+), process-loopback с Windows 10 build 19041 (version 2004). Это НЕ Win11-only: per-process работает на современных Win10. Захват PCM и мост в WebRTC — следующие стадии.

**T-094 — текущий статус (нативный звук демки).** Пайплайн собран и работает: WASAPI process-loopback (`ActivateAudioInterfaceAsync`) → PCM 48к/16/стерео → `Channel` сырыми байтами → `AudioData` → `MediaStreamTrackGenerator` → публикация как `ScreenShareAudio` в существующую LiveKit-комнату (`useScreenShare.ts`, `nativeAudioTrack.ts`). Это надёжно заменяет хрупкий `getDisplayMedia({audio:true})` (T-050a) на Windows и решает эхо: кнопка «демо» открывает **Discord-style пикер** (`ScreenSharePicker.tsx`) — плитки источника звука («без звука» / «звук окна» / «вся система» / конкретное приложение; список «звучащих» приложений через `IAudioSessionManager2`, live-обновление раз в 2 с, выбор хранится по имени exe и резолвится в живой pid при старте демо) плюс выбор качества и «в эфир», после чего открывается системный выбор окна/экрана. Дефолт — **«звук окна» (auto)**: после публикации видео заголовок окна из `track.label` матчится на pid через `audio_list_windows` (`EnumWindows` + toolhelp), и захватывается звук именно транслируемого приложения; весь экран / opaque-label / отсутствие матча → фолбэк на весь системный звук. Команда перечисления `audio_list_sessions` обязана быть `async`+`spawn_blocking`: COM-цикл на главном (STA) потоке падает с `RPC_E_CHANGED_MODE` и список оказывается пуст (`audio_list_windows` — чистый user32/toolhelp, ему это не нужно).

**Видео демки остаётся на `getDisplayMedia` — осознанное решение (2026-06-30).** Кастомный «как в Discord» пикер окон в WebView2 дёшево невозможен: Electron даёт `desktopCapturer` + `setDisplayMediaRequestHandler` (JS подсовывает выбранный источник, а захват и энкод делает сам Chromium), а WebView2 такой ручки не имеет — событие `ScreenCaptureStarting` умеет только allow/cancel/deferral, а свитч `--auto-select-desktop-capture-source` статичен при создании окружения. Полностью нативный путь (Windows.Graphics.Capture → кадры в JS-трек, зеркально звуку) технически возможен, но даёт лишний round-trip GPU→CPU→GPU на каждый кадр, реалистичный потолок ~720p и выше CPU/латентность — это регресс качества против VP9+SVC/1080p из T-093. Поэтому видео берём родным пикером WebView2 (он эффективен и умеет выбрать окно), а уникальная ценность нативного пути — звук одного приложения — реализована отдельным `ScreenShareAudio`-треком.

**Захват системного звука — статус** (T-050a):
Аудио к screen share живёт отдельной публикацией (`Track.Source.ScreenShareAudio`). Браузеры умеют его отдавать **только для выбора «экран целиком» или «вкладка»** — выбор отдельного окна почти везде даёт video-only. На Linux/`webkit2gtk` audio не поддерживается вообще (известное ограничение GTK-стека).

Клиент пробует `setScreenShareEnabled(true, { audio: true })` и сразу проверяет, появилась ли `ScreenShareAudio` публикация. Результат кэшируется в `useScreenShareSettings.audioCaptureSupported` (`null | true | false`) и переживает рестарты — на «холодном» входе UI сразу показывает корректное состояние toggle «со звуком». Если попытка с `audio:true` падает на `OverconstrainedError` / `NotSupportedError`, делается прозрачный retry с `audio:false` и флаг помечается `false`.

Реальный результат тестирования (заполняется после ручного прогона `pnpm tauri dev` на каждой платформе):

- **Windows 11** (WebView2 Runtime ≥ актуальный): _TBD — заполнить после прогона по чек-листу из T-050a (экран целиком / окно YouTube / вкладка)_
- **Windows 10**: _TBD — если есть к чему ставить_
- **Linux (`webkit2gtk`)**: ожидаемо НЕ работает — `getDisplayMedia` либо отсутствует, либо отдаёт только видео. Это known limitation, не баг.

**Структура polly**:
- `packages/polly/src/` — React-приложение (Vite). Это и есть «начинка».
- `packages/polly/src-tauri/` — Rust-обвязка. Минимум — открытие окна, плагины (os, stronghold, updater, notifications, deep-link). Бизнес-логику в Rust **не** пишем.
- `packages/polly/src/lib/host/` — абстракция над «нативными» возможностями. Дев-режим в браузере (`pnpm dev:web`) использует моки. В Tauri — реальные вызовы `invoke()`.

**Windows-инсталлятор**:
- `pnpm tauri build` создаёт `.msi` (через WiX) и `.exe` (через NSIS) в `target/release/bundle/`.
- **Code signing**: для группы друзей можно жить без подписи (Windows SmartScreen покажет предупреждение «неизвестный издатель» при первом запуске — друзьям объясним один раз).
- Если захочется подписать — нужен EV-сертификат от DigiCert/Sectigo (~$300/год). Для self-host друзей — overkill.
- **WebView2 Runtime**: на Windows 11 уже стоит, на Windows 10 — почти везде через Windows Update. Tauri MSI умеет тащить WebView2 bootstrapper, если что (флаг `wix.fragmentPaths`).

**Linux-задел**:
- `pnpm tauri build --bundles deb,appimage` — два формата сразу.
- `.deb` для Ubuntu/Debian-based, `.AppImage` — портативный (никакой установки, скачал и запустил).
- Linux Tauri использует `webkit2gtk`, требует пакеты системы (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, etc., см. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).
- Если когда-нибудь захотим macOS — `pnpm tauri build --bundles dmg`, потребуется Mac в CI.

**Auto-update**:
- Tauri имеет встроенный updater. Релизы публикуются в GitHub Releases с JSON-манифестом `latest.json`.
- Клиент проверяет манифест при старте, скачивает дельту, перезапускается.
- Подписание апдейтов — обязательно (Tauri хочет собственную keypair, генерируется через `pnpm tauri signer generate`). Без подписи updater не работает.

**Хранение секретов**:
- `tauri-plugin-stronghold` — обёртка над платформенным keychain'ом.
- JWT refresh-токен лежит там, не в localStorage. localStorage используется только для UI-настроек (тема, размер шрифта).

---

## 4. Модель данных (PostgreSQL)

Минимальная нормализованная схема. Используем `drizzle-orm` (типобезопасность из коробки, миграции через `drizzle-kit`).

```
users
  id          uuid pk
  username    text unique
  display_name text
  email       text unique
  password_hash text
  avatar_url  text null
  status      text  -- 'online' | 'idle' | 'dnd' | 'offline'
  custom_status text null
  created_at  timestamptz
  last_seen_at timestamptz

servers
  id          uuid pk
  name        text
  icon_url    text null
  created_at  timestamptz

server_members
  server_id   uuid fk
  user_id     uuid fk
  role        text  -- 'owner' | 'admin' | 'member'
  joined_at   timestamptz
  pk (server_id, user_id)

channels
  id          uuid pk
  server_id   uuid fk
  name        text
  kind        text  -- 'text' | 'voice'
  category    text null  -- для группировки в UI
  topic       text null
  position    int
  created_at  timestamptz

messages
  id          uuid pk
  channel_id  uuid fk
  author_id   uuid fk
  content     text
  reply_to_id uuid null fk
  created_at  timestamptz
  edited_at   timestamptz null
  deleted_at  timestamptz null

  index (channel_id, created_at desc)

reactions          -- фаза 4
  message_id  uuid fk
  user_id     uuid fk
  emoji       text
  created_at  timestamptz
  pk (message_id, user_id, emoji)

attachments        -- фаза 4
  id          uuid pk
  message_id  uuid fk
  filename    text
  mime        text
  size        bigint
  storage_key text   -- ключ в MinIO
  width       int null
  height      int null

invites
  code        text pk
  server_id   uuid fk
  created_by  uuid fk
  expires_at  timestamptz null
  max_uses    int null
  uses        int default 0

voice_sessions     -- эпhemeral, можно в Redis вместо PG
  channel_id  uuid
  user_id     uuid
  joined_at   timestamptz
  pk (channel_id, user_id)
```

**Презенс и «печатает»** — целиком в Redis, никаких таблиц. Они меняются часто, в PG им нечего делать.

**Ephemeral voice chat** — тоже в Redis (LIST с TTL на канал), переезжает в PG только если решим хранить историю обсуждений в голосе.

---

## 5. Реал-тайм протоколы

### 5.1 WebSocket события (между polly и speedy)

После WS-handshake клиент шлёт `{type: "hello", token}`. Дальше обмен JSON-сообщениями.

**Сервер → клиент:**

```typescript
type ServerEvent =
  | { t: 'ready'; user: User; servers: Server[] }
  | { t: 'msg.new'; channelId: string; message: Message }
  | { t: 'msg.edit'; channelId: string; messageId: string; content: string; editedAt: string }
  | { t: 'msg.delete'; channelId: string; messageId: string }
  | { t: 'presence'; userId: string; status: 'online' | 'idle' | 'dnd' | 'offline' }
  | { t: 'typing'; channelId: string; userId: string }
  | { t: 'voice.join'; channelId: string; userId: string }
  | { t: 'voice.leave'; channelId: string; userId: string }
  | { t: 'voice.state'; channelId: string; userId: string; muted: boolean; screen: boolean }
  | { t: 'channel.create'; channel: Channel }
  | { t: 'channel.update'; channel: Channel }
  | { t: 'channel.delete'; channelId: string }
  | { t: 'member.join'; member: ServerMember }
  | { t: 'member.leave'; userId: string }
  | { t: 'reaction.add'; messageId: string; emoji: string; userId: string }
  | { t: 'reaction.remove'; messageId: string; emoji: string; userId: string }
```

**Клиент → сервер:**

```typescript
type ClientEvent =
  | { t: 'hello'; token: string }
  | { t: 'typing'; channelId: string }
  | { t: 'presence'; status: 'online' | 'idle' | 'dnd' }
  | { t: 'ping' }    // каждые 30s, иначе сервер дропает
```

Всё, что *создаёт данные* (отправка сообщения, реакция, edit), идёт через **REST**, а не через WS. Так проще: одна точка валидации, обычные коды ошибок, retry. WS отвечает только за «эй, что-то изменилось — обнови».

### 5.2 LiveKit (медиа)

1. Клиент жмёт «зайти в голосовой» → REST `POST /api/voice/:channelId/join` → speedy создаёт/находит LiveKit-комнату, генерирует JWT-токен с правами `canPublish`, `canSubscribe`, `canPublishData`.
2. Клиент подключается через `livekit-client` SDK напрямую к `wss://kakdela.example.com/livekit`.
3. Демо экрана: `room.localParticipant.setScreenShareEnabled(true)`.
4. Webhooks от LiveKit на `POST /api/internal/livekit-webhook` обновляют presence и шлют WS-события остальным («Маша начала демонстрацию»).

---

## 6. API контракты

### 6.1 REST (краткий список, чтобы при разработке знать «что есть»)

```
POST   /api/auth/register        — только с инвайт-кодом
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/servers              — список серверов пользователя
GET    /api/servers/:id          — детали + каналы + участники
POST   /api/servers              — создать (фаза 5)

POST   /api/servers/:id/invites  — создать инвайт-ссылку
GET    /api/invites/:code        — посмотреть инвайт (для preview)
POST   /api/invites/:code/accept — присоединиться

GET    /api/channels/:id/messages?before=&limit=50
POST   /api/channels/:id/messages
PATCH  /api/messages/:id
DELETE /api/messages/:id
POST   /api/messages/:id/reactions  body: { emoji }
DELETE /api/messages/:id/reactions/:emoji

POST   /api/channels              body: { serverId, name, kind }
PATCH  /api/channels/:id
DELETE /api/channels/:id

POST   /api/voice/:channelId/join — возвращает LiveKit token
POST   /api/voice/:channelId/leave

POST   /api/upload                — multipart, возвращает storage_key для последующего сообщения
GET    /api/files/:key            — прокси к MinIO (или signed URL)
```

### 6.2 Соглашения
- Все ответы JSON, ошибки в формате `{error: {code, message}}`.
- Пагинация по cursor (`before=<message_id>`), не по offset.
- Snake_case в БД, **camelCase в API и фронте** (преобразование в drizzle/zod-схемах).

---

## 7. Структура репозитория (монорепо)

```
pizza-parlor/                        ← git root
├── package.json                     ← npm workspaces
├── docker-compose.yml
├── docker-compose.dev.yml
├── Caddyfile
├── .env.example
├── README.md
├── КакДела_ARCHITECTURE.md          ← этот файл
├── designs/                          ← jsx из Claude Design, для референса
│
├── packages/
│   ├── ginzu/                        ← shared types
│   │   ├── src/
│   │   │   ├── api-types.ts          ← Message, User, Channel, etc.
│   │   │   ├── ws-events.ts          ← ServerEvent, ClientEvent
│   │   │   └── design-tokens.ts      ← KD_LIGHT, KD_DARK as TS
│   │   └── package.json              ← name: "@kakdela/ginzu"
│   │
│   ├── speedy/                       ← backend
│   │   ├── src/
│   │   │   ├── index.ts              ← Fastify bootstrap
│   │   │   ├── routes/               ← REST endpoints
│   │   │   ├── ws/                   ← WebSocket gateway
│   │   │   ├── db/                   ← drizzle schemas, queries
│   │   │   ├── media/guido.ts        ← LiveKit token issuing
│   │   │   ├── auth/                 ← jwt, argon2, sessions
│   │   │   └── lib/redis.ts
│   │   ├── drizzle/                  ← миграции
│   │   ├── Dockerfile
│   │   └── package.json              ← "@kakdela/speedy"
│   │
│   ├── polly/                        ← desktop client (Tauri 2)
│   │   ├── src/                       ← React-приложение
│   │   │   ├── main.tsx
│   │   │   ├── app/                   ← Router, layout
│   │   │   ├── features/
│   │   │   │   ├── auth/
│   │   │   │   ├── chat/
│   │   │   │   ├── voice/
│   │   │   │   ├── members/
│   │   │   │   └── settings/
│   │   │   ├── components/            ← UI: Avatar, ServerIcon, ...
│   │   │   ├── lib/
│   │   │   │   ├── api.ts             ← REST client
│   │   │   │   ├── ws.ts              ← WS client
│   │   │   │   ├── livekit.ts
│   │   │   │   └── host/              ← абстракция над Tauri API
│   │   │   └── styles/tokens.css      ← CSS-переменные из KD_LIGHT/KD_DARK
│   │   ├── src-tauri/                 ← Rust-обвязка
│   │   │   ├── src/main.rs
│   │   │   ├── src/lib.rs
│   │   │   ├── Cargo.toml
│   │   │   ├── tauri.conf.json
│   │   │   ├── build.rs
│   │   │   ├── capabilities/          ← Tauri 2 ACL
│   │   │   └── icons/                 ← .ico / .png / .icns
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.ts
│   │   └── package.json               ← "@kakdela/polly"
│   │
│   ├── francine/                     ← миграции/сидинг CLI
│   │   └── ... (один файл, по сути)
│   │
│   └── big-cheese/                   ← админский CLI
│       └── ...
│
└── ops/
    ├── caddy/Caddyfile.prod
    ├── livekit/livekit.yaml
    └── backups/backup.sh
```

---

## 8. Дизайн-токены — как переносим из jsx в проект

В `common.jsx` и `final-chrome.jsx` уже есть всё необходимое. Переносим в `packages/polly/src/styles/tokens.css`:

```css
:root[data-theme="light"] {
  --kd-bg:       #e8e0cc;
  --kd-bg-deep:  #ddd3bd;
  --kd-panel:    #f0e8d4;
  /* ... все 25 токенов из KD_LIGHT */
}
:root[data-theme="dark"] {
  --kd-bg:       #1a1610;
  --kd-bg-deep:  #13100c;
  /* ... все из KD_DARK */
}

:root {
  --kd-font:   "Inter", -apple-system, system-ui, sans-serif;
  --kd-mono:   "JetBrains Mono", ui-monospace, monospace;
  --kd-radius: 6px;
}
```

Tailwind подцепит их через `theme.extend.colors`:

```ts
// tailwind.config.ts
colors: {
  kd: {
    bg:       'var(--kd-bg)',
    'bg-deep':'var(--kd-bg-deep)',
    panel:    'var(--kd-panel)',
    accent:   'var(--kd-accent)',
    warm:     'var(--kd-warm)',
    /* ... */
  }
}
```

Так дизайн становится «нормальным» Tailwind'ом (`bg-kd-panel text-kd-text`), но при этом темы переключаются через `data-theme` на `<html>`.

---

## 9. Анализ дизайнов — что есть, чего не хватает

### ✅ Готовые экраны в архиве

| Файл | Назначение | Готовность |
|---|---|---|
| `final-auth.jsx` | Вход/регистрация | Достаточно для фазы 1 |
| `final-onboarding.jsx` | Присоединиться/создать сервер | Достаточно |
| `final-chrome.jsx` | Шелл: рельса серверов, список каналов, список участников, message, composer | Идеально — реюзается на всех экранах |
| `final-chat.jsx` | Главный чат | Достаточно для фазы 1 |
| `final-voice.jsx` | Голосовой канал + screen share + чат комнаты | ⭐ Идеально для MVP |
| `final-dm.jsx` | DM | Для фазы 4 |
| `final-inbox.jsx` | Упоминания/ответы/треды | Для фазы 4 |
| `final-profile.jsx` | Профиль (модалка) | Для фазы 4 |
| `final-settings.jsx` | Настройки | Для фазы 5 (части — раньше) |

### 📭 Чего я бы добавил в Claude Design

Не блокирует MVP, но рано или поздно понадобится:

1. **Модалка «Пригласить друзей»** — генерация ссылки, копирование, срок действия. Нужно с самого начала, потому что без неё никто не зарегистрируется.
2. **Командная палитра (⌘K)** — поиск по каналам и участникам. Реально удобно даже на 5 каналах. Чем-то похожа на спотлайт в macOS.
3. **Состояния соединения** — toast «соединение потеряно, переподключаемся…», баннер «вы офлайн». На свой сервер ходить через wi-fi кафе — это будет случаться.
4. **Лайтбокс для картинок и видео** — на полный экран, со стрелками. Нужно как только появятся вложения (фаза 4).
5. **Модалка создания/настройки канала** — иначе админ не сможет добавить новый. Сейчас в `final-settings.jsx` есть «каналы и роли» в навигации, но содержание не прорисовано.
6. **Mobile / адаптивный шелл** — рельса серверов и список каналов как drawer'ы. Для десктоп-клиента (Tauri) это не блокер, но для мобильных всё равно когда-то понадобится. Самый дешёвый путь — отдельный мобильный клиент через Tauri Mobile (iOS/Android из того же React-кода, beta) или web-фолбэк, который собирается из `polly/src/` без `src-tauri/`. До фазы 5 — не наша забота.
7. **Пустые состояния** — «канал пустой, напиши первым», «ни одного упоминания», «нет файлов». Чисто эстетика, но в духе тёплого «как дела?».
8. **Окно загрузки/прогресса файла** — placeholder в композере, пока файл льётся в MinIO.

**Лайфхак для генерации в Claude Design**: ты уже задал стиль ('тёплый, бежевый, моноширинные акценты, плотный'). Чтобы новые экраны попадали в этот же стиль, скажи прямо: «продолжи мир «как дела?», палитра/шрифты как в final-chrome.jsx, токены KD_LIGHT/KD_DARK, плотность та же, моноширинные подписи для технических данных».

---

## 10. Как работать с Claude Code — модели, effort, формат задач

### 10.1 Когда какая модель

| Тип задачи | Модель | Reasoning effort |
|---|---|---|
| Сложная архитектура, дизайн протокола, выбор подхода к WebRTC, аудит безопасности, нетривиальные баги в гонках состояний/синхронизации | **Opus 4.7** | `high` («think hard», «ultrathink») |
| Реализация фичи по чёткому спеку, рефакторинг, написание тестов, миграции БД, новый эндпоинт по образцу существующего, UI-компонент из дизайна | **Sonnet 4.6** | `medium` (дефолт) |
| Мелкие правки, опечатки, переименование, генерация скучного boilerplate, формат кода, regex, простые скрипты, обновление зависимостей | **Haiku 4.5** | `low` или off |

Эмпирическое правило: **«если бы я мог делегировать это джуну с двухчасовым онбордингом — это Haiku. Мидл-разработчику без вопросов — Sonnet. Если задача требует «давай обсудим, как это правильно сделать» — Opus»**.

Подожди с моими утверждениями про конкретные модели — проверь актуальные. Цены/возможности меняются.
<br>

### 10.2 Формат таска для вайб-кода

Чтобы Claude Code не плавал, каждая задача оформляется как **карточка** (можно просто файл `tasks/T-042.md` или строчка в Linear). Шаблон:

```markdown
## T-042: Voice channel join button

**Phase:** 2 — Voice
**Model suggestion:** Sonnet 4.6, default reasoning
**Files in scope:**
- packages/polly/src/features/voice/JoinButton.tsx (new)
- packages/polly/src/lib/livekit.ts (extend)
- packages/speedy/src/routes/voice.ts (existing)

**Context (read first):**
- §5.2 (LiveKit flow) in ARCHITECTURE.md
- final-voice.jsx for the visual reference
- ginzu/api-types.ts → JoinVoiceResponse

**Acceptance criteria:**
- [ ] Clicking the channel in the sidebar opens a confirmation
- [ ] POST /api/voice/:id/join called, LiveKit token received
- [ ] Connects to wss://...livekit, publishes mic by default
- [ ] WS event voice.join broadcast to other members
- [ ] Disconnect on page unload (beforeunload + cleanup effect)
- [ ] No console errors

**Out of scope:**
- Screen share (T-051)
- Active speaker UI (T-048)

**Test:**
- Manual: два браузера, проверь что обе сессии слышат друг друга.
- Unit: useVoiceConnection hook — mock LiveKit client.
```

Этот шаблон выстраивает Claude Code так, чтобы он не тянул лишнее, и так, чтобы ты сам понимал «я закрыл задачу или ещё нет».

### 10.3 Поэтапный workflow

1. **План спринта (раз в неделю / итерацию)** — открываешь архив тасков фазы, прикидываешь, что войдёт. Делается с Opus и `ultrathink`: загружаешь архитектуру + список открытых задач, просишь предложить 3–5 тасков на спринт с обоснованием порядка.
2. **Внутри спринта (каждая задача)** — Sonnet, задача в формате выше. Если ловишь странный баг — переключаешься на Opus с `think hard`, описываешь симптомы.
3. **PR review** — отдельный шаг. Если коммитишь в одиночку, попроси Opus сделать ревью diff'а с упором на: безопасность, гонки, error handling, отступы от архитектуры. Это тот самый момент, когда «вайб-код» спасается от того, чтобы превратиться в «кашу-код».
4. **Раз в две недели — рефакторинг-окно**. Не пытайся рефакторить и фичить одновременно: качество страдает у обоих. Пятница вечером — день рефакторинга.

### 10.4 Что Claude Code хорошо умеет, а что не очень

✅ Хорошо:
- Писать новые модули по образцу существующих
- Реализовывать UI из дизайна, если дизайн чёткий
- Миграции drizzle, схемы Zod, типы
- Тесты, особенно integration на основе ручных сценариев
- Объяснять чужой код

⚠️ Осторожно:
- Долгоживущая отладка WebRTC (NAT, ICE, TURN) — там много специфики и легко поскользнуться. Лучше давать Opus и подкреплять реальными логами LiveKit.
- Дизайн БД-схем «с нуля» без чёткого спека — может налепить лишних таблиц. Лучше показать ему §4 и сказать «придерживайся».
- Безопасность: всё, что касается auth, паролей, токенов, выдачи прав — двойная проверка человеком.
- Производительность: на 15 человеках почти ничего не падает, но «case sensitive ORDER BY на огромной таблице сообщений» когда-нибудь укусит. Профилируй явно, не полагайся на интуицию модели.

### 10.5 «Контекст-гигиена»

В Claude Code держи в `.claude/context/` (или аналог) три файла, которые подгружаются по умолчанию:

- `ARCHITECTURE.md` (этот документ)
- `CONVENTIONS.md` — соглашения по коду (импорты, naming, paths)
- `CURRENT_PHASE.md` — что сейчас делаем, чего не делаем

И на каждый таск дополнительно подкладывай **только релевантные** файлы. Не «весь репо», иначе размылится фокус.

---

## 11. Roadmap — задачи по фазам

Это не строгий план, а живой бэклог. Каждая строка — кандидат на ту самую «карточку» из §10.2.

### Фаза 0 — Фундамент (1–2 дня вайб-кодинга)

- [ ] **T-001** Создать монорепо `pizza-parlor` с npm workspaces, базовые `package.json`, `tsconfig.json`, `eslint`, `prettier`.
- [ ] **T-002** Поднять `docker-compose.dev.yml` с postgres, redis, minio, livekit.
- [ ] **T-003** Каркас `@kakdela/speedy`: Fastify + `/healthz`, переменные окружения через env-схему.
- [ ] **T-004** Каркас `@kakdela/polly`: Tauri 2 окно + Vite + React + Tailwind с токенами KD, переключение тем.
- [ ] **T-005** Каркас `@kakdela/ginzu`: типы User/Channel/Message.
- [ ] **T-006** `francine migrate` поднимает базовую схему БД.
- [ ] **T-007** Caddy конфиг для локалки (просто proxy + self-signed TLS).

### Фаза 1 — Текстовый дом

- [ ] **T-010** Auth: register/login/refresh/me, argon2, JWT, cookies httpOnly.
- [ ] **T-011** Инвайт-коды: схема, эндпоинт создания, эндпоинт принятия.
- [ ] **T-012** Экран `Auth` (из `final-auth.jsx`).
- [ ] **T-013** Экран `Onboarding` (из `final-onboarding.jsx`) — ввод инвайт-кода.
- [ ] **T-014** Дефолтный сервер: создаётся в `francine seed` при первой инсталляции.
- [ ] **T-015** REST: список серверов, детали сервера, список каналов.
- [ ] **T-016** REST: история сообщений с курсором, отправка сообщения.
- [ ] **T-017** WS gateway: hello/ready, broadcast msg.new.
- [ ] **T-018** Шелл: рельса серверов + список каналов + member list (из `final-chrome.jsx`).
- [ ] **T-019** Экран `Chat` (из `final-chat.jsx`), composer работает реально.
- [ ] **T-020** Presence в Redis: online/offline по WS connect/disconnect.
- [ ] **T-021** Markdown-парсер в сообщениях (использовать `markdown-it` + DOMPurify).
- [ ] **T-022** Переключение светлой/тёмной темы, сохранение в localStorage.

### Фаза 2 — Голос

- [ ] **T-030** `speedy/src/media/guido.ts`: выдача LiveKit-токенов.
- [ ] **T-031** Endpoint `POST /api/voice/:channelId/join`.
- [ ] **T-032** LiveKit webhook `participant_joined/left` → broadcast WS voice.join/leave.
- [ ] **T-033** Клиент: `useVoiceRoom(channelId)` — подключение, mute, deafen.
- [ ] **T-033a** Tauri: запросить разрешение на микрофон при первом джойне (на Windows система спросит сама, но WebView2 может ругаться — проверь capabilities).
- [ ] **T-034** UI голосового канала (из `final-voice.jsx`), пока без screen share.
- [ ] **T-035** Push-to-talk и voice-activated в настройках клиента.
- [ ] **T-036** Active speaker highlight (LiveKit `ActiveSpeakersChangedEvent`).
- [ ] **T-037** Корректный teardown при page unload, при смене канала.

### Фаза 3 — Демонстрация экрана ⭐ MVP

- [ ] **T-050** `setScreenShareEnabled(true)` + UI-кнопка «демо». В WebView2 вызовется системный picker — это норма.
- [ ] **T-050a** Проверить, что захват системного звука (`audio: true` в `getDisplayMedia`) работает на Windows 10 и Windows 11. Если нет — fallback: только видео, аудио отдельным микрофонным треком.
- [ ] **T-051** Grid layout с screen share tile'ами (как в `final-voice.jsx`).
- [ ] **T-052** Bitrate-настройки качества (auto / 1080p30 / 720p30).
- [ ] **T-053** Скриншот текущего кадра демки → загрузка в MinIO → сообщение в ephemeral чат комнаты.
- [ ] **T-054** Тест: 5 одновременных демонстраций в одной комнате не валят SFU.

### Фаза 4 — Социалка (без приоритета, бери что приятно делать)

- [ ] **T-060** Reactions: POST/DELETE, WS broadcast, UI пилюли (из `final-chat.jsx` они уже есть).
- [ ] **T-061** Replies: `reply_to_id`, рендер цитаты (из `KD_Message`).
- [ ] **T-062** Edit/delete своих сообщений, `(изм.)` маркер.
- [ ] **T-063** Attachments: presigned POST в MinIO, превью картинок, плеер видео.
- [ ] **T-064** DM: пары пользователей как «канал» kind='dm', UI из `final-dm.jsx`.
- [ ] **T-065** Inbox с упоминаниями (из `final-inbox.jsx`).
- [ ] **T-066** Поиск по сообщениям через Postgres `tsvector` + GIN.
- [ ] **T-067** Web Push (Service Worker, VAPID keys).
- [ ] **T-068** Профиль участника как модалка (из `final-profile.jsx`).

### Фаза 5 — Полировка

- [ ] **T-080** Threads, отдельная вьюшка.
- [ ] **T-081** Custom emoji upload, отдельный bucket в MinIO.
- [ ] **T-082** Аудит-лог (отдельная таблица + UI).
- [ ] **T-083** Несколько серверов: UI создания, переключения.
- [ ] **T-084** Бэкап-скрипт + cron + восстановление одной командой.
- [ ] **T-085** Шумоподавление (RNNoise WASM module).
- [ ] **T-086** Системный трей (Tauri tray-icon), сворачивание в трей при close, badge при unread.

---

## 12. Безопасность для self-host (трезвый минимум)

* Argon2id с разумными параметрами (`m=64MB, t=3, p=4`) для паролей.
* JWT access 15 мин, refresh 30 дней с ротацией. Refresh — в `httpOnly` cookie с `SameSite=Strict`.
* CSRF: используем `SameSite=Strict` + проверка Origin/Referer на write-эндпоинтах.
* Rate limit на login (10 попыток / 15 мин на IP+username).
* Контент-валидация: Zod-схемы на каждом эндпоинте, лимит длины сообщения (4000 символов как в дискорде — норм).
* Файлы: проверка MIME-типа + magic bytes (`file-type` пакет), лимит размера (50 MB), хранение в MinIO с приватным доступом и signed URL'ами на 1 час.
* SQL injection — drizzle защищает.
* XSS — DOMPurify для рендера markdown, никаких `dangerouslySetInnerHTML` без него.
* CORS: только домен прода + localhost для dev.
* LiveKit-токены: короткий TTL (1 час), привязаны к user-id, проверяются на сервере.
* HTTPS обязательно. Caddy с автоматическим Let's Encrypt — берёт всё на себя.
* Резервные копии — раз в день, с шифрованием (`gpg --symmetric`) в S3-совместимый bucket провайдера.

Чего НЕ делаем (для группы 15–20 друзей): WAF, DDoS-защита уровня cloudflare, антиспам ML, fingerprinting. Если кто-то из своих захочет навредить — это уже не технический вопрос.

---

## 13. Что считаем «всё, MVP закрыт»

Чёткий критерий, чтобы не размывать цель. **MVP закрыт, когда:**

1. Админ может развернуть проект на чистом VPS одной командой `docker-compose up -d` (плюс правка `.env`).
2. Админ генерирует инвайт-ссылки, друзья регистрируются.
3. В дефолтном сервере есть как минимум один текстовый и один голосовой канал.
4. Любой участник может:
   - написать сообщение в текстовый канал, увидеть его у себя и у соседа в реальном времени;
   - зайти в голосовой канал, услышать другого;
   - запустить демонстрацию экрана, другой её видит со звуком (если включил `screen_share_audio`);
   - выйти из канала без подвисов и зомби-сессий.
5. Светлая и тёмная темы работают.
6. На 5 одновременных пользователях с двумя демонстрациями экрана — не падает.

Всё. Reactions, DM, inbox, threads, custom emoji, push, поиск — *после* MVP. Сопротивляйся искушению «давай ещё реакции добавим, это ж 30 минут» — таких «30 минут» наберётся 15 штук, и MVP не случится никогда.

---

## 14. Приложение: «вайб-код» — пара мыслей напоследок

1. **Описывай задачу в письменном виде, даже если потом будешь общаться голосом**. Письменная формулировка обнажает дыры в твоём собственном понимании.
2. **Один коммит — одна логическая штука**. Это банально, но Claude Code, видя в diff-е три не связанные вещи, начинает их объединять в коде. Лучше дробить.
3. **Если Claude Code спорит** — это сигнал. Не давить, а разобраться, кто из вас не прав.
4. **Не верь «работает на моей машине»**. Поднимай test-стенд (тот же docker-compose, но с `-f docker-compose.test.yml`) и прогоняй ручной чек-лист после каждой фазы.
5. **Делай скриншоты прогресса**. Самохост-проект подвержен тому, что ты увидишь его сам и про него забудешь. Скриншоты — как фотоальбом ребёнка: через год будешь рад, что они есть.
6. **Тёплая тема — твой моральный якорь**. Если что-то начинает выглядеть «как обычный дискорд», ты сбился с курса. Возвращайся к `final-chrome.jsx` и смотри на эту бежевую палитру с моноширинными подписями. У тебя не клон, у тебя «как дела?».

— Удачи. Speedy уже за стойкой.
