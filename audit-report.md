# Аудит pizza-parlor / «КакДела»

Репозиторий: https://github.com/ITSeniy/kakdela  
Коммит: `78b70b08d2d55c27b76200554ae10920ed47b906`  
Дата проверки: 2026-09-07. Среда: Linux, Node 24.14.1, pnpm 9.12.0.

## Вывод

Проект успешно проходит существующие проверки типов, unit-тесты и JS/TS-сборку, но имеет подтверждённые дефекты авторизации и сетевой безопасности. Главный приоритет — закрыть SSRF, межканальный replyTo и отзыв live-доступа, затем обеспечить изоляцию и crash-safety секретных чатов. Переписывать весь проект или дробить его на микросервисы не требуется: основной выигрыш дадут единые проверки доступа, транзакционные операции и проверки отказов.

P1 — высокий приоритет: исправить до использования соответствующей функции с недоверенными участниками/чувствительной перепиской. P2 — ближайший цикл стабилизации. Приоритеты — инженерная оценка в контексте self-hosted чата, не CVSS-сертификация.

## Объём и ограничения

Изучены README, структура монорепозитория, ключевые пути Fastify/REST/WebSocket, сообщения/файлы, auth/roles, клиентский API, secret-chat pipeline и Rust-хранилище, Docker/Caddy и backup. Это выборочный риск-ориентированный аудит, не построчная проверка всех функций и не полноценный penetration test.

Все динамические проверки выполнены локально. Доступа к F:\src\pizza-parlor, рабочей БД и развёрнутому серверу не было. PostgreSQL/Redis/MinIO/LiveKit в сборе не поднимались: Docker и Rust toolchain недоступны. Нативные Windows/Android сборки, миграции на живой БД, фактические медиа-звонки и браузерный UI не проверялись. Неизвестно, содержит ли локальная папка дополнительные незакоммиченные изменения.

## Выполненные проверки

| Проверка | Результат |
|---|---|
| pnpm install --frozen-lockfile --ignore-scripts | Успешно; lifecycle-скрипты установки отключены |
| pnpm typecheck | Успешно во всех пяти пакетах |
| pnpm --filter @kakdela/speedy test | 46/46 штатных тестов, 4 файла |
| pnpm build | Успешно: TypeScript backend и Vite frontend; это не native/container build |
| pnpm lint | Exit 0, но ни одного пакетного lint-script нет |
| pnpm audit --json | Есть предупреждения; не приравниваются к доказанным exploit |
| Специальные диагностические тесты | 8/8 воспроизвели проверяемые проблемные сценарии |
| Backup fault-injection | Нулевой exit при двух сбоях MinIO mirror |

Диагностические тесты специально ожидают дефектное поведение: их зелёный результат подтверждает находку, а не безопасность. Тесты обработчиков используют mock БД; реальный SSRF-запрос направлялся только на временный localhost-сервер. Временные файлы тестов удалены из клона; `git status --short` после аудита пустой. Изменений в удалённом репозитории нет.

## Что уже сделано удачно

- Монорепозиторий с shared Zod/TypeScript-контрактами, разделение backend/client/CLI.
- Argon2 для паролей, issuer/audience JWT, hash refresh-токенов и атомарное потребление старой session.
- Централизованные primitives прав, иерархия ролей, уникальные индексы для nonce/голосов и др.
- Серверная проверка magic bytes, отключённый raw HTML и DOMPurify в клиентском Markdown.
- Использование libsignal вместо собственного алгоритма E2EE. Выявленные проблемы относятся в первую очередь к интеграции и сохранению состояния.

Это стоит сохранить, а не переписывать с нуля.

---

## 1. P1 — SSRF: IP-literal обходит защиту превью

**Подтверждение:** воспроизведено реальным локальным HTTP-запросом.

Защита находится в `safeLookup`, но `http.request`/`https.request` не вызывают DNS lookup для адреса, уже заданного IP. В `fetchHop` проверяется протокол, но сам IP до соединения не проверяется. Поэтому `isBlockedIp('127.0.0.1') === true` не мешает `fetchLinkPreview` прочитать HTML локального сервиса. Локальный тест получил контрольный title `LOCAL-AUDIT-MARKER`. Кроме того, `::ffff:7f00:1` классифицируется как разрешённый — обработчик mapped IPv6 распознаёт только dotted IPv4.

**Последствия:** автор сообщения может заставить backend выполнить GET к доступным ему внутренним сервисам. Для HTML метаданные могут попасть в превью; это не означает, что произвольный ответ внутреннего API целиком возвращается клиенту. Предусловия: включённые превью и возможность отправить сообщение.

**Исправление:** нормализовать hostname и все формы IP; до каждого соединения/редиректа отклонять непубличные literal IP; для DNS сохранить привязку проверенного адреса к connect. Использовать проверенную библиотеку IP/CIDR, добавить абсолютный deadline, лимит параллелизма и egress-политику. До исправления выключить `LINK_PREVIEWS_ENABLED`.

**Регрессия:** URL с loopback IPv4/IPv6, mapped IPv6, альтернативными числовыми формами и редиректами на них не должен достигать тестового внутреннего сервера. Отдельно проверить публичный домен и DNS rebinding.

**Код:** [packages/speedy/src/lib/link-preview.ts:66-100](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/lib/link-preview.ts#L66-L100); [packages/speedy/src/lib/link-preview.ts:112-202](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/lib/link-preview.ts#L112-L202).

---

## 2. P1 — Чужое сообщение раскрывается через replyToId

**Подтверждение:** реальный HTTP-обработчик, БД и внешние сервисы замоканы.

POST сообщения авторизует только целевой `channelId`. Переданный `replyToId` сохраняется без проверки исходного канала. `resolveReplies` выбирает текст и имя автора по ID, не ограничивая канал или права читателя, и включает их в ответ/событие.

**Последствия:** зная UUID сообщения из недоступного канала или обычного DM, пользователь может получить его текст, создав ответ в доступном себе канале. Это относится к обычным сообщениям, не к ciphertext из отдельного secret relay. UUID затрудняет угадывание, но не заменяет авторизацию.

**Исправление:** перед INSERT загрузить родительское сообщение с условием `id = replyToId AND channel_id = channelId AND deleted_at IS NULL`. Если межканальные ответы действительно нужны — отдельно проверить доступ к исходному каналу. На чтении фильтровать некорректные старые ссылки; при необходимости исправить уже существующие данные.

**Регрессия:** два независимых канала/DM; запрос из первого с ID сообщения второго возвращает 403/422 и не раскрывает содержимое.

**Код:** [packages/speedy/src/routes/messages.ts:61-86](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/messages.ts#L61-L86); [packages/speedy/src/routes/messages.ts:638-698](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/messages.ts#L638-L698).

---

## 3. P1 — Кик не отзывает действующие WebSocket-подписки

**Подтверждение:** реальный HTTP-обработчик и registry, БД замокана.

Кик удаляет membership и роли, затем отправляет `member.leave`. Соединения пользователя остаются в registry.byServer/byChannel. Маршрутизатор broadcast доставляет события по registry без повторной проверки membership. Клиентский useKickWatcher только обновляет список и меняет экран. Самостоятельный выход с сервера также не снимает подписки.

**Последствия:** уже подключённый исключённый участник продолжает получать новые сообщения и события до закрытия/переподключения сокета. Для доступа достаточно собственного клиента, игнорирующего навигацию UI.

**Исправление:** серверная операция отзыва доступа: снять подписки сервера и всех его каналов/веток со всех соединений пользователя либо закрыть эти соединения и заново авторизовать. При нескольких процессах — разослать отзыв через broker. Проверить также принудительное отключение от серверных комнат LiveKit, а не полагаться на клиент.

**Регрессия:** два устройства одного участника подключены; после кика ни одно не получает новые события сервера, REST запрещён, voice-доступ отозван.

**Код:** [packages/speedy/src/routes/servers.ts:593-625](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/servers.ts#L593-L625); [packages/speedy/src/routes/servers.ts:649-679](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/servers.ts#L649-L679); [packages/speedy/src/ws/broadcast.ts:18-39](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/ws/broadcast.ts#L18-L39); [packages/speedy/src/ws/registry.ts:18-58](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/ws/registry.ts#L18-L58).

---

## 4. P1 — Секретное хранилище не разделено по аккаунтам

**Подтверждение:** статический анализ Rust/TypeScript; нативный сценарий не запускался.

`crypto_init(self_user_id)` открывает существующий store и не сверяет его владельца с переданным ID. Если ядро уже в памяти, вызов фактически no-op. История хранится в общем `app_data/kd-secret/secret-history.bin`; записи содержат peer_user_id, но не владельца аккаунта. Logout удаляет auth-токены, но не переключает/закрывает CryptoState и HistoryState.

**Последствия:** при входе под другим аккаунтом на той же установке возможно повторное использование identity/сессий предыдущего аккаунта и доступ к его локальной истории. Это отдельная проблема изоляции устройств/аккаунтов, а не взлом libsignal.

**Исправление:** namespace по серверу + accountId + deviceId, обязательная проверка владельца store, явное закрытие и очистка in-memory состояния при logout/смене аккаунта. Историю не удалять молча: отделить аккаунты и предусмотреть явное удаление локальных данных.

**Регрессия:** A → logout → B на одном устройстве: B не видит peers/историю A и использует новую identity; возврат к A открывает только его store.

**Код:** [packages/polly/src-tauri/src/commands.rs:60-78](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src-tauri/src/commands.rs#L60-L78); [packages/polly/src-tauri/src/commands.rs:171-187](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src-tauri/src/commands.rs#L171-L187); [packages/polly/src-tauri/src/store/local_db.rs:45-89](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src-tauri/src/store/local_db.rs#L45-L89); [packages/polly/src/features/auth/api.ts:23-28](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src/features/auth/api.ts#L23-L28).

---

## 5. P1/P2 — Приём секретных сообщений не crash-safe; очередь может застревать

**Подтверждение:** пагинация воспроизведена с mock native bridge; crash/ratchet-сценарии — статические риски.

Rust `decrypt()` сохраняет обновлённое ratchet-состояние до возврата plaintext. Затем отдельным вызовом JS пишет историю и отдельным HTTP-запросом подтверждает конверт. В локальной истории нет envelopeId или durable-реестра уже обработанных конвертов.

**Сценарии риска:**
- Сбой после сохранения ratchet, но до записи истории: повторная расшифровка того же конверта может быть отвергнута как duplicate; текста в истории ещё нет.
- История сохранена, ACK не дошёл: на повторе duplicate/decrypt error попадает в catch, конверт остаётся в очереди.
- Сервер отдаёт первые 200 записей, а клиент делает один GET на событие. После полной пачки он не запрашивает следующую; 201-е сообщение ждёт нового внешнего триггера. Если первые 200 не обрабатываются, более поздние не будут выбраны вовсе.

**Исправление:** нативная атомарная операция «decrypt + durable history + processed envelopeId/ACK queue», при повторе обработанного ID повторять ACK без decrypt. Добавить протокол пагинации/cursor, backoff и карантин нерасшифровываемых конвертов без безусловного удаления. Аналогично исходящим нужен durable outbox и идемпотентный clientMessageId.

**Регрессия:** потерянный ACK, падение между этапами, повторная доставка, 201+ накопленных сообщений, повреждённый первый конверт. При этом нельзя подтверждать сообщение до надёжной локальной записи.

**Код:** [packages/polly/src-tauri/src/crypto/mod.rs:409-455](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src-tauri/src/crypto/mod.rs#L409-L455); [packages/polly/src/features/secret/api.ts:174-243](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src/features/secret/api.ts#L174-L243); [packages/speedy/src/routes/secret-chat.ts:79-101](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/secret-chat.ts#L79-L101); [packages/polly/src-tauri/src/store/local_db.rs:45-65](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src-tauri/src/store/local_db.rs#L45-L65).

---

## 6. P2 — Восстановление identity ошибочно определяется остатком prekey

**Подтверждение:** статический анализ.

После `cryptoInit()` клиент смотрит лишь на `/keys/count`: при остатке >=20 публикации вообще нет. После переустановки локальный store новый, но на сервере могут оставаться ключи старой установки; положительное число prekey не означает, что опубликована текущая identity. Публикация нового bundle также не очищает старые one-time prekey: используется onConflictDoNothing.

**Исправление:** серверный device/identity version и сверка fingerprint текущей identity, транзакционная смена bundle и набора prekey, явное уведомление собеседника о смене ключа. Не использовать число ключей как признак успешного bootstrap.

**Регрессия:** переустановка при остатке 100 старых ключей, повторная публикация после сетевого сбоя, смена устройства.

**Код:** [packages/polly/src/features/secret/api.ts:65-96](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src/features/secret/api.ts#L65-L96); [packages/speedy/src/routes/keys.ts:36-56](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/keys.ts#L36-L56).

---

## 7. P2 — Создание сообщения неатомарно; идемпотентность неполная

**Подтверждение:** порядок INSERT → ошибка вложения 422 воспроизведён на HTTP-обработчике с mock БД.

INSERT messages выполняется до attachFilesToMessage и записи mentions без общей транзакции. При отказе вложения запрос возвращает ошибку, но строка сообщения уже создана; WS может не отправиться. Повтор с тем же nonce находит эту частичную запись и возвращает её как успешную.

Проверка nonce — SELECT перед INSERT. Уникальный индекс предотвращает дубли, но при гонке конфликт INSERT не обрабатывается как повтор операции. При связывании файлов также есть окно между проверкой messageId и безусловным UPDATE.

**Исправление:** единый транзакционный message service; валидация ссылок/вложений, INSERT, условное присоединение файлов, mentions — в одной транзакции. Конфликт nonce возвращает полностью сохранённый результат. При повторе сверять канал/отпечаток payload. Рассылку событий выполнять после commit, надёжнее через outbox.

**Регрессия:** ошибка после каждого этапа не оставляет частичных данных; два параллельных запроса с nonce получают одно сообщение; один файл не привязывается конкурентно к двум сообщениям.

**Код:** [packages/speedy/src/routes/messages.ts:645-721](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/messages.ts#L645-L721); [packages/speedy/src/routes/files.ts:402-436](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/files.ts#L402-L436); [packages/speedy/src/db/schema.ts:257-260](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/db/schema.ts#L257-L260).

---

## 8. P2 — Неудачная регистрация расходует приглашение

**Подтверждение:** статический анализ, поведение прямо отражено и в комментарии.

useCount увеличивается до INSERT пользователя. При занятом email/username или другой ошибке расход не откатывается. Одноразовый инвайт можно потратить не создав аккаунт; повторные неуспешные регистрации могут исчерпать многократный.

**Исправление:** вычислить password hash заранее, затем объединить claim invite, INSERT user, membership и session в транзакцию. События публиковать после commit. Аналогично проверить accept-flow приглашений.

**Регрессия:** ответ 409 не меняет useCount; конкурентное использование последнего места создаёт только одного участника.

**Код:** [packages/speedy/src/routes/auth.ts:98-160](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/auth.ts#L98-L160).

---

## 9. P2 — Ответ refresh 503 превращается в logout

**Подтверждение:** воспроизведено реальным клиентским apiFetch с mock fetch.

В performRefresh любое `!res.ok` означает null, хотя комментарии обещают отличать 401 от временной ошибки. apiFetch после null очищает auth store. Кроме того, refresh использует прямой fetch без REQUEST_TIMEOUT_MS, и общий refreshPromise может удерживать все ожидающие запросы.

**Исправление:** только явный отказ аутентификации очищает сессию; 429/5xx/network errors сохраняют её и возвращают повторяемую ошибку. Добавить timeout, backoff, защиту от позднего refresh после logout. На сервере удаление старой session и выдачу новой объединить в транзакцию; отдельно определить безопасную стратегию retry после потери ответа.

**Регрессия:** 401 основного запроса + 503 refresh оставляет пользователя authed/offline; настоящий revoked refresh вызывает logout; зависший refresh завершается по timeout.

**Код:** [packages/polly/src/lib/api.ts:36-82](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src/lib/api.ts#L36-L82); [packages/polly/src/lib/api.ts:123-135](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src/lib/api.ts#L123-L135); [packages/speedy/src/routes/auth.ts:255-275](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/auth.ts#L255-L275).

---

## 10. P2 — Бэкап сообщает об успехе, когда MinIO не скопирован

**Подтверждение:** воспроизведён исходный shell-скрипт с синтетическим pg_dump и mc, завершающимся с кодом 1.

Обе команды mc mirror заканчиваются `|| log ...`, после чего идут ротация, возможный off-site rsync --delete-after и финальный `ok`. При сбое MinIO скрипт завершился с кодом 0 и пустой директорией объектов.

**Последствия:** автоматизация может считать неполный бэкап исправным. При длительном сбое ротация способна удалить старые пригодные копии.

**Исправление:** собирать снимок во временную директорию; ошибка любого обязательного компонента — ненулевой exit, без success marker/ротации пригодных снимков. После проверки PG+S3 записывать manifest/checksums, атомарно помечать complete. Off-site и retention применять только к завершённым снимкам. Регулярно тестировать restore, включая файлы.

**Регрессия:** отказ PG, основного bucket, emoji bucket или off-site не выдаёт ложный успех; последняя рабочая копия сохраняется.

**Код:** [ops/backup/backup.sh:57-89](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/ops/backup/backup.sh#L57-L89).

---

## 11. P2 — Rate limit за Caddy общий для пользователей

**Подтверждение:** воспроизведено Fastify + rate-limit; хранилище лимитера в памяти вместо Redis.

Fastify создаётся без trustProxy. Caddy проксирует все API-запросы, поэтому req.ip для них — IP прокси. Стандартный keyGenerator @fastify/rate-limit использует req.ip. Лимит login/register 10 запросов в минуту становится общим для клиентов за одним прокси.

**Исправление:** доверять только фактическому Caddy/доверенной сети, а не произвольному X-Forwarded-For; не ставить бездумно trustProxy:true на доступном извне backend. После этого настроить отдельные лимиты по реальному IP, аккаунту и типу операции. Добавить лимиты на upload, secret relay, выдачу ключей, WS handshake/typing/presence и число соединений.

**Регрессия:** два разных клиентских IP не расходуют одну корзину; прямой запрос не может подменить IP заголовком.

**Код:** [packages/speedy/src/index.ts:44-62](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/index.ts#L44-L62); [packages/speedy/src/routes/auth.ts:84-87](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/auth.ts#L84-L87); [packages/speedy/src/routes/auth.ts:189-192](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/auth.ts#L189-L192); [ops/caddy/Caddyfile.prod:9-17](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/ops/caddy/Caddyfile.prod#L9-L17).

---

## 12. P2 — Node в контейнере ниже требования зависимости

**Подтверждение:** проверены Dockerfile и engines установленного пакета/lockfile; контейнер не запускался.

Backend Dockerfile использует node:20-alpine, корневой package.json допускает Node >=20. Но зафиксированный file-type 22.0.1 требует Node >=22. Успешная проверка на Node 24 не подтверждает совместимость production-образа на Node 20.

**Исправление:** согласовать engines, Dockerfile, документацию и CI на поддерживаемой версии, например Node 24 LTS; либо осознанно использовать совместимую версию зависимости. Закреплять протестированные версии образов; MinIO/LiveKit сейчас используют latest.

**Регрессия:** build + запуск контейнера из чистого клона, healthcheck и upload/finalize реальных разрешённых форматов. Нельзя считать один pnpm build проверкой контейнера.

**Код:** [packages/speedy/Dockerfile:15-32](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/Dockerfile#L15-L32); [pnpm-lock.yaml:2128-2130](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/pnpm-lock.yaml#L2128-L2130); [package.json:29-32](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/package.json#L29-L32); [docker-compose.prod.yml:53-82](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/docker-compose.prod.yml#L53-L82).

---

## 13. P1/P2 — Требуется обновление и проверка достижимости уязвимых зависимостей

**Подтверждение:** pnpm audit по зафиксированному lockfile, без эксплуатации advisory.

Аудит зависимостей сообщил 18 high, 13 moderate, 7 low; это сводка пакетных предупреждений, **не число подтверждённых эксплуатируемых дыр приложения**. Примеры: ws 8.20.1, sharp 0.33.5, drizzle-orm 0.36.4, vite 6.4.2. Включены транзитивные и dev-зависимости.

В первую очередь проверить exposed runtime: `ws` (приём недоверенных WebSocket-фреймов), `sharp` (обработка пользовательских изображений), серверный HTTP/ORM. Advisory ws указывает исправление >=8.21.0; advisory sharp — >=0.35.0 и рекомендует актуальные prebuilt binaries/libvips. Применимость конкретных декодеров sharp и SQL identifier-инъекции Drizzle нужно проверить отдельно; наличие пакета само по себе не доказывает exploit. Часть DOMPurify advisories относится к IN_PLACE/hooks, которые текущий рендер напрямую не использует.

**Исправление:** обновлять совместимыми группами, регенерировать lockfile и повторять API/медиа/Markdown-тесты; отдельно triage runtime/dev. Не запускать слепой major-upgrade без проверки миграций и контрактов.

Advisories: https://github.com/advisories/GHSA-96hv-2xvq-fx4p ; https://github.com/advisories/GHSA-f88m-g3jw-g9cj ; https://github.com/advisories/GHSA-gpj5-g38j-94v9. Полная краткая сводка приложена в evidence/logs/dependency-summary.json.

**Код:** [packages/speedy/package.json:20-38](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/package.json#L20-L38); [packages/polly/src/features/chat/markdown.ts:199-208](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src/features/chat/markdown.ts#L199-L208).

---

## 14. P2 — Политика файлов не соответствует строгой приватности

**Подтверждение:** статический анализ; MinIO не поднимался.

Основные вложения загружаются сразу в публичный префикс public/ до finalize, а `toAttachment` выдаёт постоянный публичный URL. Конфигурация MinIO включает anonymous download. Проверка membership не применяется к скачиванию, включая вложения обычных DM. Soft-delete сообщения очищает text, но не удаляет S3-объекты.

Это может быть осознанным компромиссом для друзей, но «не видно сообщения в UI» не равно «файл недоступен». Скопированная ссылка остаётся рабочей после выхода/кика/удаления сообщения. Также presigned PUT имеет TTL 300 секунд и не является одноразовым разрешением; итоговый ключ не отделён от upload staging.

**Исправление:** явно выбрать модель приватности. Для закрытых вложений — private bucket + авторизованная выдача короткоживущего GET URL. Upload — в непубличный staging, после проверки — отдельный неизменяемый final key. Ввести quotas, сборку orphan/pending объектов и продуманную retention-политику с учётом пересылок.

**Ограничение:** повторная загрузка и обход MIME-проверки против MinIO не воспроизводились; фактический размер PUT подписан через content-length, поэтому обход лимита размера здесь не заявляется.

**Код:** [packages/speedy/src/routes/files.ts:68-89](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/files.ts#L68-L89); [packages/speedy/src/routes/files.ts:203-265](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/files.ts#L203-L265); [packages/speedy/src/routes/files.ts:295-304](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/files.ts#L295-L304); [docker-compose.prod.yml:69-77](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/docker-compose.prod.yml#L69-L77); [packages/speedy/src/routes/messages.ts:873-876](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/messages.ts#L873-L876).

---

## 15. P2 — Автоудаление теряет часть live-уведомлений

**Подтверждение:** статический анализ.

Sweeper обновляет все подходящие сообщения, а затем делает `deleted.slice(0, 1000)` только для WS-рассылки. Остальные сообщения уже удалены в БД, поэтому следующий проход с `deletedAt IS NULL` их не выберет. Комментарий «остаток добьётся в следующий проход» не соответствует реализации.

**Исправление:** ограничивать batch на уровне SELECT/UPDATE, а не после изменения; либо рассылать одно событие об инвалидации истории канала. Следить за временем sweep и не запускать перекрывающиеся проходы.

**Регрессия:** 1001+ истёкших сообщений: у клиентов не остаются зомби-сообщения, все изменения синхронизированы.

**Код:** [packages/speedy/src/lib/auto-delete.ts:17-45](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/lib/auto-delete.ts#L17-L45).

---

## 16. P2 — Lint формально зелёный, но отсутствует; CI не закрепляет качество

**Подтверждение:** запущен pnpm lint и проверено дерево репозитория.

Корневой lint вызывает pnpm -r lint, но ни в одном пакете нет такого script. Команда завершилась с кодом 0 и сообщением `None of the selected packages has a "lint" script`. Штатный JS/TS test suite содержит 46 тестов в четырёх файлах backend; нативные Rust-тесты есть, но они не покрываются pnpm build/test. GitHub Actions workflow в проверенном дереве не обнаружен.

**Исправление:** реальный ESLint/Biome, включая no-floating-promises и React hooks; форматирование; CI с frozen install, typecheck, lint, tests, production build, контейнерным smoke-test. Добавить негативную матрицу авторизации, интеграционные проверки Postgres/Redis/MinIO, UI-тесты reconnect/logout/uploads и нативные тесты восстановления.

**Важно:** 46 зелёных unit-тестов не свидетельствуют о покрытии безопасности. Текущие SSRF-тесты проверяют helper/парсер, но не факт сетевого соединения.

**Код:** [package.json:17-25](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/package.json#L17-L25); [packages/speedy/vitest.config.ts:1-8](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/vitest.config.ts#L1-L8); [packages/speedy/src/lib/link-preview.test.ts:1-30](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/lib/link-preview.test.ts#L1-L30).

---

## 17. P2 — Слабая дополнительная защита нативного клиента

**Подтверждение:** статический анализ, не подтверждение XSS или взлома AES.

В Tauri `csp: null`. Для шифрования секретного store SoftwareKeyProvider хранит DEK обычным файлом dek.bin рядом с ciphertext. Копия всей директории даёт и ключ, и зашифрованные данные; это не защита от чтения полного app_data/backup. При отсутствии/некорректном размере ключа провайдер создаёт новый вместо явного восстановления/ошибки, что может сделать старые данные нечитаемыми.

**Исправление:** платформенное хранилище ключей — Android Keystore/Windows DPAPI или Credential Manager/macOS Keychain/Linux Secret Service; не заменять потерянный ключ молча. Ввести CSP с разрешёнными API/S3/LiveKit источниками и минимальными script/frame/connect policy. Это defense in depth поверх существующих html:false и DOMPurify, не замена санитизации.

**Код:** [packages/polly/src-tauri/tauri.conf.json:44-46](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src-tauri/tauri.conf.json#L44-L46); [packages/polly/src-tauri/src/sealed.rs:42-70](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src-tauri/src/sealed.rs#L42-L70); [packages/polly/src/features/chat/markdown.ts:17-22](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src/features/chat/markdown.ts#L17-L22).

## Архитектурные улучшения после устранения дефектов

1. **Транзакционный message service.** POST, forward, первая запись в thread, attach, mentions и slow-mode должны использовать общие инварианты. Сейчас forward пишет напрямую и не вызывает enforceSlowMode. Вынести send/edit/delete из больших route-файлов, оставив HTTP-валидацию и сериализацию.
2. **Единый жизненный цикл аккаунта.** Login/logout/refresh должны управлять auth, QueryClient, Zustand, сокетами, voice и нативными stores согласованно. Очистка одного auth store недостаточна для безопасной смены пользователя.
3. **Надёжная доставка событий.** Transactional outbox и идемпотентные consumers для важных изменений; WS использовать как транспорт с reconnect/backfill. Для 15–20 пользователей достаточно одного процесса и простой очереди — микросервисы не обязательны.
4. **Наблюдаемость.** Метрики ошибок и p95 API, активных WS и reconnect, размера secret inbox/outbox, последнего завершённого backup, orphan-файлов. При 500 не возвращать пользователю внутренний error.message; журналировать requestId, а наружу давать безопасную ошибку.
5. **Размер frontend.** В сборке основной JS chunk около 1,59 MB, gzip около 460 KB; EmojiPicker — ещё отдельный крупный chunk. Рассмотреть lazy loading voice/LiveKit, settings и редко используемых экранов. Это основание для профилирования, а не доказательство медленного интерфейса; измерить cold start на целевых телефонах.
6. **Детерминированный деплой.** Закрепить версии образов, запускать smoke-тест production-конфигурации, проверять восстановление из backup и документировать совместимые версии Node/Rust/native SDK.

Дополнительные точки кода: [forward без slow-mode](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/routes/messages.ts#L993-L1037), [обработка ошибок](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/speedy/src/index.ts#L65-L73), [auth store](https://github.com/ITSeniy/kakdela/blob/78b70b08d2d55c27b76200554ae10920ed47b906/packages/polly/src/features/auth/store.ts#L24-L30).

## Рекомендуемый порядок работ

### Этап 1 — закрыть утечки и добавить барьеры
- До исправления отключить link previews.
- Исправить проверку replyToId и серверный отзыв WS/voice-доступа.
- Закрепить негативные интеграционные тесты авторизации.
- Обновить/проверить применимые exposed runtime-зависимости.
- До проверки изоляции и crash-safety не позиционировать секретные чаты как готовые для чувствительной переписки.

### Этап 2 — целостность и восстановление
- Транзакции message/attachments/mentions и invite/user/session.
- Корректные refresh 5xx/timeout/retry.
- Account-scoped native stores, durable inbox/outbox, корректный bootstrap identity.
- Fail-closed backup с проверкой restore.

### Этап 3 — управляемая эксплуатация
- Настоящий lint/CI, тесты PostgreSQL/Redis/MinIO и native-набора.
- Согласованные Node/Docker/lockfile, доверенный proxy и лимиты операций.
- Политика приватности и удаления файлов, метрики и профилирование frontend.

## Приёмочные сценарии, которые стоит сделать обязательными

- Пользователь не может прочитать, процитировать или изменить недоступные ему объекты ни через один альтернативный API-путь.
- Кик/выход запрещают и REST, и дальнейшую доставку WS/voice на всех устройствах.
- Нет «сообщение сохранилось, но API ответил ошибкой» после сбоя вложения/mentions.
- Дублированный nonce не создаёт дублей и не возвращает частичный/чужой результат.
- Сбой refresh 503 не уничтожает валидную сессию.
- Секретный конверт переживает повторную доставку, потерянный ACK и остановку процесса между этапами без потери истории.
- Переключение аккаунта на одном устройстве не открывает чужой store.
- Из 201+ конвертов доставляются все, повреждённые не блокируют остальных.
- Отказ любого обязательного компонента backup даёт ненулевой exit и сохраняет последнюю полную копию.
- Сборка из чистого клона запускается в том же контейнере и на той же версии Node, что production.
