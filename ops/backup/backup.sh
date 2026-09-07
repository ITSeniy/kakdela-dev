#!/usr/bin/env bash
# Complete snapshots are published by one same-filesystem rename.
# Legacy pg-*/minio-* snapshots are preserved and never rotated by this script.
set -euo pipefail
umask 077
TS=$(date -u +%Y%m%d-%H%M%SZ)
BACKUP_DIR=${BACKUP_DIR:-/backups}
RETENTION_DAYS=${RETENTION_DAYS:-14}
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo 'invalid retention'; exit 1; }
PGHOST=${PGHOST:-postgres}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-kakdela}
PGDATABASE=${PGDATABASE:-kakdela}
S3_ENDPOINT=${S3_ENDPOINT:-http://minio:9000}
S3_BUCKET=${S3_BUCKET:-kakdela}
S3_EMOJI_BUCKET=${S3_EMOJI_BUCKET:-kakdela-emoji}
for bucket in "$S3_BUCKET" "$S3_EMOJI_BUCKET"; do
  [[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || { echo 'invalid bucket'; exit 1; }
done
log() { echo "[backup $(date -u +%H:%M:%S)] $*"; }
mkdir -p "$BACKUP_DIR"
# mkdir is portable and prevents overlapping backups and retention races.
LOCK="$BACKUP_DIR/.backup-lock"
mkdir "$LOCK" || { log 'ERROR: another backup holds the lock (inspect stale locks manually)'; exit 1; }
STAGE=""
cleanup() {
  status=$?
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf -- "$STAGE"; fi
  rmdir "$LOCK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
STAGE=$(mktemp -d "$BACKUP_DIR/.incomplete-$TS.XXXXXX")
NAME="snapshot-$TS-${STAGE##*.}"
FINAL="$BACKUP_DIR/$NAME"
PG_FILE="$STAGE/pg-$TS.sql.gz"
MINIO_DIR="$STAGE/minio-$TS"
log 'dumping postgres'
PGPASSWORD="${PGPASSWORD:-}" pg_dump --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" \
  --no-owner --no-privileges --clean --if-exists "$PGDATABASE" | gzip -9 > "$PG_FILE"
gzip -t "$PG_FILE"
# Validate uncompressed content (small compressed dumps can be valid).
[ "$(gzip -dc "$PG_FILE" | wc -c)" -ge 1024 ] || { log 'ERROR: empty/suspicious dump'; exit 1; }
mkdir -p "$MINIO_DIR/$S3_BUCKET" "$MINIO_DIR/$S3_EMOJI_BUCKET"
S3_SCHEME=http
S3_NETLOC=${S3_ENDPOINT#http://}
case "$S3_ENDPOINT" in
  https://*) S3_SCHEME=https; S3_NETLOC=${S3_ENDPOINT#https://} ;;
  http://*) ;;
  *) log 'ERROR: invalid S3 endpoint'; exit 1 ;;
esac
export MC_HOST_src="${S3_SCHEME}://${S3_ACCESS_KEY}:${S3_SECRET_KEY}@${S3_NETLOC}"
# Any failure aborts before publishing, off-site replication or retention.
mc mirror --overwrite --quiet "src/$S3_BUCKET" "$MINIO_DIR/$S3_BUCKET"
mc mirror --overwrite --quiet "src/$S3_EMOJI_BUCKET" "$MINIO_DIR/$S3_EMOJI_BUCKET"
printf 'format=2\ntimestamp=%s\npostgres=%s\nminio=%s\nmain_bucket=%s\nemoji_bucket=%s\n' \
  "$TS" "pg-$TS.sql.gz" "minio-$TS" "$S3_BUCKET" "$S3_EMOJI_BUCKET" > "$STAGE/manifest.txt"
(cd "$STAGE"; find . -type f ! -name SHA256SUMS ! -name COMPLETE -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS; sha256sum -c SHA256SUMS)
printf 'complete\n' > "$STAGE/COMPLETE"
mv -- "$STAGE" "$FINAL"
STAGE=""
if [ -n "${OFFSITE_RSYNC_TARGET:-}" ]; then
  # Never mirror the entire backup root or delete remote known-good snapshots.
  # Publish remotely only after rsync succeeds; SSH target admin handles retention.
  rsync -az --exclude=COMPLETE "$FINAL" "$OFFSITE_RSYNC_TARGET/"
  rsync -az "$FINAL/COMPLETE" "$OFFSITE_RSYNC_TARGET/$NAME/COMPLETE"
fi
# Only complete v2 snapshots, never the just-created last valid snapshot.
while IFS= read -r -d '' old; do
  [ "$old" = "$FINAL" ] && continue
  [ -f "$old/COMPLETE" ] && [ -f "$old/SHA256SUMS" ] || continue
  rm -rf -- "$old"
done < <(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'snapshot-*' -mtime "+$RETENTION_DAYS" -print0)
log "ok: $NAME (restore verification/drills still required)"
