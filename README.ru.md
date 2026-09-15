# КакДела · pizza-parlor

Самохостящийся мессенджер для компании из 15–20 друзей: серверные чаты, личные сообщения, голос, видео и демонстрация экрана. Основной клиент — Windows/Tauri 2; также есть web-версия и развиваемый Android-клиент.

Проект Арсения Махонина. Кодовые имена пакетов — Samurai Pizza Cats. [English](README.md).

## Состояние

Реализация вышла за рамки MVP. Последние изменения посвящены отзыву доступа, шлюзу LiveKit и надёжности. Аудит закрыт частично: остаются приватность вложений, изоляция и сохранность секретных чатов. На Android секретным чатам нужен ещё не реализованный Keystore. Включение новой защиты LiveKit на рабочем сервере не подтверждено.

[Текущий этап](.claude/CURRENT_PHASE.md) · [Статус аудита](audit-fixes.md) · [Проверки 15 сентября 2026](docs/PROJECT_STATE.md).

## Запуск

Нужны **Node.js 24** (`.nvmrc`: 24.20.0), **pnpm 9.12.0** и Docker Compose. Для desktop также нужны Rust, `protoc`, Windows C++ Build Tools и WebView2.

```sh
pnpm install --frozen-lockfile
```

Далее выполнить [локальную настройку](docs/DEVELOPMENT.md): создать `.env`, запустить инфраструктуру, применить миграции, создать сервер и первый инвайт. Backend и клиент работают в отдельных терминалах:

```sh
pnpm dev:speedy
pnpm dev:web
```

Web-клиент доступен на `http://localhost:1420`. Для нативного окна использовать `pnpm dev:polly`. Порты, конфигурация Vite и все команды собраны в [инструкции разработки](docs/DEVELOPMENT.md).

## Проверки и сборка

```sh
pnpm typecheck
pnpm lint
pnpm --filter @kakdela/speedy test
pnpm build
```

Обычные тесты пропускают сценарии, которым нужны отдельные интеграционные стенды. Их запуск и проверки Rust описаны в [разработке](docs/DEVELOPMENT.md). `pnpm build` собирает backend TypeScript и web-клиент.

Windows-установщик NSIS:

```sh
pnpm --filter @kakdela/polly tauri:build
```

Результат: `packages/polly/src-tauri/target/release/bundle/nsis/*-setup.exe`. MSI не входит в текущую конфигурацию.

## Структура

| Каталог | Назначение |
|---|---|
| `packages/speedy` | Fastify API, WebSocket и шлюз сигнализации LiveKit |
| `packages/polly` | React-интерфейс и нативная часть Tauri/Rust |
| `packages/ginzu` | Общие схемы, типы, события и права |
| `packages/francine` | Миграции, seed и инвайты |
| `packages/big-cheese` | CLI бэкапа; остальные админские команды — заглушки |
| `ops` | Инфраструктура, backup/restore и тестовые стенды |
| `docs` | Инструкции, датированные заметки и архив |
| `tasks`, `designs` | Спецификации задач и визуальные референсы |

Данные хранятся в PostgreSQL, временное состояние и события — в Redis, файлы — в MinIO. LiveKit передаёт WebRTC-медиа.

## Документация

[Указатель документов](docs/README.md) · [Архитектура](ARCHITECTURE.md) · [VPS](docs/DEPLOY.md) · [Android](docs/MOBILE.md) · [Бэкапы](ops/backup/README.md) · [Карточки задач](tasks/README.md)

Локальные секреты, результаты сборки и сырые материалы аудита исключены из Git. Платформенные исходники Android в `src-tauri/gen/android` отслеживаются намеренно.

## Лицензия

Исходный код проекта — [MIT](LICENSE). У сторонних зависимостей собственные лицензии.
