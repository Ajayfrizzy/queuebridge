/**
 * M7.2 security headers for the served web app (design §14.7; REQ-F15.7.1). Single source:
 *
 * - `vite preview` (the server the Playwright suite runs against) sends exactly these headers on
 *   every response, so the browser tests exercise the app under the production policy;
 * - `docs/deployment/web-security-headers.md` is the deployment requirement for the production
 *   edge (static host or reverse proxy), checked against this file by `securityHeaders.test.ts`.
 *
 * Headers are a server concern: they are never set from React or `<meta>` tags (frame-ancestors
 * and HSTS cannot be set that way). HSTS only takes effect over HTTPS, so it is verified for real
 * only once the app is served over TLS.
 *
 * The CSP allows nothing from another origin. Allowances, each needed by shipped code:
 * `img-src data: blob:` for the select chevron and other inline SVG data URIs in CSS and the QR
 * download; `worker-src 'self'` and `manifest-src 'self'` for the PWA.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Features the app does not use are switched off; the ones it uses stay same-origin only. */
export const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'display-capture=()',
  'clipboard-write=(self)',
  'web-share=(self)',
  'fullscreen=(self)',
].join(', ');

export const WEB_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'X-Content-Type-Options': 'nosniff',
});
