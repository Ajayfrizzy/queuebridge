// Managed entry point. Only known build files become routes; URLs never become filesystem paths.
import { createReadStream } from 'node:fs';
import { readdir, access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { buildApp } from '../../apps/api/dist/app.js';
import { parseEnv } from '../../apps/api/dist/env.js';
import { WEB_SECURITY_HEADERS } from '../../apps/web/src/pwa/securityHeaders.ts';

const env = parseEnv();
const root = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url));
await access(join(root, 'index.html'));
const app = await buildApp(env, { exposeDbReadiness: false });
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
function serve(file) {
  return async (_request, reply) =>
    reply
      .headers(WEB_SECURITY_HEADERS)
      .header(
        'Cache-Control',
        file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      )
      .type(types[extname(file)])
      .send(createReadStream(join(root, file)));
}
for (const dir of ['', 'assets/', 'icons/']) {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (entry.isFile() && Object.hasOwn(types, extname(entry.name)))
      app.get('/' + dir + entry.name, serve(dir + entry.name));
  }
}
for (const path of [
  '/',
  '/login',
  '/signup',
  '/accept-invite',
  '/recover',
  '/recover/*',
  '/ticket/*',
  '/join/*',
  '/display/*',
  '/admin',
  '/admin/*',
  '/staff',
  '/staff/*',
  '/supervisor/*',
])
  app.get(path, serve('index.html'));
await app.listen({ host: '0.0.0.0', port: env.PORT });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close();
  });
