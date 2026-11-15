#!/usr/bin/env bash
# Rotates Saye's Raven access logs in /opt/nginx/logs and keeps a week of them.
# Each log is renamed while nginx keeps writing to it, then nginx is told to reopen its
# logs (nginx -s reopen) and starts a new file, so no line is lost the way it was between
# a copy and a truncate. Rotated files are compressed once nginx has let go of them.
# The file work runs in a throwaway container, as root, because the logs are root's.
#   NGINX_CONTAINER  the edge nginx container (default edge-nginx)
set -euo pipefail
container=${NGINX_CONTAINER:-edge-nginx}
image=nginx:1.30-alpine@sha256:0d3b80406a13a767339fbe2f41406d6c7da727ab89cf8fae399e81f780f814d1
stamp=$(date -u +%Y%m%dT%H%M%SZ)

in_logs() {
  docker run --rm --entrypoint sh --volume /opt/nginx/logs:/logs "$image" -eu -c "$1" sh "$stamp"
}

rotated=$(in_logs '
  for file in /logs/raven-*.access.log; do
    test -s "$file" || continue
    mv "$file" "$file.$1"
    echo "$file.$1"
  done
')

if [ -n "$rotated" ]; then
  docker exec "$container" nginx -s reopen
  # Workers reopen on their next event; give them a moment before compressing.
  sleep 5
  in_logs 'gzip /logs/raven-*.access.log."$1"'
fi
in_logs 'find /logs -type f -name "raven-*.access.log.*.gz" -mtime +6 -delete'
