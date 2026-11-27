#!/bin/sh
set -eu
case "${QUEUEBRIDGE_SERVICE:-}" in
  web) entry=infra/rumptycloud/web.mjs ;;
  worker) entry=apps/worker/dist/worker.js ;;
  *) echo 'QUEUEBRIDGE_SERVICE must be web or worker.' >&2; exit 1 ;;
esac
exec sh infra/rumptycloud/node-with-db-ca.sh "$entry"
