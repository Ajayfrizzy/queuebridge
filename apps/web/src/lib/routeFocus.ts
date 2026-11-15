import { useEffect, useRef, type RefObject } from 'react';

/** How long after a route change the page may take to render its heading (data loads). */
export const HEADING_WAIT_MS = 4000;

const APP_NAME = 'QueueBridge';

/** Document title for a page heading: "Heading — QueueBridge" (just the app name for no heading). */
export function titleFor(heading: string | null | undefined): string {
  const h = (heading ?? '').replace(/\s+/g, ' ').trim();
  return h && h !== APP_NAME ? `${h} — ${APP_NAME}` : APP_NAME;
}

/**
 * While set (a visitor's turn alert, M5.4), the document title says this instead of following
 * the heading, so a person in another tab sees it. Cleared, the title follows the heading again.
 */
let urgentTitle: string | null = null;
export function setUrgentTitle(title: string | null): void {
  urgentTitle = title;
  document.title = title ?? titleFor(document.querySelector('#main h1')?.textContent);
}
const pageTitle = (heading: string | null | undefined): string => urgentTitle ?? titleFor(heading);

/**
 * Route-change focus (REQ-F7.11; design §16.3).
 *
 * After client-side navigation, focus moves to the new page's `h1` (made programmatically
 * focusable) and the document title follows it, so keyboard and screen-reader users start at the
 * top of the new content. Many pages render their heading only after their data arrives, so
 * focus first goes to `<main>` (never leave it on a control that no longer exists) and moves to
 * the `h1` as soon as one appears, but ONLY if the person has not moved focus themselves in the
 * meantime. The heading itself is what a screen reader reads; no second live announcement is
 * made, so the title is heard once.
 *
 * The first load is left alone: the browser and the skip link already handle it.
 */
export function useRouteFocus(main: RefObject<HTMLElement | null>, pathname: string): void {
  // The path this hook last handled; the first value is the page the browser loaded
  const handled = useRef(pathname);
  useEffect(() => {
    const el = main.current;
    if (!el) return undefined;
    // Initial page load: do not steal focus, but still set the title
    const isFirst = handled.current === pathname;
    handled.current = pathname;

    const heading = (): HTMLElement | null => el.querySelector<HTMLElement>('h1');
    const settle = (h: HTMLElement | null): void => {
      document.title = pageTitle(h?.textContent);
    };
    settle(heading());
    if (isFirst) return undefined;

    el.focus({ preventScroll: true });
    const focusHeading = (h: HTMLElement): boolean => {
      const active = document.activeElement;
      // Only take focus if it is still where this navigation left it
      if (active && active !== document.body && active !== el && !h.contains(active)) return false;
      if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: false });
      settle(h);
      return true;
    };

    const now = heading();
    if (now) {
      focusHeading(now);
      return undefined;
    }
    let done = false;
    const observer = new MutationObserver(() => {
      const h = heading();
      if (!h || done) return;
      done = true;
      observer.disconnect();
      focusHeading(h);
    });
    observer.observe(el, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), HEADING_WAIT_MS);
    return (): void => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [main, pathname]);

  // Keep the title right when a page's own heading text changes (for example after loading)
  useEffect(() => {
    const el = main.current;
    if (!el) return undefined;
    const observer = new MutationObserver(() => {
      const h = el.querySelector('h1');
      if (h) document.title = pageTitle(h.textContent);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return (): void => observer.disconnect();
  }, [main, pathname]);
}
