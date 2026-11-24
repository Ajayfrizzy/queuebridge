// Create a new private credential envelope in the operator's protected directory.
import { randomBytes } from 'node:crypto';
import { writeFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profiles, roles } from './demo-profiles.js';

function generate() {
  const [profile, filename, ...extra] = process.argv.slice(2);
  if (!Object.hasOwn(profiles, profile) || !filename || extra.length)
    throw new Error('Select owner-qa or judge-demo and a new private file outside the checkout');
  const parent = realpathSync(dirname(resolve(filename)));
  const repo = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const dir = statSync(parent);
  if (
    parent === repo ||
    parent.startsWith(repo + sep) ||
    dir.uid !== process.getuid() ||
    (dir.mode & 0o077) !== 0
  )
    throw new Error('Use an operator-owned private directory outside the checkout');
  const passwords = Object.fromEntries(
    roles.map((role) => [role, randomBytes(32).toString('base64url')]),
  );
  writeFileSync(
    join(parent, resolve(filename).split(sep).pop()),
    JSON.stringify({ profile, passwords }),
    { flag: 'wx', mode: 0o600 },
  );
}
generate();
