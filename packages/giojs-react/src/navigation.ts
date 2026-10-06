/**
 * packages/giojs-react/src/navigation.ts
 *
 * Client-side navigation machinery shared by GioLink: deployment-id version
 * skew detection, the bounded prefetch cache, fetch+swap content navigation
 * (after the next route's stylesheets have loaded), and the popstate handler that restores content on back/forward. All DOM
 * access is guarded so this module is safe to import during SSR.
 */

declare global {
  interface Window {
    __GIO_DEPLOYMENT_ID__?: string;
  }
}

export type TransitionPreset = 'fade' | 'slide-left' | 'slide-up' | 'scale';

let deploymentId: string | undefined;

export function initDeploymentId(): void {
  deploymentId = typeof window !== 'undefined' ? window.__GIO_DEPLOYMENT_ID__ : undefined;
}

export function getDeploymentId(): string | undefined {
  return deploymentId;
}

export function isHardReloadResponse(resp: Response): boolean {
  return resp.status === 409 && resp.headers.get('x-gio-action') === 'hard-reload';
}

/**
 * Only a 2xx page is swapped in. Anything else (a static host's 404.html
 * for a path that was never exported, a 500) is left to a full browser
 * load, which shows that page with its real status instead of swapping a
 * document without a #__gio boundary under the new URL.
 */
export function isSwappableResponse(resp: Response): boolean {
  return resp.status >= 200 && resp.status < 300;
}

export function handleHardReload(): void {
  window.location.reload();
}

export interface PrefetchCache {
  has(key: string): boolean;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const MAX_PREFETCH_ENTRIES = 50;

/**
 * Prefetch cache value for a URL whose response cannot be swapped in (a 404
 * or 500). Remembering it keeps every later hover from refetching the page;
 * a click on it goes straight to a full browser load, which fetches it fresh.
 */
export const PREFETCH_NOT_SWAPPABLE = '\0gio:not-swappable';

// Sentinel value '' marks an in-flight prefetch, PREFETCH_NOT_SWAPPABLE a
// page the browser must load itself; any other string is cached HTML.
function createPrefetchCache(maxEntries: number): PrefetchCache {
  const entries = new Map<string, string>();
  return {
    has(key: string): boolean {
      return entries.has(key);
    },
    get(key: string): string | undefined {
      return entries.get(key);
    },
    set(key: string, value: string): void {
      if (!entries.has(key) && entries.size >= maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) entries.delete(oldestKey);
      }
      entries.set(key, value);
    },
    delete(key: string): void {
      entries.delete(key);
    },
  };
}

export const prefetchCache: PrefetchCache = createPrefetchCache(MAX_PREFETCH_ENTRIES);

/**
 * Replace the #__gio subtree, its hydration envelope, and <title> with the
 * ones from `html`, then notify the hydration runtime (`gio:navigated`) so it
 * re-mounts React onto the swapped-in server HTML.
 */
function swapContent(html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const newContent = parsed.getElementById('__gio');
  const current = document.getElementById('__gio');
  if (newContent !== null && current !== null) {
    current.replaceWith(newContent);
  }
  const newProps = parsed.getElementById('__gio_props');
  const currentProps = document.getElementById('__gio_props');
  if (newProps !== null && currentProps !== null) {
    currentProps.replaceWith(newProps);
  } else if (currentProps !== null) {
    // New page has no envelope (unhydrated route): drop the stale one so the
    // runtime doesn't mount the previous route's tree over the new content.
    currentProps.remove();
  } else if (newProps !== null && newContent !== null) {
    newContent.after(newProps);
  }
  const newTitle = parsed.querySelector('title');
  if (newTitle !== null) document.title = newTitle.textContent ?? '';
  window.dispatchEvent(new Event('gio:navigated'));
}

/** How long a navigation waits for the next route's stylesheets before swapping anyway. */
export const STYLESHEET_WAIT_MS = 3000;

/**
 * Load the route stylesheets `html` links (React stylesheet resources -
 * `<link rel="stylesheet" data-precedence>` - hoisted into its <head>) that
 * this document does not have yet, and resolve once each has loaded or
 * failed (at most STYLESHEET_WAIT_MS), so the swapped-in route is never
 * shown unstyled. Inserted after the existing ones, keeping cascade order;
 * React adopts them by href when it renders the route.
 */
export function adoptStylesheets(html: string): Promise<void> {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const present = new Set(
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
      link => link.getAttribute('href'),
    ),
  );
  const pending: Promise<void>[] = [];
  for (const incoming of parsed.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-precedence]')) {
    const href = incoming.getAttribute('href');
    if (href === null || present.has(href)) continue;
    present.add(href);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-precedence', incoming.getAttribute('data-precedence') ?? 'default');
    pending.push(
      new Promise<void>(resolve => {
        link.addEventListener('load', () => resolve(), { once: true });
        link.addEventListener('error', () => resolve(), { once: true });
      }),
    );
    const last = [...document.head.querySelectorAll('link[rel="stylesheet"][data-precedence]')].at(-1);
    if (last !== undefined) last.after(link);
    else document.head.append(link);
  }
  if (pending.length === 0) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, STYLESHEET_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Fetch a page for client navigation. Returns null when the browser must
 * load the URL itself (deployment skew, or a response that cannot be swapped).
 */
async function fetchPageHtml(href: string): Promise<string | null> {
  const deployId = getDeploymentId();
  const fetchHeaders: Record<string, string> = { Accept: 'text/html' };
  if (deployId) fetchHeaders['x-deployment-id'] = deployId;
  const res = await fetch(href, { headers: fetchHeaders });
  if (isHardReloadResponse(res) || !isSwappableResponse(res)) {
    return null;
  }
  return res.text();
}

async function applyWithTransition(
  html: string,
  transition: TransitionPreset | false,
  seq: number,
): Promise<void> {
  if (transition !== false && typeof document.startViewTransition === 'function') {
    document.documentElement.setAttribute('data-gio-transition', transition);
    // The transition callback runs a frame later - re-check the sequence so a
    // navigation superseded in that window never swaps stale content in.
    const vt = document.startViewTransition(() => {
      if (isCurrentNavigation(seq)) swapContent(html);
    });
    await vt.finished;
    document.documentElement.removeAttribute('data-gio-transition');
  } else if (isCurrentNavigation(seq)) {
    swapContent(html);
  }
}

// Monotonic navigation sequence: each navigateTo/popstate claims the next
// number, and only the holder of the latest number may swap content or touch
// history. A slow response finishing after a newer navigation is discarded.
let navigationSeq = 0;

function beginNavigation(): number {
  navigationSeq += 1;
  return navigationSeq;
}

function isCurrentNavigation(seq: number): boolean {
  return seq === navigationSeq;
}

export async function navigateTo(
  href: string,
  transition: TransitionPreset | false,
): Promise<void> {
  const seq = beginNavigation();
  // Use completed prefetch if available; '' sentinel means still in-flight.
  const cached = prefetchCache.get(href);
  let html: string;

  if (cached === PREFETCH_NOT_SWAPPABLE) {
    // The prefetch saw a 404/500: the browser loads (and shows) it itself.
    window.location.href = href;
    return;
  }
  if (cached) {
    html = cached;
  } else {
    const fetched = await fetchPageHtml(href);
    if (!isCurrentNavigation(seq)) return;
    if (fetched === null) {
      // Deployment changed, or not a swappable page: let the browser load it.
      window.location.href = href;
      return;
    }
    html = fetched;
  }

  await adoptStylesheets(html);
  if (!isCurrentNavigation(seq)) return;
  await applyWithTransition(html, transition, seq);
  if (!isCurrentNavigation(seq)) return;
  history.pushState({ gio: true }, '', href);
}

let popstateRegistered = false;

/** Register the back/forward content-restore handler. Safe to call repeatedly. */
export function initPopstateHandler(): void {
  if (typeof window === 'undefined' || popstateRegistered) return;
  popstateRegistered = true;

  window.addEventListener('popstate', () => {
    const seq = beginNavigation();
    const path = window.location.pathname + window.location.search;
    fetchPageHtml(path)
      .then(html => {
        if (!isCurrentNavigation(seq)) return;
        if (html === null) {
          window.location.reload();
          return;
        }
        return adoptStylesheets(html).then(() => {
          if (isCurrentNavigation(seq)) swapContent(html);
        });
      })
      .catch(() => {
        if (isCurrentNavigation(seq)) window.location.reload();
      });
  });
}
