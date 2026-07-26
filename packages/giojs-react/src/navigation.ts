/**
 * packages/giojs-react/src/navigation.ts
 *
 * Client-side navigation machinery shared by GioLink: deployment-id version
 * skew detection, the bounded prefetch cache, fetch+swap content navigation,
 * and the popstate handler that restores content on back/forward. All DOM
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

// Sentinel value '' marks an in-flight prefetch; non-empty string is cached HTML.
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

/** Fetch a page for client navigation. Returns null when a hard reload was triggered. */
async function fetchPageHtml(href: string): Promise<string | null> {
  const deployId = getDeploymentId();
  const fetchHeaders: Record<string, string> = { Accept: 'text/html' };
  if (deployId) fetchHeaders['x-gio-deployment-id'] = deployId;
  const res = await fetch(href, { headers: fetchHeaders });
  if (isHardReloadResponse(res)) {
    return null;
  }
  return res.text();
}

async function applyWithTransition(
  html: string,
  transition: TransitionPreset | false,
): Promise<void> {
  if (transition !== false && typeof document.startViewTransition === 'function') {
    document.documentElement.setAttribute('data-gio-transition', transition);
    const vt = document.startViewTransition(() => swapContent(html));
    await vt.finished;
    document.documentElement.removeAttribute('data-gio-transition');
  } else {
    swapContent(html);
  }
}

export async function navigateTo(
  href: string,
  transition: TransitionPreset | false,
): Promise<void> {
  // Use completed prefetch if available; '' sentinel means still in-flight.
  const cached = prefetchCache.get(href);
  let html: string;

  if (cached) {
    html = cached;
  } else {
    const fetched = await fetchPageHtml(href);
    if (fetched === null) {
      // Deployment changed - navigate to the new URL with a fresh load.
      window.location.href = href;
      return;
    }
    html = fetched;
  }

  await applyWithTransition(html, transition);
  history.pushState({ gio: true }, '', href);
}

let popstateRegistered = false;

/** Register the back/forward content-restore handler. Safe to call repeatedly. */
export function initPopstateHandler(): void {
  if (typeof window === 'undefined' || popstateRegistered) return;
  popstateRegistered = true;

  window.addEventListener('popstate', () => {
    const path = window.location.pathname + window.location.search;
    fetchPageHtml(path)
      .then(html => {
        if (html === null) {
          window.location.reload();
          return;
        }
        swapContent(html);
      })
      .catch(() => window.location.reload());
  });
}
