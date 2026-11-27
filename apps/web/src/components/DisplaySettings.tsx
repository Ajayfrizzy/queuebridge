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
import {
  A11Y_KEY,
  DEFAULT_PREFS,
  applyPrefs,
  clearPrefs,
  detectCueSupport,
  loadPrefs,
  parsePrefs,
  savePrefs,
  type A11yPrefs,
  type Contrast,
  type Theme,
  type CueSupport,
  type Motion,
  type TextSize,
} from '../lib/a11yPrefs.js';
import { runTestAlert } from '../lib/alertCues.js';

/**
 * Device-local "Display and alerts" preferences (REQ-F7.10, REQ-F7.15; design §16.2).
 *
 * One provider owns the preferences and one dialog edits them; the shared header and the ticket
 * page only ask to open it. Changes apply at once, persist on this device only and work offline.
 * The dialog is a native modal `<dialog>`: focus moves in, is contained, Escape closes it and
 * focus returns to the control that opened it.
 */
/**
 * An urgent alert (the visitor is called, a blocking device/offline problem) must never sit
 * behind the settings dialog: a native modal makes the rest of the page inert, so its live
 * regions and alerts would not be heard. Raising this event closes the dialog first.
 */
export const URGENT_EVENT = 'qb:urgent-alert';
export function raiseUrgentAlert(): void {
  window.dispatchEvent(new Event(URGENT_EVENT));
}

interface Ctx {
  prefs: A11yPrefs;
  support: CueSupport;
  open: (opener?: HTMLElement | null) => void;
}
const PrefsContext = createContext<Ctx>({
  prefs: { ...DEFAULT_PREFS },
  support: { vibration: false, sound: false },
  open: () => undefined,
});

export function useA11yPrefs(): Ctx {
  return useContext(PrefsContext);
}

export function A11yProvider({ children }: { children: ReactNode }): ReactElement {
  const [prefs, setPrefs] = useState<A11yPrefs>(() => loadPrefs());
  const [persisted, setPersisted] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const support = useMemo(() => detectCueSupport(), []);

  const update = useCallback((patch: Partial<A11yPrefs>): void => {
    setPrefs((current) => {
      const next = parsePrefs({ ...current, ...patch });
      applyPrefs(next);
      setPersisted(savePrefs(next));
      return next;
    });
  }, []);

  const reset = useCallback((): void => {
    clearPrefs();
    const next = { ...DEFAULT_PREFS };
    applyPrefs(next);
    setPrefs(next);
    setPersisted(true);
  }, []);

  // Another tab changed the preferences: follow it so every open tab looks the same
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== A11Y_KEY && e.key !== null) return;
      const next = loadPrefs();
      applyPrefs(next);
      setPrefs(next);
    };
    window.addEventListener('storage', onStorage);
    return (): void => window.removeEventListener('storage', onStorage);
  }, []);

  const open = useCallback((from?: HTMLElement | null): void => {
    opener.current = from ?? (document.activeElement as HTMLElement | null);
    setIsOpen(true);
  }, []);

  const close = useCallback((): void => {
    setIsOpen(false);
    const el = opener.current;
    opener.current = null;
    // Return focus to the opener once the dialog has released it
    queueMicrotask(() => {
      if (el && el.isConnected) el.focus();
    });
  }, []);

  // Urgent alerts close the dialog. Focus is NOT returned to the opener here: the alert that
  // caused it decides where focus goes (or leaves it, as the called banner never steals focus)
  useEffect(() => {
    const onUrgent = (): void => {
      opener.current = null;
      setIsOpen(false);
    };
    window.addEventListener(URGENT_EVENT, onUrgent);
    return (): void => window.removeEventListener(URGENT_EVENT, onUrgent);
  }, []);

  const value = useMemo(() => ({ prefs, support, open }), [prefs, support, open]);
  return (
    <PrefsContext.Provider value={value}>
      {children}
      {isOpen ? (
        <SettingsDialog
          prefs={prefs}
          support={support}
          persisted={persisted}
          update={update}
          reset={reset}
          onClose={close}
        />
      ) : null}
    </PrefsContext.Provider>
  );
}

const THEME_LABEL: Record<Theme, string> = {
  system: 'Follow my device setting',
  light: 'Light',
  dark: 'Dark',
};
const CONTRAST_LABEL: Record<Contrast, string> = {
  system: 'Follow my device setting',
  high: 'High contrast',
};
const TEXT_LABEL: Record<TextSize, string> = {
  normal: 'Normal (100%)',
  large: 'Large (125%)',
  xlarge: 'Extra large (150%)',
};
const MOTION_LABEL: Record<Motion, string> = {
  system: 'Follow my device setting',
  reduce: 'Reduce motion',
};

function SettingsDialog({
  prefs,
  support,
  persisted,
  update,
  reset,
  onClose,
}: {
  prefs: A11yPrefs;
  support: CueSupport;
  persisted: boolean;
  update: (patch: Partial<A11yPrefs>) => void;
  reset: () => void;
  onClose: () => void;
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState('');
  const [testBanner, setTestBanner] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // Close (Escape, the Close button, or unmount) always goes through onClose exactly once
    return (): void => {
      if (d?.open) d.close();
    };
  }, []);

  // Messages are written into a live region that already exists inside the modal (the rest of
  // the page is inert while it is open, so the app-wide region cannot be heard from here)
  const say = (text: string): void => {
    setMessage('');
    setTimeout(() => setMessage(text), 30);
  };

  const soundOff = prefs.quiet || !support.sound;
  const vibrationOff = prefs.quiet || !support.vibration;

  return (
    <dialog
      ref={ref}
      className="settings-dialog"
      aria-labelledby="settings-title"
      data-testid="display-settings"
      onClose={(e) => {
        // A `close` event is queued (fires later); if the dialog has been shown again since (React
        // StrictMode in development runs this effect's cleanup and setup twice), it is stale.
        if (!e.currentTarget.open) onClose();
      }}
      onKeyDown={(e) => {
        // Keep Tab inside the dialog in every browser: wrap from the last control to the first
        // (and back). A native modal already makes the page behind it inert; this stops focus
        // escaping to browser chrome or to a browser that handles it differently.
        if (e.key !== 'Tab') return;
        const d = ref.current;
        if (!d) return;
        const items = [
          ...d.querySelectorAll<HTMLElement>(
            'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ),
        ];
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="settings-body">
        <div className="settings-head">
          <h2 id="settings-title" tabIndex={-1} className="settings-title">
            Display and alerts
          </h2>
          <button type="button" className="btn btn-secondary" onClick={() => ref.current?.close()}>
            Close<span className="visually-hidden"> display and alerts settings</span>
          </button>
        </div>
        <p className="hint">
          These settings stay on this device. They are not sent anywhere and work without a
          connection.
        </p>
        {!persisted ? (
          <p role="status" className="alert alert-info" data-testid="settings-not-saved">
            This browser could not save your settings. They apply until you close this page.
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="pref-theme">Theme</label>
          <p id="pref-theme-hint" className="hint">
            Light or dark colours. High contrast below works with either.
          </p>
          <select
            id="pref-theme"
            aria-describedby="pref-theme-hint"
            value={prefs.theme}
            onChange={(e) => update({ theme: e.target.value as Theme })}
          >
            {(Object.keys(THEME_LABEL) as Theme[]).map((k) => (
              <option key={k} value={k}>
                {THEME_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pref-contrast">Contrast</label>
          <p id="pref-contrast-hint" className="hint">
            High contrast makes text and borders stronger.
          </p>
          <select
            id="pref-contrast"
            aria-describedby="pref-contrast-hint"
            value={prefs.contrast}
            onChange={(e) => update({ contrast: e.target.value as Contrast })}
          >
            {(Object.keys(CONTRAST_LABEL) as Contrast[]).map((k) => (
              <option key={k} value={k}>
                {CONTRAST_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pref-text">Text size</label>
          <p id="pref-text-hint" className="hint">
            Makes all text larger. The page rearranges itself instead of scrolling sideways.
          </p>
          <select
            id="pref-text"
            aria-describedby="pref-text-hint"
            value={prefs.textSize}
            onChange={(e) => update({ textSize: e.target.value as TextSize })}
          >
            {(Object.keys(TEXT_LABEL) as TextSize[]).map((k) => (
              <option key={k} value={k}>
                {TEXT_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pref-motion">Motion</label>
          <p id="pref-motion-hint" className="hint">
            Reduce motion removes animation and transitions everywhere.
          </p>
          <select
            id="pref-motion"
            aria-describedby="pref-motion-hint"
            value={prefs.motion}
            onChange={(e) => update({ motion: e.target.value as Motion })}
          >
            {(Object.keys(MOTION_LABEL) as Motion[]).map((k) => (
              <option key={k} value={k}>
                {MOTION_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <fieldset>
          <legend>Alerts</legend>
          <p className="hint">
            When it is your turn you always see a message on the ticket page. Sound and vibration
            are optional extras.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={prefs.quiet}
              onChange={(e) => update({ quiet: e.target.checked })}
            />{' '}
            Quiet mode: visual alerts only
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={prefs.sound && !soundOff}
              disabled={soundOff}
              aria-describedby="pref-sound-hint"
              onChange={(e) => update({ sound: e.target.checked })}
            />{' '}
            Play a short sound
          </label>
          <p id="pref-sound-hint" className="hint" data-testid="sound-hint">
            {!support.sound
              ? 'This device or browser cannot play alert sounds.'
              : prefs.quiet
                ? 'Off while quiet mode is on.'
                : 'Off by default. Plays once, never repeats.'}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={prefs.vibration && !vibrationOff}
              disabled={vibrationOff}
              aria-describedby="pref-vibration-hint"
              onChange={(e) => update({ vibration: e.target.checked })}
            />{' '}
            Vibrate
          </label>
          <p id="pref-vibration-hint" className="hint" data-testid="vibration-hint">
            {!support.vibration
              ? 'This device or browser does not support vibration.'
              : prefs.quiet
                ? 'Off while quiet mode is on.'
                : 'Only while this page is open and visible.'}
          </p>
          <p className="hint">
            Alerts can only be heard or felt while this page is open. They are never promised when
            it is closed.
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="test-alert"
              onClick={() => {
                const r = runTestAlert(prefs);
                setTestBanner(r.summary);
                say(r.summary);
              }}
            >
              Test alert
            </button>
          </div>
          {testBanner ? (
            <p className="alert alert-info" data-testid="test-alert-banner">
              <strong>Test.</strong> {testBanner}
            </p>
          ) : null}
        </fieldset>

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="reset-prefs"
            onClick={() => {
              reset();
              setTestBanner('');
              say('Display and alert settings reset to defaults.');
            }}
          >
            Reset to defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={() => ref.current?.close()}>
            Done
          </button>
        </div>
        <div
          role="status"
          aria-live="polite"
          className="visually-hidden"
          data-testid="settings-status"
        >
          {message}
        </div>
      </div>
    </dialog>
  );
}

/** The control that opens the dialog; used in the shared header and on the ticket page. */
export function DisplaySettingsButton({
  className = 'btn btn-secondary',
}: {
  className?: string;
}): ReactElement {
  const { open } = useA11yPrefs();
  return (
    <button
      type="button"
      className={className}
      aria-haspopup="dialog"
      data-testid="open-display-settings"
      onClick={(e) => open(e.currentTarget)}
    >
      Display and alerts
    </button>
  );
}
