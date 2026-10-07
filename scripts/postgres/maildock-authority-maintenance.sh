#!/bin/sh
set -eu
if [ "${1:-}" != "--writers-stopped-backup-verified" ]; then
  echo 'Stop all Maildock writers and verify the matched database/attachment backup and required keys before running with --writers-stopped-backup-verified.' >&2
  exit 1
fi
authority=/docker-entrypoint-initdb.d/99-maildock-authority.sql
# This socket connection must close before the new password-authenticated one.
psql -X -w -v ON_ERROR_STOP=1 -U maildock -d maildock -f "$authority"
# Environment credentials must still match the existing DATABASE_URL. Changing
# POSTGRES_PASSWORD never resets credentials in an existing PostgreSQL volume.
# initdb's loopback HBA rules can use trust. Use the private service address and
# reject passwordless/custom trust authentication before claiming verification.
if PGPASSWORD="${POSTGRES_PASSWORD}-maildock-password-auth-probe" \
  psql -X -w -h postgres -U maildock -d maildock -c 'SELECT 1' >/dev/null 2>&1; then
  echo 'Maildock password authentication could not be verified. Request DBA review of bundled PostgreSQL authentication; keep writers stopped.' >&2
  exit 1
fi
PGPASSWORD="$POSTGRES_PASSWORD" psql -X -w -v ON_ERROR_STOP=1 \
  -h postgres -U maildock -d maildock -f "$authority"
echo 'Maildock database authority verified through a new password-authenticated connection. Normal migrations/startup may now run.'
