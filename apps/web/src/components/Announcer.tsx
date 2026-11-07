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

const AnnounceContext = createContext<(message: string) => void>(() => undefined);

/** How long a visible notification stays before it dismisses itself. */
export const TOAST_VISIBLE_MS = 8000;

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
  const [visible, setVisible] = useState('');
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearLiveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dismiss = useCallback((): void => {
    clearTimeout(hideTimer.current);
    setVisible('');
  }, []);

  const announce = useCallback((message: string): void => {
    clearTimeout(hideTimer.current);
    clearTimeout(clearLiveTimer.current);
    // Clear first so repeating the same message is announced again
    setLiveText('');
    setVisible('');
    setTimeout(() => {
      setLiveText(message);
      setVisible(message);
      hideTimer.current = setTimeout(() => setVisible(''), TOAST_VISIBLE_MS);
      clearLiveTimer.current = setTimeout(() => setLiveText(''), TOAST_VISIBLE_MS + 2000);
    }, 30);
  }, []);

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

export function useAnnounce(): (message: string) => void {
  return useContext(AnnounceContext);
}
