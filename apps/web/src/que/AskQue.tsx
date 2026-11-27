import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { api } from '../lib/api.js';
import { Icon } from '@queuebridge/ui';
import type { QuePanel as QuePanelType } from './QuePanel.js';

/**
 * The persistent "Ask Que" button in the page shell (MQ.3; design §11.9; since M7.2 a floating
 * launcher at the bottom right, after the page in tab order). It is shown on every
 * screen for every role, including anonymous visitors. The panel code is loaded only when first
 * opened (a separate chunk, precached by the service worker for offline use), so visitor pages
 * stay light. If that chunk cannot load, a plain message is shown and the page keeps working.
 */
type PanelComponent = typeof QuePanelType;
/**
 * A fresh lazy component per attempt: `React.lazy` keeps a rejected import, so after a failed
 * load (for example offline before the chunk was cached) the next open must start a new one.
 */
const makePanel = (): LazyExoticComponent<PanelComponent> =>
  lazy(() => import('./QuePanel.js').then((m) => ({ default: m.QuePanel })));

const SHEET_QUERY = '(max-width: 40rem)';
/** Delay before the one-off offline warm-up, so it never competes with the page's own requests. */
export const QUE_WARMUP_DELAY_MS = 2000;

class PanelBoundary extends Component<
  { onClose: () => void; onFailed: () => void; children: ReactNode },
  { failed: boolean }
> {
  public override state = { failed: false };
  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  public override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Shown below; the next open retries with a fresh import (no network calls from here)
    this.props.onFailed();
  }
  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="alert alert-error que-chunk-error" data-testid="que-unavailable">
        <p>Help could not be opened. Check your connection and try again.</p>
        <button type="button" className="btn btn-secondary" onClick={this.props.onClose}>
          Close
        </button>
      </div>
    );
  }
}

export function AskQueButton(): ReactElement {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [Panel, setPanel] = useState(makePanel);
  const trigger = useRef<HTMLButtonElement>(null);
  // Offline readiness (design §11.5, decision D1): fetch the public help bundle and the server
  // capability manifest once per load while online, so the service worker holds both before
  // connectivity is lost. Without a manifest every capability counts as unavailable offline.
  // Two public GETs; results are not used here and failures are ignored.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return undefined;
    const t = setTimeout(() => {
      void api.queCapabilities().catch(() => undefined);
      void api.quePublicKb().catch(() => undefined);
    }, QUE_WARMUP_DELAY_MS);
    return (): void => clearTimeout(t);
  }, []);
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="que-launcher"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="ask-que"
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setSheet(window.matchMedia?.(SHEET_QUERY).matches ?? false);
          setOpen(true);
        }}
      >
        <Icon name="help" className="que-launcher-icon" />
        <span>Ask Que</span>
      </button>
      {open ? (
        <PanelBoundary onClose={close} onFailed={() => setPanel(makePanel)}>
          <Suspense
            fallback={
              <p role="status" className="que-loading-chunk">
                Opening help…
              </p>
            }
          >
            <Panel sheet={sheet} onClose={close} />
          </Suspense>
        </PanelBoundary>
      ) : null}
    </>
  );
}
