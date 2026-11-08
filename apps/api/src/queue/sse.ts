import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiProblem } from '../errors.js';
import type { QueueNotifier, QueueSignal } from './notifier.js';

export const SSE_HEARTBEAT_MS = 20_000;
/** Streams end after this long; clients reconnect, which re-runs authentication/authorization. */
export const SSE_MAX_LIFETIME_MS = 15 * 60_000;
export const SSE_MAX_PER_IP = 20;
export const SSE_MAX_TOTAL = 2_000;

const perIp = new Map<string, number>();
let total = 0;

export interface SseOptions {
  notifier: QueueNotifier;
  /** Only signals passing this filter are forwarded (as a bare revision number). */
  filter: (signal: QueueSignal) => boolean;
  initialRevision: number;
}

/**
 * Open a Server-Sent Events stream that carries ONLY change signals (`event: change`,
 * `data: {"revision":n}`). Clients refetch through their normal authorized endpoint; no queue
 * data, ticket data or identifiers flow through the stream.
 */
export async function openSse(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: SseOptions,
): Promise<void> {
  const ip = req.ip;
  if (total >= SSE_MAX_TOTAL || (perIp.get(ip) ?? 0) >= SSE_MAX_PER_IP) {
    throw new ApiProblem(429, 'too-many-streams', 'Too many live connections', {
      detail: 'Close other live views or rely on periodic refresh.',
      headers: { 'Retry-After': '30' },
    });
  }
  try {
    await opts.notifier.ensureStarted();
  } catch {
    throw new ApiProblem(503, 'live-updates-unavailable', 'Live updates unavailable', {
      detail: 'Live updates are temporarily unavailable; the page will refresh periodically.',
      headers: { 'Retry-After': '15' },
    });
  }

  total += 1;
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  });
  raw.write(
    `retry: 5000\n\nevent: ready\ndata: ${JSON.stringify({ revision: opts.initialRevision })}\n\n`,
  );

  let closed = false;
  const unsubscribe = opts.notifier.subscribe((signal) => {
    if (!closed && opts.filter(signal)) {
      raw.write(`event: change\ndata: ${JSON.stringify({ revision: signal.r })}\n\n`);
    }
  });
  const heartbeat = setInterval(() => {
    if (!closed) raw.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);
  const lifetime = setTimeout(() => cleanup(true), SSE_MAX_LIFETIME_MS);

  function cleanup(end: boolean): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    unsubscribe();
    total -= 1;
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
    if (end) raw.end();
  }
  req.raw.on('close', () => cleanup(false));
}
