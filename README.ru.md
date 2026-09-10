# КакДела · pizza-parlor

Самохостящийся уютный «дискорд» для группы друзей на 15–20 человек.
Кодовая тема — *Samurai Pizza Cats*. См. [`ARCHITECTURE.md`](./ARCHITECTURE.md).

```
┌────────────┐    REST + WS    ┌─────────────┐
│   polly    │ ──────────────▶ │   speedy    │
│ (Tauri 2)  │                 │  (Fastify)  │
│  Win/Linux │  ┌────────────▶ │             │
└──────┬─────┘  │   webhooks   └─────┬───────┘
       │        │                    │
   WebRTC       │                  ┌─┴────────────────┐
       │        │                  ▼                  ▼
       ▼        │            ┌──────────┐      ┌──────────┐
┌──────────────┴─┐           │ postgres │      │  redis   │
│  livekit-server│           └──────────┘      └──────────┘
│   (Docker)     │                                  +
└────────────────┘                            ┌──────────┐
                                              │  minio   │
                                              └──────────┘
```

---

## Быстрый старт

### Предусловия
- **Node.js 20+** и **pnpm 9+** (`npm i -g pnpm`)
- **Docker Desktop** или Docker + docker-compose
- **Rust** через [rustup](https://rustup.rs/) — нужен для сборки Tauri (`rustc` ≥ 1.77)
- **Windows**: [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (на Win11 уже стоит). Также понадобится **Microsoft C++ Build Tools** (vs_buildtools.exe → "Desktop development with C++").
- **Linux** (для задельной сборки): `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev` — см. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Шаги
```bash
# 1) Установить зависимости
pnpm install

# 2) Скопировать переменные окружения
cp .env.example .env
# отредактировать секреты — минимум JWT_*_SECRET (openssl rand -hex 64)

# 3) Поднять инфру (postgres, redis, minio, livekit)
pnpm docker:dev

# 4) В другом терминале — миграции БД
pnpm francine migrate

# 5) Backend в watch-режиме
pnpm dev:speedy

# 6) Desktop-клиент (откроется окно Tauri)
pnpm dev:polly
```

Открой `http://localhost:9001` — это MinIO console (логин/пароль из `.env`).

### Если хочется быстро потыкать UI без Tauri
```bash
pnpm dev:web   # обычный Vite dev-сервер на http://localhost:1420
```

---

## Структура

```
pizza-parlor/
├── ARCHITECTURE.md           ← главный документ (прочти его)
├── .claude/                  ← контекст для Claude Code
│   ├── CONVENTIONS.md
│   └── CURRENT_PHASE.md
├── tasks/                    ← карточки задач для вайб-кода
│   ├── _template.md
│   ├── T-001.md, T-002.md, ...
├── designs/                  ← .jsx из Claude Design (для референса)
├── ops/                      ← конфиги инфры (caddy, livekit)
└── packages/
    ├── ginzu/                ← shared TS-типы (@kakdela/ginzu)
    ├── speedy/               ← backend (@kakdela/speedy)
    ├── polly/                ← desktop клиент (@kakdela/polly)
    │   └── src-tauri/        ← Rust-часть Tauri (минимальная)
    ├── francine/             ← миграции/сидинг CLI
    └── big-cheese/           ← админский CLI (прод-операции)
```

---

## Карта команд

| Команда                | Что делает                                          |
|------------------------|------------------------------------------------------|
| `pnpm docker:dev`      | postgres + redis + minio + livekit                  |
| `pnpm docker:down`     | остановить, сохранить данные                        |
| `pnpm docker:reset`    | ⚠️ стереть **все** данные и поднять заново         |
| `pnpm dev:speedy`      | backend в watch                                     |
| `pnpm dev:polly`       | desktop-окно Tauri                                  |
| `pnpm dev:web`         | то же, но в браузере (без Tauri)                    |
| `pnpm francine migrate`| применить миграции БД                               |
| `pnpm francine seed`   | заполнить тестовыми данными                         |
| `pnpm typecheck`       | tsc --noEmit во всех пакетах                        |

---

## Работа с Claude Code

1. Загрузи `ARCHITECTURE.md`, `.claude/CONVENTIONS.md`, `.claude/CURRENT_PHASE.md` в постоянный контекст сессии.
2. Возьми любую карточку из `tasks/`. В шапке указана рекомендованная **модель** и **уровень рассуждений**.
3. Скопируй карточку как промпт. По завершении задачи поставь галочку в чек-листе DoD.
4. Если задача оказалась больше — раздроби, создай `T-XXX_part_a.md` и т. д.

См. §10 в `ARCHITECTURE.md`.

---

## Производство

Пошаговая инструкция деплоя на VPS — **[docs/DEPLOY.md](docs/DEPLOY.md)**. Минимум: один VPS 2 vCPU / 2 GB, Caddy спереди, всё в docker-compose (`docker-compose.prod.yml` — данные, `docker-compose.app.yml` — приложение). Конфиги прокси/LiveKit/бэкапов — в `ops/`.

Для Windows-инсталлятора: `pnpm --filter @kakdela/polly tauri build` соберёт `.msi` в `packages/polly/src-tauri/target/release/bundle/msi/`. Code signing — отдельная история, для группы друзей можно жить без подписи, но SmartScreen будет ругаться при первом запуске.
