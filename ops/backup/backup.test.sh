#!/usr/bin/env bash
# Fault injection ONLY: fake pg_dump/mc/rsync, synthetic files, no real services.
set -euo pipefail
SCRIPT=$(cd "$(dirname "$0")"; pwd)/backup.sh
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/backups/snapshot-old"
export BACKUP_DIR="$TMP/backups" S3_ACCESS_KEY=test S3_SECRET_KEY=test PGHOST=invalid.invalid S3_ENDPOINT=http://invalid.invalid
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/pg_dump" <<'SH'
#!/usr/bin/env bash
[ "${FAIL_PG:-0}" = 0 ] || exit 7
printf '%2048s' 'synthetic SQL dump for fault injection only'
SH
cat > "$TMP/bin/mc" <<'SH'
#!/usr/bin/env bash
[ "${FAIL_MC:-0}" = 0 ] || exit 8
dest="${@: -1}"
mkdir -p "$dest"
printf test > "$dest/test-object"
SH
cat > "$TMP/bin/rsync" <<'SH'
#!/usr/bin/env bash
[ "${FAIL_RSYNC:-0}" = 0 ] || exit 9
SH
chmod +x "$TMP/bin/"*
printf 'last known good' > "$BACKUP_DIR/snapshot-old/sentinel"
touch "$BACKUP_DIR/snapshot-old/COMPLETE" "$BACKUP_DIR/snapshot-old/SHA256SUMS"
touch -d '40 days ago' "$BACKUP_DIR/snapshot-old"
expect_failure() {
  if env "$@" bash "$SCRIPT" > "$TMP/run.log" 2>&1; then cat "$TMP/run.log"; echo 'expected failure'; exit 1; fi
  ! grep -q 'ok:' "$TMP/run.log"
  [ -f "$BACKUP_DIR/snapshot-old/sentinel" ]
  [ ! -d "$BACKUP_DIR/.backup-lock" ]
  [ "$(find "$BACKUP_DIR" -maxdepth 1 -name '.incomplete-*' | wc -l)" = 0 ]
}
expect_failure FAIL_PG=1
expect_failure FAIL_MC=1
[ "$(find "$BACKUP_DIR" -maxdepth 2 -name COMPLETE | wc -l)" = 1 ]
expect_failure FAIL_RSYNC=1 OFFSITE_RSYNC_TARGET=invalid.invalid:/synthetic-only
# Valid local snapshot remains after off-site failure, old snapshot not rotated.
[ "$(find "$BACKUP_DIR" -maxdepth 2 -name COMPLETE | wc -l)" = 2 ]
bash "$SCRIPT" > "$TMP/run.log" 2>&1
[ ! -d "$BACKUP_DIR/snapshot-old" ]
for snapshot in "$BACKUP_DIR"/snapshot-*; do
  [ -f "$snapshot/COMPLETE" ]
  (cd "$snapshot"; sha256sum -c SHA256SUMS >/dev/null)
done
echo 'PASS: pg failure, mirror failure, offsite failure, cleanup, completeness, checksums, safe retention'
