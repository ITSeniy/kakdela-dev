# Тестовый деплой КакДела на VPS

Пошаговая инструкция: от голого VPS до работающего чата с голосом, демо экрана и бэкапами. Рассчитана на Ubuntu 22.04/24.04, но подойдёт любой Linux с Docker.

## Как это устроено

Два compose-файла, общая docker-сеть `kd-net`:

| Файл | Сервисы | Зачем отдельно |
|---|---|---|
| `docker-compose.prod.yml` | postgres, redis, minio, livekit, backup | Данные. Поднимается один раз, при обновлениях не трогается. |
| `docker-compose.app.yml` | speedy (backend), caddy (TLS + прокси + web-клиент) | Приложение. Пересобирается при каждом обновлении. |

Caddy терминирует TLS (сертификаты Let's Encrypt получает сам) и маршрутизирует:

```
https://<домен>/api/*      → speedy:3001     REST
wss://<домен>/ws           → speedy:3001     WebSocket-события
wss://<домен>/livekit/*    → livekit:7880    голос/демо (signaling)
https://<домен>/*          → статика          web-клиент (Polly без Tauri)
https://s3.<домен>/*       → minio:9000      файлы, аватарки, emoji
```

Медиа-трафик голоса (RTP) идёт мимо Caddy — напрямую в LiveKit по UDP-mux `7882` (+ TCP `7881` как fallback). Для участников за симметричным NAT/строгим файрволом LiveKit поднимает встроенный TURN: `3478/udp` и TURNS (TLS) `5349/tcp` — см. §3a.

## 0. Что нужно заранее

- **VPS**: 2 vCPU / 2 GB RAM / 20 GB диска — достаточно для 15–20 человек. Публичный IPv4.
- **Домен** и доступ к DNS.
- Локально (для сборки desktop-клиента): этот репозиторий, Node 20+, pnpm 9, Rust-тулчейн Tauri.

### DNS

Две A-записи на IP VPS (обе обязательны — на поддомене живёт MinIO):

```
kakdela.example.com       A   <IP VPS>
s3.kakdela.example.com    A   <IP VPS>
```

## 1. Подготовка VPS

```bash
# Docker + compose-plugin
curl -fsSL https://get.docker.com | sh

# Firewall
ufw allow 22/tcp                   # ssh
ufw allow 80/tcp                   # ACME-челлендж + редирект на https
ufw allow 443/tcp                  # https + wss
ufw allow 443/udp                  # HTTP/3 (опционально, но пусть будет)
ufw allow 7881/tcp                 # LiveKit ICE/TCP fallback
ufw allow 7882/udp                 # LiveKit ICE/UDP mux (медиа)
ufw allow 3478/udp                 # TURN/UDP (NAT-реле)
ufw allow 5349/tcp                 # TURNS — TURN-over-TLS (строгий firewall)
ufw enable
```

## 2. Клонирование и конфиг

```bash
git clone <url-репозитория> kakdela && cd kakdela

cp .env.prod.example .env
cp ops/livekit/livekit.prod.example.yaml ops/livekit/livekit.prod.yaml
```

Сгенерируй секреты и впиши в `.env` (все `REPLACE_*`):

```bash
openssl rand -hex 64   # JWT_ACCESS_SECRET
openssl rand -hex 64   # JWT_REFRESH_SECRET (другой!)
openssl rand -hex 32   # POSTGRES_PASSWORD (и в DATABASE_URL тоже!)
openssl rand -hex 32   # S3_SECRET_KEY
openssl rand -hex 32   # LIVEKIT_API_SECRET
```

Дальше в `.env`:
1. Замени `kakdela.example.com` на свой домен **во всех** URL (`KD_DOMAIN`, `LIVEKIT_URL`, `S3_PUBLIC_ENDPOINT`, `PUBLIC_ORIGIN`, три `VITE_*`).
2. Пароль постгреса должен совпадать в `POSTGRES_PASSWORD` и внутри `DATABASE_URL`.

В `ops/livekit/livekit.prod.yaml` впиши тот же `LIVEKIT_API_SECRET` в `keys: kdprod: "..."`. Имя ключа (`kdprod`) должно совпадать с `LIVEKIT_API_KEY` в `.env`.

> Оба файла в `.gitignore` — секреты в репозиторий не попадут.

## 3. Данные: postgres / redis / minio / livekit / backup

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps    # ждём postgres → healthy
```

`minio-init` отработает один раз и создаст bucket'ы (`kakdela`, `kakdela-emoji`) с анонимным download на `public/`-префиксе.

## 3a. TURN/TURNS — проход через NAT

LiveKit поднимает встроенный TURN-сервер (`ops/livekit/livekit.prod.yaml` → `turn:`). Это страховочный реле-путь для друзей за симметричным NAT или строгим файрволом: без него у части людей голос/демо рассыпаются или вообще не подключаются.

- **TURN/UDP (3478)** работает сразу после `prod up` — сертификат ему не нужен.
- **TURNS/TLS (5349)** переиспользует серт, который Caddy выписывает для `KD_DOMAIN`. Серт появляется только после старта app-плоскости. В `livekit.prod.yaml` строки `tls_port`/`cert_file`/`key_file` по умолчанию **закомментированы** — иначе livekit на первом `prod up` (серта ещё нет) уходит в крэш-луп. Порядок включения:

```bash
# 1. data-плоскость поднята (§3) — TURN/UDP уже работает.
# 2. app-плоскость поднята (§4–§5) — Caddy получил сертификат Let's Encrypt.
# 3. раскомментируй tls_port + cert_file + key_file в ops/livekit/livekit.prod.yaml
#    (проверь путь к серту — шаг ниже), затем перечитай серт перезапуском:
docker compose -f docker-compose.prod.yml restart livekit
```

Проверь, что путь к серту в `livekit.prod.yaml` (`cert_file`/`key_file`) совпадает с реальным — имя ACME-директории CA может отличаться:

```bash
docker compose -f docker-compose.app.yml exec caddy ls /data/caddy/certificates/
# → acme-v02.api.letsencrypt.org-directory/   (обычно так для Let's Encrypt prod)
```

И что `domain:` в блоке `turn:` равен `KD_DOMAIN` (под него выписан серт).

**Продление серта.** Caddy продлевает автоматически (~раз в 60 дней), но LiveKit перечитывает серт только при старте. Чтобы TURNS не отвалился после продления — еженедельный рестарт livekit (быстрый; активные звонки переподключатся):

```bash
# crontab -e на VPS:
0 5 * * 1  cd /opt/kakdela && docker compose -f docker-compose.prod.yml restart livekit
```

**Проверка.** Надёжнее всего — реальный звонок с устройства в другой сети (мобильный хотспот = другой NAT). Если голос идёт там, где раньше «молчал», — TURN работает.

## 4. Сборка приложения

```bash
docker compose -f docker-compose.app.yml build
```

Собираются два образа (первый раз — 5–10 минут):
- `kakdela/speedy` — backend (tsx-рантайм + francine для миграций);
- `kakdela/caddy` — Caddy со статикой web-клиента; `VITE_*` из `.env` запекаются в бандл, поэтому **после смены домена образ надо пересобирать**.

## 5. Миграции и первый сервер

```bash
# Применить миграции
docker compose -f docker-compose.app.yml run --rm speedy pnpm francine migrate

# Создать первый сервер с каналами #общее, #флуд и голосовой комнатой.
# Название можно своё:
docker compose -f docker-compose.app.yml run --rm \
  -e KAKDELA_DEFAULT_SERVER_NAME="как у нас" \
  speedy pnpm francine seed
# → напечатает UUID сервера

# Первый инвайт (регистрация в КакДела только по инвайтам)
docker compose -f docker-compose.app.yml run --rm \
  speedy pnpm francine invite create --server <UUID-из-seed>
# → напечатает код, например: k3m9p2xq
```

## 6. Запуск приложения

```bash
docker compose -f docker-compose.app.yml up -d
```

Проверка:

```bash
curl https://<домен>/healthz
# {"status":"ok","db":"ok","redis":"ok","uptime":...}
```

Если сертификат не выдаётся — смотри `docker logs kd-caddy` (обычно это DNS, который ещё не доехал, или закрытый 80-й порт).

## 7. Первый пользователь и права

1. Открой `https://<домен>` в браузере — это web-клиент.
2. Зарегистрируйся с инвайт-кодом из шага 5.
3. Сервер, созданный seed'ом, ничей — назначь себя владельцем (один раз):

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U kakdela -d kakdela -c \
  "UPDATE servers SET owner_id = u.id FROM users u WHERE u.username = 'ТВОЙ_НИК' AND servers.owner_id IS NULL;
   UPDATE server_members SET role = 'owner' WHERE user_id = (SELECT id FROM users WHERE username = 'ТВОЙ_НИК');"
```

Дальше инвайты для друзей создаются в UI (настройки сервера → инвайты), francine больше не нужен.

## 8. Desktop-клиент (.exe) для друзей

Собирается локально на Windows-машине, не на VPS:

```powershell
# packages/polly/.env.production (файл в .gitignore) — свой домен:
@"
VITE_SPEEDY_URL=https://kakdela.example.com
VITE_SPEEDY_WS_URL=wss://kakdela.example.com/ws
VITE_LIVEKIT_URL=wss://kakdela.example.com/livekit
"@ | Out-File -Encoding utf8 packages/polly/.env.production

pnpm install
pnpm --filter @kakdela/polly tauri:build
# → packages/polly/src-tauri/target/release/bundle/nsis/*-setup.exe
```

Раздай установщик `.exe` друзьям вместе с инвайт-кодом. Пока десктоп не собран, все могут пользоваться web-версией на `https://<домен>`.

## 9. Чек-лист после деплоя

- [ ] `https://<домен>/healthz` → `status: ok`
- [ ] Регистрация по инвайту, вход
- [ ] Сообщения долетают во второй браузер без перезагрузки (WS работает)
- [ ] Загрузка картинки в чат + превью (presigned PUT → s3-поддомен)
- [ ] Кастомный emoji загружается и рендерится
- [ ] Голосовой канал: двое слышат друг друга (**проверь с разных сетей**, не два устройства за одним NAT)
- [ ] Демо экрана видно второму участнику
- [ ] Бэкап вручную: `docker compose -f docker-compose.prod.yml exec backup kd-backup`, файлы видны в `docker compose -f docker-compose.prod.yml exec backup ls /backups`

## 10. Обновление

```bash
cd kakdela && git pull

docker compose -f docker-compose.app.yml build
docker compose -f docker-compose.app.yml run --rm speedy pnpm francine migrate   # если были миграции
docker compose -f docker-compose.app.yml up -d

# Перед рискованными миграциями:
docker compose -f docker-compose.prod.yml exec backup kd-backup
```

Данные (`docker-compose.prod.yml`) при обновлениях кода не трогаются. `docker compose down` БЕЗ `-v` данные не удаляет; `-v` — удаляет всё.

### Обновление старой инсталляции: появился блок `turn:`

`git pull` обновляет только **пример** (`ops/livekit/livekit.prod.example.yaml`);
рабочий `livekit.prod.yaml` создавался из него один раз и новых параметров сам
не получит. Если конфиг создавался до появления TURN (§3a), после `git pull`
доведи его руками:

```bash
# 1. Добавь в livekit.prod.yaml блок `turn:` — образец в
#    ops/livekit/livekit.prod.example.yaml (enabled: true, domain = KD_DOMAIN,
#    udp_port: 3478; строки TURNS/TLS пока оставь закомментированными — §3a).

# 2. Открой порты реле:
ufw allow 3478/udp                 # TURN/UDP
ufw allow 5349/tcp                 # TURNS (TURN-over-TLS)

# 3. Пересоздай livekit: в docker-compose.prod.yml добавились проброс
#    3478/5349 и cert-том Caddy — простого restart недостаточно.
docker compose -f docker-compose.prod.yml up -d livekit

# 4. TURNS — вторым шагом, когда Caddy уже выписал серт: раскомментируй
#    tls_port/cert_file/key_file и `docker restart kd-livekit` (§3a).
```

Проверка: в `docker logs kd-livekit` на старте есть строка про TURN, а звонок
с мобильного хотспота (другой NAT) соединяется.

## 11. Если что-то не работает

| Симптом | Куда смотреть |
|---|---|
| Нет сертификата / ERR_SSL | `docker logs kd-caddy`. DNS обеих записей указывает на VPS? Порт 80 открыт? |
| 502 на `/api/*` | `docker logs kd-speedy`. Чаще всего — невалидный `.env` (speedy при старте печатает, какой переменной не хватает). |
| Логин работает, сообщения не обновляются | WS: в DevTools → Network → `wss://<домен>/ws` должен быть `101 Switching Protocols`. |
| Картинки не грузятся | `s3.<домен>` резолвится? `curl -I https://s3.<домен>` отвечает? `S3_PUBLIC_ENDPOINT` в `.env` без опечаток? |
| Голос: подключается, но тишина | Почти всегда UDP. `ufw status` — открыт `7882/udp` (ICE-mux)? В `livekit.prod.yaml` стоит `use_external_ip: true`? После правок: `docker compose -f docker-compose.prod.yml restart livekit`. |
| Голос рвётся/тишина у конкретного человека (а у других ок) | Его NAT не пускает прямой UDP — должен помочь TURN. `ufw status` — открыты `3478/udp` и `5349/tcp`? TURNS поднялся (см. §3a, серт + restart livekit)? В `docker logs kd-livekit` при старте есть строка про TURN. |
| Демо/голос рассыпается у ВСЕХ сразу | Похоже на упор в исходящую полосу VPS. Во время демо открой DevTools на клиенте → `kdVoiceStats()` (dev-сборка): `qualityLimitationReason: 'bandwidth'` на screen-треке = не хватает egress сервера/аплоада. Снизь preset качества демки. |
| Голос не подключается вообще | `docker logs kd-livekit`. `LIVEKIT_API_SECRET` в `.env` и `keys` в `livekit.prod.yaml` совпадают? |
| `internal-error` при входе в голосовой канал | `docker logs kd-speedy`. Задан ли `LIVEKIT_ADMIN_URL=http://livekit:7880` в `.env`? Без него speedy пытается достучаться до admin-API LiveKit через публичный домен — изнутри docker-сети это hairpin, который обычно не проходит. |
| Presence в голосовом канале не обновляется | Webhook: в `docker logs kd-livekit` ошибки доставки на `http://speedy:3001/...`? Оба контейнера в сети `kd-net` (`docker network inspect kd-net`)? |
| Поменял домен — клиент ходит на старый | `VITE_*` запечены в бандл: пересобери `kakdela/caddy` (и `.exe`-установщик). |

## Известные упрощения тестового деплоя

- **TURN включён** (TURN/UDP `3478` + TURNS/TLS `5349`) — реле для симметричного NAT/строгого firewall. TURNS работает только после того, как Caddy выписал серт и livekit перезапущен (см. §3a); до этого момента остаётся TURN/UDP + TCP-fallback `7881`.
- **Speedy работает на tsx** (как в dev), не на скомпилированном dist — ginzu экспортирует TS-исходники. Для 20 человек это не оверхед; «настоящая» сборка потребует билд-пайплайна для ginzu.
- **MinIO доступен публично** через `s3.<домен>` — приватные файлы защищены только непредсказуемостью ключей (uuidv7). Для друзей — ок.
- Серверные операции speedy с MinIO идут по внутренней сети (`S3_ENDPOINT=http://minio:9000`), клиентские ссылки — через `S3_PUBLIC_ENDPOINT`.
