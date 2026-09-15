# Локальная разработка

Команды выполняются из корня репозитория, если рядом не указано другое. Требования сверены с манифестами и CI 2026-09-15.

## Окружение

- **Node.js 24.x**, версия в `.nvmrc` — **24.20.0**. Node 20 не соответствует `package.json#engines`.
- **pnpm 9.12.0**, закреплён в `package.json#packageManager` и CI. Используйте эту версию, чтобы применялись overrides и патч sharp из корневого манифеста.
- **Docker с Compose v2** — для локальных PostgreSQL, Redis, MinIO и LiveKit, а также интеграционных тестов.
- Для desktop: Rust toolchain, `protoc` на PATH (или `PROTOC`), Windows C++ Build Tools и WebView2. `protoc` нужен libsignal. Rust 1.77 в Cargo.toml — заявленный минимум пакета, совместимость всего lockfile с ним не проверена; CI использует stable.
- Для Android — отдельная [инструкция](MOBILE.md).

Проверить выбранные исполняемые файлы:

```sh
node --version
pnpm --version
docker compose version
```

На Windows при расхождениях проверьте `Get-Command node,pnpm -All`. Вложенные вызовы `pnpm` тоже должны находить выбранную версию. Предупреждение об игнорировании `pnpm.overrides`/`pnpm.patchedDependencies` означает, что сначала нужно разобраться с launcher/PATH.

## Первый запуск

1. Установить зависимости:

   ```sh
   pnpm install --frozen-lockfile
   ```

2. При отсутствии `.env` скопировать `.env.example` в `.env`. В PowerShell: `Copy-Item .env.example .env`; в Bash: `cp .env.example .env`. Не перезаписывать уже настроенный файл. Примеры содержат публичные dev-значения; для JWT сгенерировать две отдельные строки командой:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(64).toString('hex'))"
   ```

3. В первом терминале запустить инфраструктуру и дождаться готовности сервисов:

   ```sh
   pnpm docker:dev
   ```

4. Во втором терминале применить миграции. Для новой пустой dev-базы создать начальный сервер и инвайт:

   ```sh
   pnpm francine migrate
   pnpm francine seed
   pnpm francine invite create --server <UUID-из-вывода-seed> --max-uses 1
   ```

   `seed` создаёт сервер и каналы, но не пользователя и не готовый инвайт. Если серверы уже есть, seed пропускается. Зарегистрироваться можно по созданному инвайту. Назначение владельца начального сервера описано в [развёртывании](DEPLOY.md); CLI `big-cheese promote` пока не реализован.

5. Запустить backend:

   ```sh
   pnpm dev:speedy
   ```

6. В третьем терминале запустить клиент:

   ```sh
   pnpm dev:web
   ```

   Открыть `http://localhost:1420`. Для нативного окна вместо web-команды использовать `pnpm dev:polly`.

`pnpm dev` только выводит подсказку о терминалах, подсистемы он не запускает.

## Конфигурация и адреса

| Компонент | Адрес по умолчанию |
|---|---|
| Polly / Vite | `http://localhost:1420` |
| Speedy / health | `http://localhost:3001/healthz` |
| События WS | `ws://localhost:3001/ws` |
| Публичная сигнализация голоса | `ws://localhost:3001/livekit` |
| LiveKit admin/upstream | `http://127.0.0.1:7880`, только для backend |
| PostgreSQL | `localhost:5433` (в контейнере 5432) |
| Redis | `localhost:6379` |
| MinIO API / console | `http://localhost:9000` / `http://localhost:9001` |

Backend и CLI читают корневой `.env`. Vite запускается в `packages/polly` и читает env-файлы этого пакета; корневые `VITE_*` автоматически не загружаются. Для стандартного локального desktop/web подходят значения по умолчанию. Для другого сервера задать в `packages/polly/.env.local`:

```dotenv
VITE_SPEEDY_URL=http://localhost:3001
```

В текущем клиенте WS URL выводится из `VITE_SPEEDY_URL`, а URL голоса приходит в ответе join API из backend-конфигурации `LIVEKIT_URL`. `VITE_SPEEDY_WS_URL` и `VITE_LIVEKIT_URL` ещё есть в шаблонах/типах/build args, но runtime-код клиента их не читает. Compose Caddy пока требует эти build args, поэтому при настройке VPS заполнить шаблон полностью.

Для production-сборки клиента используется `packages/polly/.env.production`; для web-образа Caddy значения передаются build args из compose. После изменения build-time HTTP URL нужна пересборка. Для Android-эмулятора default HTTP backend — `10.0.2.2:3001`; физическому телефону нужен доступный LAN-адрес или домен, а backend должен выдавать достижимый ему `LIVEKIT_URL`.

`/healthz` проверяет PostgreSQL и Redis. Ответ `ok` не проверяет MinIO, голос или корректность сетевого маршрута LiveKit.

## Проверки

Обычный локальный набор, без запуска приложения на рабочей БД:

```sh
pnpm typecheck
pnpm --filter @kakdela/speedy exec tsc -p tsconfig.admission-tests.json
pnpm lint
pnpm --filter @kakdela/speedy test
pnpm build
```

Корневого `pnpm test`/`npm test` нет. Обычный Vitest пропускает интеграционные сценарии без отдельного runner. `pnpm build` собирает TypeScript/backend и web-клиент; установщик Tauri требует отдельной команды.

Интеграционные runner создают одноразовые сервисы на случайных loopback-портах и убирают их в `finally`. Не подставлять рабочий DATABASE_URL. При запущенном Docker:

```sh
node ops/test-postgres.mjs
docker pull livekit/livekit-server@sha256:b617bb3363f13e880a82164692d842681276bc6eed7da46092f9ddb22017b927
npm --prefix ops/media-smoke ci --ignore-scripts
node ops/test-admission.mjs --media
node ops/test-livekit.mjs
bash ops/backup/backup.test.sh
```

`ops/media-smoke` — отдельный npm-пакет с собственным lockfile. `--media` включает синтетическое аудио без микрофона/динамиков. Без этого флага аудиосценарий пропускается. Bash-проверка backup использует подставные программы и временные файлы.

Проверки Rust из CI на Windows:

```sh
cargo test --manifest-path packages/polly/src-tauri/Cargo.toml --locked --lib --no-default-features
cargo check --manifest-path packages/polly/src-tauri/Cargo.toml --locked --lib
```

Полный набор, включая dependency audit и Docker build: [audit-regressions.yml](../.github/workflows/audit-regressions.yml). Датированные результаты локального прогона: [PROJECT_STATE.md](PROJECT_STATE.md).

## Сборка desktop и остановка

```sh
pnpm --filter @kakdela/polly tauri:build
```

Windows-установщик: `packages/polly/src-tauri/target/release/bundle/nsis/*-setup.exe`. MSI/WiX не входит в текущие targets. Для Linux заданы deb/appimage; их проверка не следует из успешной Windows/web-сборки.

`pnpm docker:down` останавливает dev-инфраструктуру с сохранением томов. `pnpm docker:reset` выполняет `down -v`: удаляет dev-данные и **не запускает сервисы заново**. Процессы speedy/Vite/Tauri останавливаются отдельно в своих терминалах.
