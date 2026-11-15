#!/bin/sh
# Restore drill: proves the newest backup in /srv/raven/backups (or the one named) can be
# restored, without touching the live database. It restores the dump into a throwaway
# Postgres container, counts a few tables, checks every file in the media archive reads
# back, and removes everything it made. The live stack keeps running.
#
#   /srv/raven/restore-check-raven.sh [raven-<stamp>.dump[.age]]
#
# Encrypted backups need the age identity (private key) that matches
# RAVEN_BACKUP_AGE_RECIPIENTS: RAVEN_BACKUP_AGE_IDENTITY=/path/to/key. Keep that key off
# this host; bring it for the drill and remove it after.
set -eu
umask 077
backup_dir=/srv/raven/backups
# The same image compose.yaml runs, so the dump restores with the same Postgres.
image=postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
identity=${RAVEN_BACKUP_AGE_IDENTITY:-}

if [ $# -gt 0 ]; then
  dump=$backup_dir/$(basename "$1")
else
  dump=$(ls -1t "$backup_dir"/raven-*.dump "$backup_dir"/raven-*.dump.age 2>/dev/null | head -n 1 || true)
fi
[ -n "$dump" ] && [ -s "$dump" ] || { echo "no backup found in $backup_dir" >&2; exit 1; }
stamp=$(basename "$dump" | sed -E 's/^raven-(.*)\.dump(\.age)?$/\1/')
media=$(ls -1 "$backup_dir/raven-media-$stamp.tar.gz" "$backup_dir/raven-media-$stamp.tar.gz.age" 2>/dev/null | head -n 1 || true)

work=$(mktemp -d)
name=raven-restore-check-$$
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

# open <file>: the backup's plaintext on stdout, decrypting it when it ends in .age.
open() {
  case "$1" in
    *.age)
      [ -n "$identity" ] || { echo "$1 is encrypted: set RAVEN_BACKUP_AGE_IDENTITY" >&2; exit 1; }
      age -d -i "$identity" "$1" ;;
    *) cat "$1" ;;
  esac
}

echo "== Restoring $(basename "$dump") into a throwaway database"
open "$dump" > "$work/raven.dump"
docker run -d --name "$name" --network none -e POSTGRES_PASSWORD=restore-check \
  -e POSTGRES_USER=raven -e POSTGRES_DB=raven "$image" >/dev/null
tries=0
until docker exec "$name" pg_isready -U raven -d raven >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || { echo "the throwaway database did not start" >&2; exit 1; }
  sleep 1
done
# pg_isready can pass during the image's first-start restart; wait for it to settle.
sleep 3
docker exec -i "$name" pg_restore -U raven -d raven --no-owner --exit-on-error < "$work/raven.dump"
for table in users trees chat_messages schema_migrations; do
  count=$(docker exec "$name" psql -U raven -d raven -At -c "SELECT count(*) FROM $table")
  echo "  $table: $count rows"
done

if [ -n "$media" ]; then
  echo "== Reading back $(basename "$media")"
  files=$(open "$media" | tar -tzf - | grep -vc '/$' || true)
  echo "  $files files"
else
  echo "== No media archive for $stamp" >&2
  exit 1
fi
echo "Restore check passed for $stamp."
