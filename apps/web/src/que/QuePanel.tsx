import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { KbArticle, RouteId } from '@queuebridge/contracts';
import { SCREEN_NAMES, answer, buildPath, type NavigationContext } from '@queuebridge/assist';
import { useAuth } from '../auth.js';
import { useOffline } from '../offline/OfflineProvider.js';
import { matchQueRoute } from './routeContext.js';
import { SafeArticle } from './SafeArticle.js';
import { useFacilityHintFor } from './screenHint.js';
import { useQueKnowledge } from './useQueKnowledge.js';

/**
 * Ask Que panel (MQ.3; design §11.9; REQ-F13.1, F13.2, F13.3.3, F13.8).
 *
 * - Desktop: a non-modal dialog beside the page. Mobile (≤ 40rem): a full-height modal sheet.
 *   Escape or Close returns focus to the "Ask Que" button.
 * - Deterministic only (no AI layer in this build): search, "On this screen", article view
 *   and links. Every link comes from `buildPath`, i.e. the shared permission map applied to the
 *   session's server-derived roles at this facility; the API still authorizes every screen.
 * - Read-only: the only controls are search, open/close article, retry and navigation links.
 *   Nothing here sends a command.
 */

const SEARCH_ANNOUNCE_DELAY_MS = 500;

export function QuePanel({
  sheet,
  onClose,
}: {
  /** Full-height modal sheet (mobile) instead of the non-modal side panel. */
  sheet: boolean;
  onClose: () => void;
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const articleHeadingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const searchId = useId();
  const location = useLocation();
  const { user } = useAuth();
  const offline = useOffline();
  const online = offline.reachable;
  const k = useQueKnowledge(user?.id ?? null, online);
  const route = matchQueRoute(location.pathname);
  const hinted = useFacilityHintFor(location.pathname);
  const [query, setQuery] = useState('');
  const [openArticle, setOpenArticle] = useState<KbArticle | null>(null);
  const [live, setLive] = useState('');

  // Open as a non-modal panel or a modal sheet; closing always goes through onClose once
  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    if (!d.open) {
      if (sheet) d.showModal();
      else d.show();
    }
    searchRef.current?.focus();
    return (): void => {
      if (d.open) d.close();
    };
  }, [sheet]);

  const nav: NavigationContext = useMemo(
    () => ({
      grants: user?.roles ?? null,
      facilityId: route.facilityId ?? hinted,
      queueId: route.queueId,
      orgSlug: route.orgSlug,
      facilitySlug: route.facilitySlug,
    }),
    [user, route.facilityId, route.queueId, route.orgSlug, route.facilitySlug, hinted],
  );
  const pathFor = (id: RouteId): string | null => buildPath(id, nav);

  const result = useMemo(
    () =>
      answer(
        query,
        { ...nav, routeId: route.routeId, manifest: k.manifest },
        { kbVersion: k.kbVersion ?? 0, articles: k.articles },
      ),
    [query, nav, route.routeId, k.manifest, k.kbVersion, k.articles],
  );
  const byId = useMemo(() => new Map(k.articles.map((a) => [a.id, a])), [k.articles]);
  const cited = result.citations
    .map((id) => byId.get(id))
    .filter((a): a is KbArticle => a !== undefined);
  const [lead, ...notices] = result.text.split('\n');
  const asked = query.trim().length > 0;

  // An open article is closed when it is no longer readable (sign-out, role change, expiry)
  useEffect(() => {
    if (openArticle && !byId.has(openArticle.id)) setOpenArticle(null);
  }, [byId, openArticle]);

  // Result counts are announced politely, once typing pauses (announcement policy, 11.A3)
  useEffect(() => {
    if (k.publicState !== 'ready' || !asked) return undefined;
    const t = setTimeout(() => {
      setLive(
        cited.length === 0
          ? 'No help article matched. Try other words, or ask a member of staff.'
          : `${cited.length} help ${cited.length === 1 ? 'article' : 'articles'} found.`,
      );
    }, SEARCH_ANNOUNCE_DELAY_MS);
    return (): void => clearTimeout(t);
  }, [query, cited.length, asked, k.publicState]);

  useEffect(() => {
    if (openArticle) articleHeadingRef.current?.focus();
  }, [openArticle]);

  const afterNavigate = (): void => {
    // On a phone the sheet covers the page: close it so the new screen is visible
    if (sheet) ref.current?.close();
  };

  const sourceText =
    k.source === 'built_in' ? 'Built-in help (saved with this app)' : 'Built-in help';
  const restrictedNote = ((): string | null => {
    if (!user) return null;
    switch (k.restricted) {
      case 'valid':
        return 'Includes staff help for your roles.';
      case 'pending':
        return 'Checking your staff help…';
      case 'expired':
      case 'unverifiable':
      case 'missing':
        return online
          ? 'Staff help could not be confirmed for this session yet. Public help is shown.'
          : 'Staff help needs a connection to be confirmed again. Public help is shown.';
      default:
        return null;
    }
  })();

  return (
    <dialog
      ref={ref}
      className={sheet ? 'que-panel que-sheet' : 'que-panel'}
      aria-labelledby={titleId}
      data-testid="que-panel"
      data-mode={sheet ? 'sheet' : 'panel'}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // A modal sheet closes natively; the non-modal panel closes here
          if (!sheet) {
            e.preventDefault();
            ref.current?.close();
          }
          return;
        }
        if (!sheet || e.key !== 'Tab') return;
        const d = ref.current;
        if (!d) return;
        const items = [
          ...d.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
      <div className="que-body">
        <div className="que-head">
          <h2 id={titleId} className="que-title">
            Ask Que
          </h2>
          <button type="button" className="btn btn-secondary" onClick={() => ref.current?.close()}>
            Close<span className="visually-hidden"> Ask Que help</span>
          </button>
        </div>

        <p className="que-badges" data-testid="que-status">
          <span className="que-badge" data-testid="que-source">
            {sourceText}
          </span>
          {!online ? (
            <span className="que-badge que-badge-offline" data-testid="que-offline">
              Offline
            </span>
          ) : null}
          {k.kbVersion ? (
            <span className="que-badge" data-testid="que-version">
              Help version {k.kbVersion}
            </span>
          ) : null}
        </p>
        {restrictedNote ? (
          <p className="que-note" data-testid="que-access">
            {restrictedNote}
          </p>
        ) : null}
        {!online ? (
          <p className="que-note" data-testid="que-offline-note">
            You are offline. Features that depend on how this site is set up (such as push alerts)
            are described as they were when last checked.
          </p>
        ) : null}

        <form className="que-search" role="search" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor={searchId}>Search help</label>
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            value={query}
            autoComplete="off"
            maxLength={500}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpenArticle(null);
            }}
          />
        </form>
        <div role="status" aria-live="polite" className="visually-hidden" data-testid="que-live">
          {live}
        </div>

        {k.publicState === 'loading' && k.articles.length === 0 ? (
          <p className="que-note" data-testid="que-loading">
            Loading help…
          </p>
        ) : null}
        {k.publicState === 'failed' ? (
          <div className="alert alert-error" data-testid="que-failed">
            <p>Built-in help could not be loaded. Check your connection, then try again.</p>
            <button type="button" className="btn btn-secondary" onClick={k.reload}>
              Try again
            </button>
          </div>
        ) : null}

        {openArticle ? (
          <article className="que-article" data-testid="que-article">
            <h3 ref={articleHeadingRef} tabIndex={-1}>
              {openArticle.title}
            </h3>
            <SafeArticle body={openArticle.body} pathFor={pathFor} onNavigate={afterNavigate} />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setOpenArticle(null);
                searchRef.current?.focus();
              }}
            >
              Back to results
            </button>
          </article>
        ) : k.publicState !== 'loading' || k.articles.length > 0 ? (
          <section
            aria-label={asked ? 'Search results' : 'On this screen'}
            data-testid="que-results"
          >
            <h3>{asked ? 'Results' : 'On this screen'}</h3>
            {asked || cited.length > 0 ? (
              <p className="que-lead" data-testid="que-lead">
                {lead}
              </p>
            ) : (
              <p className="que-lead" data-testid="que-lead">
                No help is listed for this screen yet. Search above, or ask a member of staff.
              </p>
            )}
            {cited.length > 0 ? (
              <ul className="que-list">
                {cited.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="que-article-link"
                      data-article-id={a.id}
                      onClick={() => setOpenArticle(a)}
                    >
                      {a.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {notices.length > 0 ? (
              <ul className="que-notices" data-testid="que-notices">
                {notices.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
            {result.links.length > 0 ? (
              <>
                <h3>Go to</h3>
                <ul className="que-list" data-testid="que-links">
                  {result.links.map((id) => {
                    const path = pathFor(id);
                    return path ? (
                      <li key={id}>
                        <Link to={path} onClick={afterNavigate}>
                          {SCREEN_NAMES[id]
                            .replace(/^the /, '')
                            .replace(/^./, (c) => c.toUpperCase())}
                        </Link>
                      </li>
                    ) : null;
                  })}
                </ul>
              </>
            ) : null}
          </section>
        ) : null}

        <p className="que-footnote">
          Ask Que only explains and points to screens. It never changes a ticket, the queue or any
          setting.
        </p>
      </div>
    </dialog>
  );
}
