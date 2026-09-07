# Проверенный checkpoint аудита

Дата: 2026-09-07. Репозиторий: `F:\src\pizza-parlor`.

**Это сохранённая и повторно проверенная база для дальнейших исправлений, не разрешение на production deployment и не полное закрытие аудита.** Выполнен пункт 1 плана: ревью текущих изменений и новых файлов, повторные проверки, отдельная ветка и тематические коммиты.

## Ветка и сохранность

- Ветка: `audit/verified-baseline-2026-09-07`.
- Исходный HEAD / неизменённая ветка `main`: `76da7962fa079b11c1b3686fa748b9eacb6c64b0`.
- До новых правок создана локальная резервная копия 55 изменённых/новых файлов: `.git/audit-checkpoint-20260907/worktree-before.zip`; исходный HEAD и SHA256 каждого файла — в `manifest.json` рядом. Это страховка рабочей копии, не бэкап данных приложения.
- Исходный `audit-report.md` не изменён. SHA256: `542edae0045af539ad8d6242264e6afff3bd022fc13f45091fbff8b0715e5781`.
- Сырые JSON/log в `audit-evidence/` сохранены на диске без изменений и исключены из Git: содержат локальные пути, дубли исходников и большие исторические результаты. Новые логи лежат в `.git/audit-checkpoint-20260907/` и также не публикуются.
- Не выполнялись push, deploy, миграции рабочей БД, изменение `.env`, политик S3 или настроек MCP, запуск приложения с рабочими данными. Глобальный Node не менялся.

## Что дополнительно найдено и исправлено при ревью

В транзакции POST сообщения оставались обращения к глобальному `db`: загрузка вложений при повторе nonce и проверка slow mode, включая чтение прав участника. Если пул занят другими транзакциями, текущая транзакция держит последнее соединение и ожидает ещё одно, которое не освободится.

- В `loadAttachmentsForMessages`, `enforceSlowMode`, `getMemberPermissions` и `assertMember` теперь передаётся текущий `DbExecutor`; транзакционный путь использует `tx` до конца цепочки чтений.
- Добавлены два HTTP/PostgreSQL-теста: повтор nonce и отправка в серверный канал со slow mode обычным участником. Тесты резервируют все соединения пула, кроме одного; после выполнения или ошибки резервы освобождаются.
- Сначала оба теста воспроизвели зависание с ошибкой `transaction requested another pool connection`, остальные 6 проходили. После исправления проходят все 8. Исправлена и тестовая заглушка presence для серверного пути (`getStatusBulk` → Map).
- Новое исправление не делает атомарными Redis slow mode, post-commit broadcast и запись БД; durable outbox и расширенные гонки остаются отдельными задачами.

## Повторные проверки

Локальная Windows-среда: Node **24.20.0**, pnpm **9.12.0** через изолированный npm cache; Cargo **1.95.0**, установленный protoc и Docker Desktop. Использованы существующие caches, это не clean-room сборка.

| Проверка | Результат |
|---|---|
| `pnpm install --frozen-lockfile` | Успешно; lockfile согласован, разрешение зависимостей не изменялось |
| `pnpm typecheck` | Успешно, 5 workspace-пакетов |
| `pnpm lint` | 0 ошибок, 13 предупреждений |
| `pnpm --filter @kakdela/speedy test` | 68 passed; 8 PostgreSQL-тестов намеренно skipped без отдельного runner |
| `node ops/test-postgres.mjs` | 8/8 passed на одноразовом PostgreSQL 17; контейнер удалён |
| `pnpm build` | Успешно; сохраняется предупреждение Vite о chunk >500 kB |
| `cargo test --manifest-path packages/polly/src-tauri/Cargo.toml --locked --lib --no-default-features` | 8/8 passed; 6 предупреждений dead_code |
| `cargo check --manifest-path packages/polly/src-tauri/Cargo.toml --locked --lib` | Успешно на Windows; 2 предупреждения dead_code |
| `bash ops/backup/backup.test.sh` через Git Bash | Успешно; только временные файлы и подставные pg_dump/mc/rsync |
| `pnpm audit --json` | 0 известных advisory во всех категориях на дату проверки; это не доказательство отсутствия уязвимостей |
| Docker build текущего speedy + sharp smoke | Успешно; контейнер без сети создал и прочитал WebP 2×2, Node 24.20.0 |
| `git diff --check` | Код проходит; при добавлении исходного отчёта Git отмечает его 2 Markdown hard-break строки как trailing whitespace (строки 3–4). Они намеренно сохранены для неизменности исходного аудита |

При повторении на этом ПК можно не переключать глобальный Node, например:

```cmd
npm exec --yes --package=node@24.20.0 --package=pnpm@9.12.0 -- cmd /d /c "pnpm typecheck"
npm exec --yes --package=node@24.20.0 --package=pnpm@9.12.0 -- cmd /d /c "node ops/test-postgres.mjs"
```

Не подставлять рабочий DATABASE_URL в интеграционные тесты: использовать только одноразовый runner. Rust unit-тесты не обращаются к реальному пользовательскому keychain. Образ `pizza-audit-checkpoint:20260907` оставлен локально; временные PostgreSQL и smoke-контейнеры удалены.

Не проверены: исполнение workflow на GitHub, установщик Tauri, macOS/Linux/mobile-сборки и runtime OS-keychain, cargo audit, полноценный restore-rehearsal, полный E2E чатов/звонков и нагрузочные сценарии вне добавленных regression tests.

## Тематические коммиты

| Commit | Содержание |
|---|---|
| `a126610` | Node 24, зависимости, lockfile, sharp patch, Dockerfile |
| `26b9c05` | Атомарность auth/messages, безопасная привязка файлов, исправление зависания пула, PostgreSQL runner и 8 тестов |
| `43d17cb` | SSRF, явные доверенные proxy, ограничения WS, очистка подписок и auto-delete |
| `125e187` | Fail-closed native storage, проверка владельца, close, точные processed IDs и Rust-тесты |
| `52c79fe` | Refresh, generation guards, сериализация session persistence и тесты |
| `4e70ffe` | Согласование identity, транзакционная выдача prekey и пагинация secret inbox |
| `27a2e7f` | Полные backup snapshots, строгий restore и fault-injection тесты |
| `117f2ba` | Workflow audit-regressions и type-aware lint |

Отдельный завершающий docs-коммит сохраняет исходный аудит, уточнённый `audit-fixes.md`, эту сводку и исключение сырых локальных отчётов. Проверен итоговый набор изменений; отдельный полный прогон на каждом промежуточном коммите не выполнялся.

## Границы следующего этапа

Подробный статус всех 17 пунктов — в [audit-fixes.md](audit-fixes.md). Приоритетные незакрытые области остаются:

1. №3: отзыв доступа при WS hello/in-flight гонках, потерянных broker-событиях и в LiveKit.
2. №4/17: namespace server/account/device, безопасная миграция, session context каждого IPC и Android Keystore.
3. №5: атомарность ratchet + plaintext/history до ACK, durable inbox/outbox и crash-injection; текущее окно потери не закрыто.
4. №14: приватные вложения, short-lived downloads, staging/final и bucket policy — сейчас не исправлено.
5. №6/9: reinstall/key-restore, расширенные auth/init/persistence гонки и потерянные ответы refresh.

Перед любым rollout нужны согласованное обновление ginzu/speedy/Polly (topup требует identityKey), фактический TRUST_PROXY для Caddy и отдельная проверка нового формата backup/restore. На этапе checkpoint эти production-настройки не применялись.
