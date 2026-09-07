#!/usr/bin/env bash
#
# Восстановление КакДела из снимка, созданного backup.sh.
# Использование (из backup-контейнера или другого с pg + mc):
#   ./restore.sh pg-20260523-040000Z.sql.gz
#
# Опционально --skip-minio чтобы не восстанавливать файлы.
#
# ВНИМАНИЕ: операция ДЕСТРУКТИВНА. Текущее содержимое базы и bucket'ов
# будет переписано. Сделай свежий бэкап `./backup.sh` ПЕРЕД восстановлением,
# если ещё не сделал.

set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/backups}

PGHOST=${PGHOST:-postgres}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-kakdela}
PGDATABASE=${PGDATABASE:-kakdela}

S3_ENDPOINT=${S3_ENDPOINT:-http://minio:9000}
S3_BUCKET=${S3_BUCKET:-kakdela}
S3_EMOJI_BUCKET=${S3_EMOJI_BUCKET:-kakdela-emoji}

SKIP_MINIO=0
PG_NAME=""

for arg in "$@"; do
  case "$arg" in
    --skip-minio) SKIP_MINIO=1 ;;
    --help|-h)
      cat <<EOF
restore.sh — восстановление из бэкапа

Usage:
  ./restore.sh <pg-snapshot.sql.gz> [--skip-minio]

Доступные снимки (\$BACKUP_DIR=$BACKUP_DIR):
EOF
      ls -1 "$BACKUP_DIR" 2>/dev/null | grep -E '^pg-.*\.sql\.gz$' || echo '  <ничего>'
      exit 0
      ;;
    *) PG_NAME="$arg" ;;
  esac
done

if [ -z "$PG_NAME" ]; then
  echo "ошибка: нужен аргумент с именем снимка. Запусти './restore.sh --help'."
  exit 1
fi

# v2: pass snapshot-.../pg-....sql.gz; refuse incomplete or modified snapshots.
if [[ "$PG_NAME" == snapshot-*/* ]]; then
  SNAPSHOT=${PG_NAME%%/*}
  [[ "$SNAPSHOT" != *..* && "${PG_NAME#*/}" != */* ]] || exit 1
  [ -f "$BACKUP_DIR/$SNAPSHOT/COMPLETE" ] || { echo 'incomplete snapshot'; exit 1; }
  (cd "$BACKUP_DIR/$SNAPSHOT"; sha256sum -c SHA256SUMS) || exit 1
  BACKUP_DIR="$BACKUP_DIR/$SNAPSHOT"
  PG_NAME=${PG_NAME#*/}
else
  echo 'WARNING: legacy snapshot has no completeness manifest; verify it manually.'
fi
[[ "$PG_NAME" =~ ^pg-[0-9]{8}-[0-9]{6}Z.sql.gz$ ]] || { echo 'invalid snapshot name'; exit 1; }
PG_FILE="$BACKUP_DIR/$PG_NAME"
if [ ! -f "$PG_FILE" ]; then
  echo "ошибка: $PG_FILE не найден"
  exit 1
fi

gzip -t "$PG_FILE"

# Соответствующая директория MinIO: pg-<TS>.sql.gz ↔ minio-<TS>/
TS="${PG_NAME#pg-}"
TS="${TS%.sql.gz}"
MINIO_DIR="$BACKUP_DIR/minio-$TS"

log() { echo "[restore $(date -u +%H:%M:%S)] $*"; }

log "PG snapshot:   $PG_FILE"
if [ $SKIP_MINIO -eq 0 ]; then
  log "MinIO snapshot: $MINIO_DIR"
  if [ ! -d "$MINIO_DIR" ]; then
    echo "ВНИМАНИЕ: $MINIO_DIR не найден. Используй --skip-minio чтобы пропустить."
    exit 1
  fi
fi

echo
echo "  ⚠ ВСЕ ТЕКУЩИЕ ДАННЫЕ БУДУТ ПЕРЕЗАПИСАНЫ"
echo
read -r -p "  напиши 'YES' чтобы продолжить: " confirm
[ "$confirm" = "YES" ] || { echo "отменено."; exit 1; }

# ───── 1. Postgres restore ─────
log "restoring postgres from $PG_FILE"
# Сама миграция `pg-*.sql.gz` создана с `--clean --if-exists`, поэтому
# psql сам дропает таблицы перед re-creation. Это безопасно: каскадно
# подчистит все FK.
gunzip -c "$PG_FILE" | PGPASSWORD="${PGPASSWORD:-}" psql \
  --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --set ON_ERROR_STOP=on \
  "$PGDATABASE"

# ───── 2. MinIO restore ─────
if [ $SKIP_MINIO -eq 0 ]; then
  log "restoring minio from $MINIO_DIR"
  S3_SCHEME=http
  S3_NETLOC=${S3_ENDPOINT#http://}
  case "$S3_ENDPOINT" in
    https://*) S3_SCHEME=https; S3_NETLOC=${S3_ENDPOINT#https://} ;;
  esac
  export MC_HOST_dst="${S3_SCHEME}://${S3_ACCESS_KEY}:${S3_SECRET_KEY}@${S3_NETLOC}"

  # --remove синхронизирует с удалениями: всё, чего нет в бэкапе, удаляется.
  mc mirror --overwrite --remove --quiet "$MINIO_DIR/$S3_BUCKET"       "dst/$S3_BUCKET"
  mc mirror --overwrite --remove --quiet "$MINIO_DIR/$S3_EMOJI_BUCKET" "dst/$S3_EMOJI_BUCKET"
fi

log "ok: restored from $TS"
