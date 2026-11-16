#!/bin/sh
# Run by raven-alert@<unit>.service when <unit> fails (OnFailure=). It always logs an
# error to the journal and leaves /srv/raven/backups/FAILED-<unit> with the time and the
# unit's last log lines, which a later successful backup does not remove: delete it once
# the cause is fixed.
#
# To be told elsewhere, set RAVEN_ALERT_COMMAND in /etc/raven-alert.env to a command that
# reads the message on stdin, for example a mail command or a curl to a webhook you run.
# Off when unset. The message holds the host name, the unit and its last 20 log lines,
# which name files and errors, never message content.
set -u
unit=${1:?usage: raven-alert.sh <unit>}
host=$(hostname)
message=$(printf '%s: %s failed at %s\n\n%s\n' "$host" "$unit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(journalctl -u "$unit" -n 20 --no-pager -o cat 2>/dev/null)")

logger -p user.err -t raven-alert "$unit failed on $host"
mkdir -p /srv/raven/backups
printf '%s\n' "$message" > "/srv/raven/backups/FAILED-$unit"
if [ -n "${RAVEN_ALERT_COMMAND:-}" ]; then
  printf '%s\n' "$message" | sh -c "$RAVEN_ALERT_COMMAND" || logger -p user.err -t raven-alert "RAVEN_ALERT_COMMAND failed"
fi
