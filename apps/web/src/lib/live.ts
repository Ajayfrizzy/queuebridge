import { useEffect, useRef, useState } from 'react';

export type LiveMode = 'connecting' | 'live' | 'polling';

/** Polling interval used whenever the live stream is unavailable (REQ: polling fallback). */
export const POLL_INTERVAL_MS = 15_000;

/**
 * Subscribe to a QueueBridge change-signal stream (SSE over fetch, so custom headers such as the
 * ticket token can be sent). Calls `onChange` for every signal and, while the stream is down,
 * every POLL_INTERVAL_MS. Reconnects with capped exponential backoff.
 *
 * The stream carries no data; `onChange` must refetch through the normal endpoint.
 */
export function useLiveUpdates(
  url: string | null,
  headers: Record<string, string> | null,
  onChange: () => void,
): LiveMode {
  const [mode, setMode] = useState<LiveMode>('connecting');
  const cb = useRef(onChange);
  cb.current = onChange;
  const headerKey = headers ? JSON.stringify(headers) : '';

  useEffect(() => {
    if (!url) return undefined;
    let stopped = false;
    let controller: AbortController | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const hdrs = headerKey ? (JSON.parse(headerKey) as Record<string, string>) : {};

    const startPolling = (): void => {
      if (poll) return;
      setMode('polling');
      poll = setInterval(() => cb.current(), POLL_INTERVAL_MS);
    };
    const stopPolling = (): void => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    const connect = async (): Promise<void> => {
      controller = new AbortController();
      try {
        const res = await fetch(url, {
          headers: { Accept: 'text/event-stream', ...hdrs },
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        attempt = 0;
        stopPolling();
        setMode('live');
        cb.current(); // catch up on anything missed while disconnected
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (frame.includes('event: change')) cb.current();
          }
        }
      } catch {
        // fall through to reconnect
      }
      if (stopped) return;
      startPolling();
      attempt += 1;
      retry = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    };

    void connect();
    return (): void => {
      stopped = true;
      controller?.abort();
      stopPolling();
      if (retry) clearTimeout(retry);
    };
  }, [url, headerKey]);

  return mode;
}
