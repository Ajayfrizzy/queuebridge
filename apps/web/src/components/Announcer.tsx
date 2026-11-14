import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { createAnnouncePolicy, type AnnounceOptions } from '../lib/announcePolicy.js';

export type Announce = (message: string, opts?: AnnounceOptions) => void;
const AnnounceContext = createContext<Announce>(() => undefined);

/** How long a visible notification stays before it dismisses itself. */
export const TOAST_VISIBLE_MS = 8000;
/** Least time between two messages in the same live region */
export const MESSAGE_GAP_MS = 300;
const MAX_QUEUED = 8;

/**
 * Status messages for everyone:
 *  - A visually-hidden polite live region always carries the message to screen readers
 *    (it is cleared shortly after so it never lingers in the accessibility tree).
 *  - A visible notification is dismissible by button or Escape, and auto-dismisses.
 *    Dismissing it never removes the announcement, and it is not itself a live region, so
 *    screen readers do not hear the message twice.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }): ReactElement {
  const [liveText, setLiveText] = useState('');
  const [assertiveText, setAssertiveText] = useState('');
  const [visible, setVisible] = useState('');
  // Deduplication and rate limits live for the page session (see lib/announcePolicy.ts)
  const policy = useRef(createAnnouncePolicy());
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearLiveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dismiss = useCallback((): void => {
    clearTimeout(hideTimer.current);
    setVisible('');
  }, []);

  // What each live region currently holds (state is async; the policy needs the latest value)
  const spoken = useRef({ polite: '', assertive: '' });
  // Messages wait their turn per level. React batches state updates made in the same instant, so
  // writing two messages straight into one region would show only the last one and an important
  // message (offline, needs review, a call) could be lost. Each is written in order, at least
  // MESSAGE_GAP_MS apart, so a screen reader can take each one in.
  const queues = useRef<{ polite: string[]; assertive: string[] }>({ polite: [], assertive: [] });
  const busy = useRef({ polite: false, assertive: false });
  const write = useCallback((level: 'polite' | 'assertive', message: string): void => {
    const setRegion = level === 'assertive' ? setAssertiveText : setLiveText;
    const show = (): void => {
      spoken.current[level] = message;
      setRegion(message);
      setVisible(message);
      clearTimeout(hideTimer.current);
      clearTimeout(clearLiveTimer.current);
      hideTimer.current = setTimeout(() => setVisible(''), TOAST_VISIBLE_MS);
      clearLiveTimer.current = setTimeout(() => {
        spoken.current = { polite: '', assertive: '' };
        setLiveText('');
        setAssertiveText('');
      }, TOAST_VISIBLE_MS + 2000);
    };
    if (spoken.current[level] === message) {
      // The very same words again: empty the region first so the change is announced anew
      spoken.current[level] = '';
      setRegion('');
      setTimeout(show, 30);
    } else {
      show();
    }
  }, []);
  const pump = useCallback(
    (level: 'polite' | 'assertive'): void => {
      if (busy.current[level]) return;
      const next = queues.current[level].shift();
      if (next === undefined) return;
      busy.current[level] = true;
      write(level, next);
      setTimeout(() => {
        busy.current[level] = false;
        pump(level);
      }, MESSAGE_GAP_MS);
    },
    [write],
  );
  const announce = useCallback<Announce>(
    (message, opts) => {
      if (!policy.current.admit(message, opts)) return;
      const level = opts?.assertive === true ? 'assertive' : 'polite';
      const q = queues.current[level];
      q.push(message);
      // A long backlog is stale: keep the newest few (every distinct message normally fits)
      while (q.length > MAX_QUEUED) q.shift();
      pump(level);
    },
    [pump],
  );
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    return (): void => document.removeEventListener('keydown', onKey);
  }, [visible, dismiss]);

  useEffect(
    () => (): void => {
      clearTimeout(hideTimer.current);
      clearTimeout(clearLiveTimer.current);
    },
    [],
  );

  const value = useMemo(() => announce, [announce]);
  return (
    <AnnounceContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="visually-hidden"
        data-testid="status"
      >
        {liveText}
      </div>
      {/* Both regions exist from page load; text is only ever put into an existing region */}
      <div
        aria-live="assertive"
        aria-atomic="true"
        className="visually-hidden"
        data-testid="status-assertive"
      >
        {assertiveText}
      </div>
      {visible ? (
        <div className="toast" data-testid="toast">
          <span>{visible}</span>
          <button type="button" className="toast-dismiss" onClick={dismiss}>
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">Dismiss notification</span>
          </button>
        </div>
      ) : null}
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}
