#!/usr/bin/env bash
# PGSERVICE selects a libpq service. Only the public recovery certificate is needed here.
set -euo pipefail
umask 077
: "${PGSERVICE:?set the source service}" "${BACKUP_CERT:?set the public PEM certificate}"
out=${1:?supply a new encrypted archive pathname}
tmp=$(mktemp "${out}.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT
pg_dump --format=custom --no-password | openssl cms -encrypt -binary -stream -aes-256-gcm \
  -outform DER -out "$tmp" "$BACKUP_CERT"
# Link publishes atomically and refuses an existing destination.
ln "$tmp" "$out"
