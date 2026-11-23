#!/bin/sh
# Resolve the trust anchor before starting Node (it reads NODE_EXTRA_CA_CERTS at startup).
set -eu
cd -P "$(dirname "$0")/../.."
export NODE_EXTRA_CA_CERTS="$(pwd -P)/apps/certs/queuebridge-ca.crt"
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
try {
  new X509Certificate(readFileSync(process.env.NODE_EXTRA_CA_CERTS));
  const url = new URL(process.env.DATABASE_URL);
  const modes = url.searchParams.getAll('sslmode');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname || isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      modes.length !== 1 || modes[0] !== 'verify-full' ||
      ['ssl', 'sslrootcert', 'host', 'path'].some(key => url.searchParams.has(key)) ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error();
} catch {
  console.error('A readable PostgreSQL certificate and DNS connection URL with sslmode=verify-full are required.');
  process.exit(1);
}
JS
exec node "$@"
