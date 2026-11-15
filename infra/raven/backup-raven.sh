#!/bin/sh
# Nightly backup on the Raven host: a pg_dump (custom format, verified with pg_restore
# --list) and a tarball of the media folder (verified with tar -t), kept 14 days in
# /srv/raven/backups.
#
# On its own this stays on the same machine as the data. It protects against a bad change
# or a deleted row, not against losing the host or its disk. Two optional steps, set in
# /etc/raven-backup.env (see docs/releasing.md, "Backups"), cover that:
#
#   RAVEN_BACKUP_AGE_RECIPIENTS  a file of age public keys. Each backup is encrypted to
#                                them and the plaintext removed. Off when unset.
#   RAVEN_BACKUP_OFFSITE         an rsync destination (user@host:/path/). The night's files
#                                are copied there. Refused unless backups are encrypted,
#                                because they hold every message.
#   RAVEN_BACKUP_SSH             the ssh command rsync uses (default: ssh -o BatchMode=yes).
#
# A failure exits non-zero, so systemd runs the OnFailure= unit (raven-alert@.service).
set -eu
umask 077
backup_dir=/srv/raven/backups
recipients=${RAVEN_BACKUP_AGE_RECIPIENTS:-}
offsite=${RAVEN_BACKUP_OFFSITE:-}
ssh_cmd=${RAVEN_BACKUP_SSH:-ssh -o BatchMode=yes}

if [ -n "$offsite" ] && [ -z "$recipients" ]; then
  echo "RAVEN_BACKUP_OFFSITE is set but RAVEN_BACKUP_AGE_RECIPIENTS is not: refusing to copy unencrypted backups off the host" >&2
  exit 1
fi
if [ -n "$recipients" ]; then
  command -v age >/dev/null || { echo "age is not installed (apt install age)" >&2; exit 1; }
  [ -s "$recipients" ] || { echo "$recipients is missing or empty" >&2; exit 1; }
fi

mkdir -p "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_dir/raven-$stamp.dump"
media="$backup_dir/raven-media-$stamp.tar.gz"
trap 'rm -f "$target.part" "$media.part" "$target.age.part" "$media.age.part"' EXIT HUP INT TERM

docker exec raven-postgres-1 pg_dump -U raven -d raven -Fc > "$target.part"
test -s "$target.part"
docker exec -i raven-postgres-1 pg_restore --list < "$target.part" > /dev/null
mv "$target.part" "$target"

tar -C /srv/raven/media -czf "$media.part" .
tar -tzf "$media.part" > /dev/null
mv "$media.part" "$media"

made="$target $media"
if [ -n "$recipients" ]; then
  made=""
  for file in "$target" "$media"; do
    age -R "$recipients" -o "$file.age.part" "$file"
    test -s "$file.age.part"
    mv "$file.age.part" "$file.age"
    rm -f "$file"
    made="${made:+$made }$file.age"
  done
fi
trap - EXIT HUP INT TERM

if [ -n "$offsite" ]; then
  # shellcheck disable=SC2086 # $made is a list of paths without spaces.
  rsync -t --chmod=F600 -e "$ssh_cmd" $made "$offsite"
fi

find "$backup_dir" -type f \( -name 'raven-*.dump' -o -name 'raven-*.dump.age' \
  -o -name 'raven-media-*.tar.gz' -o -name 'raven-media-*.tar.gz.age' \) -mtime +14 -delete
printf 'Raven backup completed: %s%s\n' "$made" "${offsite:+ (copied to $offsite)}"
