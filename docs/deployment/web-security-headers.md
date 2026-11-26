# Web app security headers — deployment requirement (M7.2)

**Status:** requirement for the production host (RumptyCloud, not yet deployed). Source of truth:
`apps/web/src/pwa/securityHeaders.ts`; `apps/web/src/pwa/securityHeaders.test.ts` fails if this
document and that file disagree.

The web app is a static build (`apps/web/dist`). Its headers are a serving concern: they are set by
the host or reverse proxy in front of the static files, never from React or `<meta>` tags. The API
(Fastify) already sets its own headers on `/api/*` (`apps/api/src/app.ts`).

## Required on every web-app response (HTML, JS, CSS, images, `sw.js`, the manifest)

| Header                      | Value                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` (HTTPS only; never on a plain-HTTP origin)                                                                                                                                                                                     |
| `X-Frame-Options`           | `DENY`                                                                                                                                                                                                                                                               |
| `Referrer-Policy`           | `no-referrer`                                                                                                                                                                                                                                                        |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), clipboard-write=(self), web-share=(self), fullscreen=(self)`                                                                                                                      |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                                                                                                                                                            |

The CSP assumes the API is served from the **same origin** as the web app (`/api/*` proxied), as
in every current environment. If the API moves to another origin, `connect-src` must list it
explicitly, and this document and the source file change together.

## How it is verified

- **Locally (done):** `vite preview` sends this exact set (`apps/web/vite.config.ts`), and the full
  Playwright suite runs under it. `apps/web/e2e/landing.spec.ts` asserts every header on the
  landing response and that no CSP violation occurs on the landing, join, ticket, console and
  board screens.
- **Not verifiable until deployment:** that the production edge sends them; HSTS behaviour over
  real HTTPS (browsers ignore HSTS on `http://localhost`); TLS configuration. After deployment, check
  with `curl -sI https://<host>/` and the browser devtools, and record the result in
  `docs/archive/testing/M7-evidence.md` (M7.3/M7.5).
