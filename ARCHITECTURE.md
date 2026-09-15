# КакДела — архитектура текущей реализации

Сверено с кодом 2026-09-15. [Исходный архитектурный план](docs/archive/ARCHITECTURE-2026-09-15.md) сохранён в архиве; старые карточки могут ссылаться на его номера разделов.

## 0. Продукт и границы

Self-hosted мессенджер для 15–20 друзей. Windows-first desktop, web-клиент, Android-направление для личных сообщений. Состояние реализации и приёмки — в [CURRENT_PHASE](.claude/CURRENT_PHASE.md); команды — в [DEVELOPMENT](docs/DEVELOPMENT.md).

## 1. Пакеты

| Пакет | Обязанности |
|---|---|
| `speedy` | Fastify 5 / Node 24: REST, WS, авторизация, файлы и admission gateway |
| `polly` | React 19, Vite, Tailwind, TanStack Query, Zustand, wouter; Tauri 2 / Rust |
| `ginzu` | Zod-схемы, API-типы, WS-контракты, права и дизайн-токены |
| `francine` | Миграции Drizzle, seed, создание инвайтов |
| `big-cheese` | Запуск backup через Docker Compose; прочие команды пока заглушки |

`guido` — модуль `speedy/src/media/guido.ts`, а не отдельный сервис приложения. LiveKit работает отдельным SFU-контейнером.

## 2. Реализованные области

Серверы, каналы, DM, сообщения, реакции, треды, роли, поиск, профили, вложения, emoji/стикеры, голос/камера/демо, встречи/опросы, уведомления и backup. В коде также присутствуют мобильный shell и секретные чаты. Наличие кода не означает завершённую приёмку или включение на сервере.

## 3. Архитектура системы

### 3.1 Связи компонентов

```text
Polly desktop / web / Android
  ├─ REST /api + события /ws ────────────> Speedy ──> PostgreSQL
  │                                          ├─────> Redis
  ├─ сигнализация /livekit ──────────────>    └─────> приватный LiveKit :7880
  ├─ WebRTC медиа ─────────────────────────────────> LiveKit
  └─ presigned upload / public download ───────────> MinIO
```

На VPS Caddy обслуживает web-клиент, TLS и проксирует `/api`, `/ws`, `/livekit`, `/healthz`; S3 поддомен ведёт в MinIO. Медиа идут непосредственно в LiveKit.

### 3.2 Backend и фоновые задачи

Точка входа — `packages/speedy/src/index.ts`, Zod-конфигурация — `src/env.ts`. Доменные Fastify-плагины находятся в `src/routes/`. Фоновые процессы обслуживают presence, автоудаление, поздравления, напоминания, retention секретных конвертов, GC файлов и повторный отзыв голосового доступа.

`/healthz` проверяет только PostgreSQL и Redis. Контракт ответа: `status`, `db`, `redis`, `uptime`.

### 3.3 Медиа

LiveKit остаётся транспортом голоса, камеры и screen sharing. Публичный клиент не подключается напрямую к SFU signaling: доступ контролирует speedy. Подробности протокола допуска — в [audit-admission.md](audit-admission.md).

### 3.4 Развёртывание

`docker-compose.prod.yml` — PostgreSQL, Redis, MinIO, LiveKit и backup; `docker-compose.app.yml` — speedy и Caddy. Их связывает сеть `kd-net`.

`ginzu` экспортирует TS-исходники, поэтому production speedy запускается через `tsx`; одного `node dist/index.js` недостаточно. Web собирается в образ Caddy. Desktop Windows распространяется как NSIS `.exe`; Linux targets — deb/appimage. Текущий CI не публикует установщики.

### 3.5 Tauri и платформенные различия

Native-код — `polly/src-tauri/`, интерфейс к нему — `polly/src/lib/host/`. Desktop использует tray, глобальные хоткеи, уведомления и OS keychain. Web может запускать UI без native API; секретные чаты в browser-режиме не поддержаны.

Windows-захват звука живёт в Rust `audio/` и JS `features/voice/nativeAudioTrack.ts`. `useScreenShare.ts` публикует его как LiveKit `ScreenShareAudio`. Пикер выбирает звук окна, системы, процесса или отсутствие звука; при непрозрачном названии видеотрека автоопределение окна может перейти на системный loopback. Ручные проверки двух клиентов остаются в задачах T-094 и описании текущего этапа.

## 4. Данные

Схема — `packages/speedy/src/db/schema.ts`, миграции — `packages/speedy/drizzle/`. Группы таблиц:

- пользователи, сессии, серверы, участники, роли, инвайты;
- каналы/DM, сообщения, реакции, упоминания, курсоры чтения, треды через поля каналов;
- файлы, emoji, стикеры, избранное, опросы и RSVP встреч;
- аудит, публичные identity/prekey и очередь секретных конвертов.

PostgreSQL — источник членства и долговечных данных. Redis хранит оперативное presence/typing, pub/sub и временное состояние. DB-поля — snake_case, API — camelCase.

Сообщение, reply, привязка вложений и mentions в основном POST сохраняются одной транзакцией. Внутри неё передаётся текущий `tx` по всей цепочке чтений. Надёжная очередь доставки событий после COMMIT пока не реализована для всех потоков.

## 5. Реал-тайм протоколы

### 5.1 WebSocket

Канонический контракт — `ginzu/src/ws-events.ts`, discriminator — **`t`**. Клиент начинает с `{ t: 'hello', token }`; далее передаёт ping/pong, typing и presence. Создание/редактирование сообщений и прочие сохраняемые изменения идут по REST.

Серверные события обновляют кэш клиента и состояние UI. Право на доставку проверяется по текущему PostgreSQL-членству в `speedy/src/ws/access.ts`, а не только по подпискам, собранным при hello. Потеря Redis-события не должна сохранять доступ исключённого участника.

### 5.2 LiveKit admission и отзыв

1. `POST /api/voice/:channelId/join` выдаёт gateway-ticket.
2. Клиент открывает публичный `/livekit`; gateway проверяет ticket и текущее членство.
3. На приватном SFU создаётся bootstrap-сессия без publish/subscribe/data-прав.
4. Gateway повторно проверяет право под блокировкой БД, повышает разрешения SFU и раскрывает сигнализацию только после COMMIT.
5. Полный reconnect снова проверяет членство; быстрый resume отключён. SFU token refresh заменяется gateway-ticket.
6. Kick/leave удаляет все голосовые устройства участника. Неуспешная очистка SFU возвращает `503/pending`; `204` подтверждает предусмотренную очистку.

На VPS требуется закрыть прямой signaling/admin :7880 и старые прямые SFU-сессии. По последнему отчёту включение этой границы на рабочем окружении не подтверждено. Полный порядок — [пакет 3-B](audit-admission.md).

## 6. API и файлы

REST-контракты и Zod-схемы — в `ginzu` и доменных routes speedy. Ошибки имеют вид `{ error: { code, message } }`, коды — kebab-case. Не копировать старые псевдоконтракты из архивных планов.

Upload: presign → прямой PUT → finalize (magic bytes, обработка медиа) → привязка файла к сообщению. Скачивания сейчас используют публичные URL. Непредсказуемый ключ не заменяет проверку доступа; приватные вложения остаются открытым пунктом №14 аудита.

## 7. Навигация по исходникам

- `polly/src/app/Router.tsx`, `Shell.tsx`, `MobileShell.tsx` — выбор оболочки.
- `polly/src/features/` — UI и клиентские операции по доменам.
- `polly/src/lib/api.ts`, `ws.ts`, `livekit.ts` — HTTP, события, медиа.
- `speedy/src/routes/`, `auth/`, `ws/`, `media/` — серверные границы.
- `ops/test-*.mjs` — одноразовые интеграционные стенды.

## 8. Дизайн

Референсы и их назначение — в [designs/README.md](designs/README.md). Компоненты пишутся вручную, цвета и шрифты берутся из `polly/src/styles/tokens.css` и Tailwind-токенов. TanStack Query обслуживает серверный кэш; Zustand — UI и текущую auth-сессию.

## 9. Auth и локальные секреты

Пароли — argon2id. Access JWT используется в Bearer-запросах, refresh ротируется. Web обычно получает httpOnly refresh-cookie; native-клиент помечает запрос `X-KD-Client: tauri` и получает refresh в body.

`features/auth/store.ts` хранит текущую сессию в Zustand. **Access token также сохраняется вместе с user в `kd:session`** через `features/auth/api.ts`; утверждение «только в памяти» не описывает текущую реализацию.

`lib/host/secrets.ts` выбирает OS keychain для Tauri, AES-GCM/IndexedDB при доступном WebCrypto и sessionStorage как последний fallback. Legacy IndexedDB при чтении мигрируется в keychain. Это хранилище JWT следует отличать от Rust-хранилища ключей секретных чатов.

## 10. Секретные чаты

Native libsignal (`crypto/`) и зашифрованная локальная история (`store/`) обслуживают device-bound переписку; сервер получает публичные ключи и ciphertext, но видит метаданные доставки. Cloud-DM остаются обычными серверными сообщениями.

`sealed.rs` требует OS keychain для DEK и запрещает software fallback вне тестов. Android возвращает `keychain-unavailable`, пока не реализован Keystore. Ratchet и история сохраняются отдельно: атомарная запись отдельного файла ещё не даёт crash-safe приёма целого сообщения. Изоляция по server/account/device и восстановление также не завершены.

## 11. Статусы и задачи

[CURRENT_PHASE](.claude/CURRENT_PHASE.md) разделяет наличие реализации, оставшийся DoD и эксплуатационные проверки. [Каталог задач](tasks/README.md) сохраняет исходные спецификации; их старые галочки не являются актуальным заключением о готовности.

## 12. Безопасность и эксплуатация

Актуальный указатель — [audit-fixes.md](audit-fixes.md). Главные открытые области: приватность вложений, namespace/Keystore секретного хранилища, надёжная доставка секретных сообщений и включение LiveKit admission на VPS. Логи не должны раскрывать JWT/query strings; TRUST_PROXY задаётся для настоящего reverse proxy.

Бэкапы формата 2 публикуются только после успешного дампа, копирования MinIO и проверки контрольных сумм. Они не заменяют репетицию восстановления и не являются общей транзакцией PostgreSQL+MinIO. См. [backup/restore](ops/backup/README.md).

## 13. Проверки и границы приёмки

Команды и границы проверок — в [DEVELOPMENT](docs/DEVELOPMENT.md); автоматический набор — в [.github/workflows/audit-regressions.yml](.github/workflows/audit-regressions.yml). Зелёные unit/typecheck/web-build не подтверждают native-установщик, Android, реальную сеть/TURN или рабочий deployment.
