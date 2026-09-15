# Бэкапы КакДела

Инструкция для текущих `backup.sh` и `restore.sh`, сверена 2026-09-15. Снимок включает PostgreSQL и два MinIO-bucket. Успешный запуск подтверждает создание файлов; восстановимость проверяется отдельной репетицией restore.

## Формат 2

```text
/backups/snapshot-<TS>-<suffix>/
  pg-<TS>.sql.gz
  minio-<TS>/
    kakdela/
    kakdela-emoji/
  manifest.txt
  SHA256SUMS
  COMPLETE
```

`TS` — UTC `YYYYMMDD-HHMMSSZ`; suffix отличает временный каталог конкретного запуска. Имена bucket зависят от `S3_BUCKET`/`S3_EMOJI_BUCKET`.

Сначала создаётся `.incomplete-*`: pg_dump → gzip-проверка → обязательный mirror обоих bucket → manifest и SHA256SUMS. После проверки сумм записывается `COMPLETE`, затем каталог переименовывается в `snapshot-*` на той же файловой системе. Ошибка дампа или MinIO не публикует полный снимок. `.backup-lock` не допускает одновременных запусков; подозрение на зависшую блокировку требует проверки процесса, а не автоматического удаления.

PostgreSQL и MinIO снимаются последовательно, общей транзакции между ними нет. Для согласованного восстановления при активных загрузках нужен отдельный эксплуатационный сценарий.

## Запуск

Cron контейнера вызывает `kd-backup` ежедневно в **04:00 UTC**. Compose передаёт `BACKUP_RETENTION_DAYS` как `RETENTION_DAYS` скрипта (по умолчанию 14).

```sh
docker compose -f docker-compose.prod.yml up -d backup
docker compose -f docker-compose.prod.yml logs -f backup
```

Ручной запуск:

```sh
docker compose -f docker-compose.prod.yml exec backup kd-backup
# Или через CLI из корня репозитория:
pnpm big-cheese backup
```

## Просмотр и восстановление

Новые снимки видны как каталоги:

```sh
docker compose -f docker-compose.prod.yml exec backup ls -1 /backups
```

`kd-restore --help` пока перечисляет только legacy-файлы `pg-*.sql.gz` в корне; отсутствие их в help не означает отсутствие новых снимков.

Для формата 2 передать относительный путь к дампу внутри снимка (имя взять из вывода `ls`):

```sh
docker compose -f docker-compose.prod.yml exec backup \
  kd-restore snapshot-20260915-040000Z-ABC123/pg-20260915-040000Z.sql.gz

# Только PostgreSQL:
docker compose -f docker-compose.prod.yml exec backup \
  kd-restore snapshot-20260915-040000Z-ABC123/pg-20260915-040000Z.sql.gz --skip-minio
```

Restore проверяет COMPLETE и SHA256SUMS, затем gzip; спрашивает `YES` перед записью. Даже `--skip-minio` не отключает проверку контрольных сумм всего снимка.

**Восстановление перезаписывает базу и файлы:** дамп содержит `--clean --if-exists`, а MinIO восстанавливается через `mc mirror --remove`. Сначала сохранить текущее состояние, остановить запись приложения и проверить выбранный снимок на отдельном стенде. После ошибки возможен частичный restore; это не транзакция между БД и bucket.

Legacy-путь `pg-<TS>.sql.gz` по-прежнему принимается с предупреждением: у него нет manifest/гарантии полноты. Отдельно проверить наличие соответствующего `minio-<TS>`.

## Ротация и off-site

Ротация удаляет только старые каталоги `snapshot-*`, где есть COMPLETE и SHA256SUMS. Текущий только что созданный снимок сохраняется. Legacy `pg-*`/`minio-*` автоматически не удаляются.

В `.env` можно задать:

```dotenv
OFFSITE_RSYNC_TARGET=user@nas.local:/data/kakdela/
```

Скрипт отправляет **новый снимок**, затем отдельно его COMPLETE. Он не использует `--delete-after` и не удаляет известные хорошие удалённые снимки. При ошибке off-site локальный снимок остаётся, команда завершается ошибкой и локальная ротация не выполняется. Удалённая ротация настраивается отдельно.

SSH-ключ можно подключить предусмотренным volume в `docker-compose.prod.yml`; также настроить доверенный host key. Приватные ключи исключены из Git. AWS S3/Restic/Borg не являются встроенными off-site режимами этого скрипта.

## Проверки и ограничения

```sh
bash ops/backup/backup.test.sh
```

Этот тест использует подставные pg_dump/mc/rsync и временные файлы: проверяет обработку отказов, публикацию, контрольные суммы и сохранение прежнего снимка. Он не доказывает успешный restore реальных PostgreSQL/MinIO.

Отдельная приёмка: восстановить копию в изолированный стек, проверить строки БД, файлы и пользовательские сценарии. WAL/PITR, шифрование всего backup и резервирование device-bound истории секретных чатов текущим скриптом не реализованы.
