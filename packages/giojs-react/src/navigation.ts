/**
 * packages/giojs-react/src/navigation.ts
 *
 * The client-side router behind GioLink and useRouter(): soft navigation
 * (fetch the next page's HTML and render it through the client runtime's
 * persistent React root), the prefetch cache, history entries with their
 * scroll positions, and the accessibility follow-up of every soft
 * navigation (focus, route announcement). Deployment-id version skew
 * detection lives here too. All DOM access is guarded so this module is
 * safe to import during SSR.
 *
 * A response is rendered in place only when it is a GioJS page: HTML with
 * the #__gio boundary (and, when present, a well-formed envelope). Anything
 * else - a static host's 404.html, a 503 from the Rust server, JSON, a
 * network error - is handed to the browser as a full page load, so it shows
 * with its real status instead of being swapped in under the new URL.
 */

declare global {
  interface Window {
    __GIO_DEPLOYMENT_ID__?: string;
  }
}

export type TransitionPreset = 'fade' | 'slide-left' | 'slide-up' | 'scale';

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean | undefined;
  /**
   * Scroll to the top of the new page - or to the element the URL's #hash
   * names - after navigating. Default true; false keeps the scroll position.
   */
  scroll?: boolean | undefined;
  /** View transition preset for the swap (document.startViewTransition). */
  transition?: TransitionPreset | false | undefined;
}

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

// ── fetching pages ────────────────────────────────────────────────────────────

/** A fetched page, judged. `url` is the same-origin path + query it came from. */
export type PageResult =
  | { kind: 'page'; html: string; url: string }
  /** Not a GioJS page (or unreachable): the browser loads `url` itself. */
  | { kind: 'load'; url: string }
  /** Deployment skew (409 hard-reload): the browser must load the new build. */
  | { kind: 'reload' };

type FetchPurpose = 'navigate' | 'prefetch' | 'refresh';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `url` as a same-origin http(s) URL, or null. */
function sameOriginUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
}

function isHtml(res: Response): boolean {
  return /^\s*text\/html\b/i.test(res.headers.get('content-type') ?? '');
}

/** Never rejects: every failure becomes a full load of `url`. */
async function fetchPage(url: string, purpose: FetchPurpose): Promise<PageResult> {
  const headers: Record<string, string> = { Accept: 'text/html' };
  if (purpose === 'prefetch') {
    headers['Purpose'] = 'prefetch';
    headers['Sec-Purpose'] = 'prefetch';
  }
  const id = getDeploymentId();
  if (id) headers['x-deployment-id'] = id;
  try {
    const res = await fetch(url, {
      headers,
      // refresh() must not be answered from the browser's HTTP cache.
      ...(purpose === 'refresh' ? { cache: 'no-cache' as const } : {}),
    });
    if (isHardReloadResponse(res)) return { kind: 'reload' };
    // After redirects res.url is where the page really lives: history and
    // the navigation context must name it, not the link's href.
    let finalUrl = url;
    if (res.url) {
      const landed = sameOriginUrl(res.url);
      if (landed === null) return { kind: 'load', url: res.url };
      finalUrl = landed.pathname + landed.search;
    }
    if (!isHtml(res)) return { kind: 'load', url: finalUrl };
    const html = await res.text();
    // 404/500 pages rendered by GioJS carry the boundary and soft-navigate
    // like any page; a static host's 404.html or Rust's 503 page do not.
    if (!html.includes('id="__gio"')) return { kind: 'load', url: finalUrl };
    return { kind: 'page', html, url: finalUrl };
  } catch {
    return { kind: 'load', url };
  }
}

// ── prefetch cache ────────────────────────────────────────────────────────────

/**
 * How long a prefetched page may be used. Older entries are refetched: a
 * page prefetched on hover minutes ago may have changed since.
 */
export const PREFETCH_TTL_MS = 30_000;

const MAX_PREFETCH_ENTRIES = 50;

interface PrefetchEntry {
  at: number;
  generation: number;
  result: Promise<PageResult>;
}

const prefetchEntries = new Map<string, PrefetchEntry>();
// Bumped by every invalidation: an entry from an older generation - even one
// still in flight when a mutation started - is never used.
let cacheGeneration = 0;

/** A usable entry for `url` (fresh, current generation), or undefined. */
function cachedPage(url: string): PrefetchEntry | undefined {
  const entry = prefetchEntries.get(url);
  if (entry === undefined) return undefined;
  if (entry.generation !== cacheGeneration || Date.now() - entry.at > PREFETCH_TTL_MS) {
    prefetchEntries.delete(url);
    return undefined;
  }
  return entry;
}

function storePrefetch(url: string, entry: PrefetchEntry): void {
  prefetchEntries.delete(url);
  if (prefetchEntries.size >= MAX_PREFETCH_ENTRIES) {
    const oldest = prefetchEntries.keys().next().value;
    if (oldest !== undefined) prefetchEntries.delete(oldest);
  }
  prefetchEntries.set(url, entry);
}

/** Drop every prefetched page (refresh(), and after any same-origin mutation). */
export function invalidatePrefetchCache(): void {
  cacheGeneration += 1;
  prefetchEntries.clear();
}

/**
 * Fetch `href` into the prefetch cache (GioLink hover/viewport, and
 * router.prefetch). A failed or non-GioJS response is remembered too, so
 * hovering it again does not refetch it and a click goes straight to a full
 * load. No-op on the server and for other origins.
 */
export function prefetch(href: string): void {
  if (typeof window === 'undefined') return;
  const target = sameOriginUrl(href);
  if (target === null) return;
  const url = target.pathname + target.search;
  if (url === currentPageUrl() || cachedPage(url) !== undefined) return;
  ensureRouter();
  const result = fetchPage(url, 'prefetch').then(page => {
    if (page.kind === 'reload') {
      prefetchEntries.delete(url);
      handleHardReload();
    }
    return page;
  });
  storePrefetch(url, { at: Date.now(), generation: cacheGeneration, result });
}

/**
 * Non-GET requests to this origin are mutations: a page prefetched before
 * one may already be stale. Invalidated when the request starts and again
 * when it settles (a prefetch racing it must not survive either).
 */
function trackMutations(): void {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== 'function') return;
  globalThis.fetch = function gioTrackedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (!isSameOriginMutation(input, init)) return nativeFetch(input, init);
    invalidatePrefetchCache();
    return nativeFetch(input, init).finally(invalidatePrefetchCache);
  };
}

function isSameOriginMutation(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const url = isRequest ? input.url : input instanceof URL ? input.href : String(input);
  return sameOriginUrl(url) !== null;
}

// ── history and scroll ────────────────────────────────────────────────────────

/** Our slice of `history.state`; the rest of the object is left alone. */
interface EntryState {
  key: string;
  scroll?: [number, number];
}

const STATE_KEY = '__gio';

function entryState(state: unknown): EntryState | null {
  if (!isRecord(state)) return null;
  const ours = state[STATE_KEY];
  if (!isRecord(ours) || typeof ours['key'] !== 'string') return null;
  const scroll = ours['scroll'];
  if (Array.isArray(scroll) && typeof scroll[0] === 'number' && typeof scroll[1] === 'number') {
    return { key: ours['key'], scroll: [scroll[0], scroll[1]] };
  }
  return { key: ours['key'] };
}

/**
 * Record `entry` in the current history entry, keeping the app's own state
 * beside it. A non-object state set by someone else is left untouched (the
 * in-memory positions still cover this document).
 */
function writeEntryState(entry: EntryState): void {
  const state: unknown = history.state;
  if (state !== null && state !== undefined && !isRecord(state)) return;
  history.replaceState({ ...(state ?? {}), [STATE_KEY]: entry }, '');
}

let keyCounter = 0;
function newEntryKey(): string {
  keyCounter += 1;
  return `${Date.now().toString(36)}-${keyCounter}`;
}

let routerActive = false;
let currentKey: string | null = null;
// The path + query the page on screen was rendered for: a popstate to the
// same one is a hash-only traversal, nothing to fetch.
let renderedUrl: string | null = null;
// Back/forward cannot write the entry being left, so positions also live here.
const scrollPositions = new Map<string, [number, number]>();

function currentPageUrl(): string {
  return window.location.pathname + window.location.search;
}

function setScrollRestoration(mode: 'auto' | 'manual'): void {
  try {
    history.scrollRestoration = mode;
  } catch {
    // Not supported: the browser keeps restoring on its own.
  }
}

/**
 * Activate the router: back/forward handling, manual scroll restoration
 * (positions are restored once the previous page has rendered, not when the
 * URL changes), mutation tracking and the route announcer. Safe to call
 * repeatedly.
 */
function ensureRouter(): void {
  if (routerActive || typeof window === 'undefined') return;
  routerActive = true;
  renderedUrl = window.location.pathname + window.location.search;
  const existing = entryState(history.state);
  currentKey = existing?.key ?? newEntryKey();
  if (existing === null) writeEntryState({ key: currentKey });
  setScrollRestoration('manual');
  window.addEventListener('popstate', onPopState);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  trackMutations();
  // The live region must exist before its first message, or screen readers
  // may not announce it.
  announcer();
}

function saveScroll(): void {
  if (currentKey === null) return;
  const scroll: [number, number] = [window.scrollX, window.scrollY];
  scrollPositions.set(currentKey, scroll);
  writeEntryState({ key: currentKey, scroll });
}

/** Leaving the document: the browser restores this entry itself if it comes back. */
function onPageHide(): void {
  saveScroll();
  setScrollRestoration('auto');
}

function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted) setScrollRestoration('manual');
}

/** A plain `<a href="#x">` made a state-less entry: give it a key. */
function onHashChange(): void {
  if (entryState(history.state) !== null) return;
  currentKey = newEntryKey();
  writeEntryState({ key: currentKey });
}

/**
 * A soft navigation from an earlier document of this tab left other entries
 * in manual mode; coming back to one of them with a full load, restore its
 * saved position the way the browser would have.
 */
function restoreCrossDocumentScroll(): void {
  try {
    if (history.scrollRestoration !== 'manual') return;
    const saved = entryState(history.state)?.scroll;
    if (saved === undefined) return;
    const apply = (): void => scrollToPosition(saved[0], saved[1]);
    if (document.readyState === 'complete') apply();
    else window.addEventListener('load', apply, { once: true });
  } catch {
    // history unavailable (sandboxed frame): nothing to restore.
  }
}

if (typeof window !== 'undefined') restoreCrossDocumentScroll();

function scrollToPosition(x: number, y: number): void {
  // Skipping no-op scrolls also keeps environments without layout quiet.
  if (window.scrollX === x && window.scrollY === y) return;
  window.scrollTo(x, y);
}

/** Scroll to the element `hash` names; false when there is none. */
function scrollToHash(hash: string): boolean {
  let id = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    id = decodeURIComponent(id);
  } catch {
    // Malformed escape: look the raw fragment up.
  }
  if (id === '') return false;
  const target = document.getElementById(id) ?? document.getElementsByName(id)[0];
  if (target === undefined || target === null) {
    if (id.toLowerCase() !== 'top') return false;
    scrollToPosition(0, 0);
    return true;
  }
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView();
  return true;
}

function scrollAfterPush(hash: string): void {
  if (hash !== '' && scrollToHash(hash)) return;
  scrollToPosition(0, 0);
}

function restoreScroll(key: string, saved: [number, number] | undefined): void {
  const position = scrollPositions.get(key) ?? saved;
  if (position !== undefined) {
    scrollToPosition(position[0], position[1]);
    return;
  }
  scrollAfterPush(window.location.hash);
}

// ── accessibility ─────────────────────────────────────────────────────────────

const ANNOUNCER_ID = '__gio-route-announcer';

/** The visually hidden live region (outside #__gio, so React never owns it). */
function announcer(): HTMLElement {
  const existing = document.getElementById(ANNOUNCER_ID);
  if (existing !== null) return existing;
  const region = document.createElement('div');
  region.id = ANNOUNCER_ID;
  region.setAttribute('aria-live', 'assertive');
  region.setAttribute('aria-atomic', 'true');
  // CSSOM writes, not a style attribute: allowed under a strict CSP.
  Object.assign(region.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: '0',
  });
  document.body.appendChild(region);
  return region;
}

/**
 * After a soft navigation: move focus to the new page (its <main>, else the
 * #__gio boundary) so keyboard and screen-reader users start there instead
 * of on a link that may no longer exist, and announce the new title. A page
 * that focused something itself (autoFocus) keeps it.
 */
function focusAndAnnounce(focusedBefore: Element | null): void {
  const boundary = document.getElementById('__gio');
  const active = document.activeElement;
  const pageTookFocus =
    active !== null && active !== document.body && active !== focusedBefore && boundary?.contains(active);
  if (!pageTookFocus) {
    const target = boundary?.querySelector('main') ?? document.querySelector('main') ?? boundary;
    if (target instanceof HTMLElement) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  }
  const heading = (boundary?.querySelector('h1') ?? document.querySelector('h1'))?.textContent?.trim() ?? '';
  announcer().textContent = document.title || heading || window.location.pathname;
}

// ── rendering a page ──────────────────────────────────────────────────────────

/** window.__GIO_RUNTIME__, published by @gio.js/core's client-runtime.ts. */
interface ClientRuntime {
  prepare(entry: string, pattern: string): Promise<void>;
  commit(content: Element | null): void;
}

function clientRuntime(): ClientRuntime | undefined {
  return (window as unknown as { __GIO_RUNTIME__?: ClientRuntime }).__GIO_RUNTIME__;
}

interface ParsedPage {
  doc: Document;
  content: Element;
  envelopeScript: Element | null;
  /** The route chunk to load ('' for a page that does not hydrate). */
  entry: string;
  pattern: string;
}

/** The page's parts, or null when it is not a renderable GioJS page. */
function parsePage(html: string): ParsedPage | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const content = doc.getElementById('__gio');
  if (content === null) return null;
  const envelopeScript = doc.getElementById('__gio_props');
  if (envelopeScript === null) return { doc, content, envelopeScript, entry: '', pattern: '' };
  try {
    const envelope: unknown = JSON.parse(envelopeScript.textContent ?? '');
    if (!isRecord(envelope) || typeof envelope['path'] !== 'string' || typeof envelope['pattern'] !== 'string') {
      return null;
    }
    const entry = typeof envelope['entry'] === 'string' ? envelope['entry'] : '';
    // The chunk is imported by URL: only ever a same-origin path.
    if (entry !== '' && (!entry.startsWith('/') || entry.startsWith('//'))) return null;
    return { doc, content, envelopeScript, entry, pattern: envelope['pattern'] };
  } catch {
    return null;
  }
}

/** The envelope, title and lang of the new page; #__gio is the runtime's. */
function swapDocumentParts(page: ParsedPage): void {
  const currentScript = document.getElementById('__gio_props');
  if (page.envelopeScript !== null) {
    const script = document.importNode(page.envelopeScript, true);
    if (currentScript !== null) currentScript.replaceWith(script);
    else document.getElementById('__gio')?.after(script);
  } else {
    // Server-only page: a stale envelope would re-render the previous route.
    currentScript?.remove();
  }
  const title = page.doc.querySelector('title');
  if (title !== null) document.title = title.textContent ?? '';
  // Rust sets <html lang> per request locale; a LocaleLink may change it.
  const lang = page.doc.documentElement.getAttribute('lang');
  if (lang !== null) document.documentElement.setAttribute('lang', lang);
  else document.documentElement.removeAttribute('lang');
}

type HistoryMode = 'push' | 'replace' | 'pop' | 'refresh';

function updateHistory(mode: HistoryMode, url: string): void {
  if (mode === 'push') {
    saveScroll();
    currentKey = newEntryKey();
    history.pushState({ [STATE_KEY]: { key: currentKey } }, '', url);
  } else if (mode === 'replace') {
    currentKey = newEntryKey();
    history.replaceState({ [STATE_KEY]: { key: currentKey } }, '', url);
  } else if (url !== window.location.pathname + window.location.search + window.location.hash) {
    // Back/forward or refresh landed somewhere else (a redirect).
    history.replaceState(history.state, '', url);
  }
}

// Monotonic navigation sequence: each navigation claims the next number, and
// only the holder of the latest number may render or touch history. A slow
// response finishing after a newer navigation is discarded.
let navigationSeq = 0;

function beginNavigation(): number {
  navigationSeq += 1;
  return navigationSeq;
}

function isCurrentNavigation(seq: number): boolean {
  return seq === navigationSeq;
}

/**
 * Render `page` at `url` (path + query + hash). Resolves false when a newer
 * navigation superseded it; throws when the page cannot be shown in place.
 */
async function showPage(
  page: ParsedPage,
  url: string,
  mode: HistoryMode,
  transition: TransitionPreset | false,
  seq: number,
): Promise<boolean> {
  if (page.entry !== '') {
    // The route chunk loads before anything changes on screen. Without a
    // runtime yet (the current page does not hydrate), importing the chunk
    // brings it in.
    if (clientRuntime() === undefined) await import(page.entry);
    await clientRuntime()?.prepare(page.entry, page.pattern);
  }
  if (!isCurrentNavigation(seq)) return false;

  let committed = false;
  const commit = (): void => {
    // A view transition runs this a frame later: re-check.
    if (!isCurrentNavigation(seq)) return;
    updateHistory(mode, url);
    swapDocumentParts(page);
    const runtime = clientRuntime();
    if (runtime !== undefined) {
      runtime.commit(page.content);
    } else {
      document.getElementById('__gio')?.replaceWith(document.importNode(page.content, true));
    }
    renderedUrl = window.location.pathname + window.location.search;
    committed = true;
  };

  if (transition !== false && typeof document.startViewTransition === 'function') {
    document.documentElement.setAttribute('data-gio-transition', transition);
    const vt = document.startViewTransition(commit);
    vt.finished
      .finally(() => document.documentElement.removeAttribute('data-gio-transition'))
      .catch(() => undefined);
    await vt.updateCallbackDone;
  } else {
    commit();
  }
  if (!committed || !isCurrentNavigation(seq)) return false;
  // Listeners (analytics, legacy runtimes) learn the page changed.
  window.dispatchEvent(new Event('gio:navigated'));
  return true;
}

/** Hand `url` to the browser: a full page load. */
function hardNavigate(url: string, replace: boolean): void {
  if (replace) window.location.replace(url);
  else window.location.assign(url);
}

/**
 * Soft-navigate to `href`: fetch the page (or use a fresh prefetch), render
 * it in place, update history, then scroll and move focus. Same-page hash
 * links only scroll. Other origins, and responses that are not GioJS pages,
 * become full page loads. No-op on the server.
 */
export async function navigate(href: string, options: NavigateOptions = {}): Promise<void> {
  if (typeof window === 'undefined') return;
  const target = sameOriginUrl(href);
  if (target === null) {
    let parsed: URL;
    try {
      parsed = new URL(href, window.location.href);
    } catch {
      throw new TypeError(`navigate: invalid URL ${JSON.stringify(href)}`);
    }
    // Never script URLs: router.push(userInput) must not become an XSS sink.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError(`navigate: refusing to navigate to a ${parsed.protocol} URL`);
    }
    hardNavigate(parsed.href, options.replace === true);
    return;
  }
  ensureRouter();
  const path = target.pathname + target.search;
  const scroll = options.scroll !== false;

  if (path === currentPageUrl() && target.hash !== '') {
    // Same page, new fragment: no fetch, just a history entry and a scroll.
    beginNavigation();
    updateHistory(options.replace === true ? 'replace' : 'push', path + target.hash);
    if (scroll) scrollAfterPush(target.hash);
    return;
  }

  // A link to the URL already shown replaces its entry, as browsers do.
  const replace = options.replace === true || target.href === window.location.href;
  const seq = beginNavigation();
  const result = (await cachedPage(path)?.result) ?? (await fetchPage(path, 'navigate'));
  if (!isCurrentNavigation(seq)) return;
  if (result.kind === 'reload') {
    // The deployment changed: load the new build's page.
    hardNavigate(target.href, replace);
    return;
  }
  if (result.kind === 'load') {
    hardNavigate(result.url + target.hash, replace);
    return;
  }
  const page = parsePage(result.html);
  const url = result.url + target.hash;
  if (page === null) {
    hardNavigate(url, replace);
    return;
  }
  const focusedBefore = document.activeElement;
  let shown: boolean;
  try {
    shown = await showPage(page, url, replace ? 'replace' : 'push', options.transition ?? false, seq);
  } catch {
    if (isCurrentNavigation(seq)) hardNavigate(url, replace);
    return;
  }
  if (!shown) return;
  if (scroll) scrollAfterPush(target.hash);
  focusAndAnnounce(focusedBefore);
}

/**
 * Re-fetch the current page - bypassing (and clearing) the prefetch cache -
 * and render it in place: same URL, same scroll position, layout and page
 * state kept, fresh props.
 */
export async function refresh(): Promise<void> {
  if (typeof window === 'undefined') return;
  ensureRouter();
  invalidatePrefetchCache();
  const seq = beginNavigation();
  const result = await fetchPage(window.location.pathname + window.location.search, 'refresh');
  if (!isCurrentNavigation(seq)) return;
  const page = result.kind === 'page' ? parsePage(result.html) : null;
  if (result.kind !== 'page' || page === null) {
    window.location.reload();
    return;
  }
  try {
    await showPage(page, result.url + window.location.hash, 'refresh', false, seq);
  } catch {
    if (isCurrentNavigation(seq)) window.location.reload();
  }
}

/** history.back() / forward(), with the router handling the traversal. */
export function back(): void {
  if (typeof window === 'undefined') return;
  ensureRouter();
  history.back();
}

export function forward(): void {
  if (typeof window === 'undefined') return;
  ensureRouter();
  history.forward();
}

function onPopState(event: PopStateEvent): void {
  // The scroll position still belongs to the page being left.
  if (currentKey !== null) scrollPositions.set(currentKey, [window.scrollX, window.scrollY]);
  const state = entryState(event.state);
  const key = state?.key ?? newEntryKey();
  if (state === null) writeEntryState({ key });
  currentKey = key;
  const url = window.location.pathname + window.location.search;
  const seq = beginNavigation();
  if (url === renderedUrl) {
    // Only the fragment changed.
    restoreScroll(key, state?.scroll);
    return;
  }
  void traverse(url, key, state?.scroll, seq);
}

async function traverse(
  url: string,
  key: string,
  saved: [number, number] | undefined,
  seq: number,
): Promise<void> {
  const result = (await cachedPage(url)?.result) ?? (await fetchPage(url, 'navigate'));
  if (!isCurrentNavigation(seq)) return;
  const page = result.kind === 'page' ? parsePage(result.html) : null;
  if (result.kind !== 'page' || page === null) {
    // Already at the URL: the browser loads it in place.
    window.location.reload();
    return;
  }
  const focusedBefore = document.activeElement;
  try {
    if (!(await showPage(page, result.url + window.location.hash, 'pop', false, seq))) return;
  } catch {
    if (isCurrentNavigation(seq)) window.location.reload();
    return;
  }
  restoreScroll(key, saved);
  focusAndAnnounce(focusedBefore);
}
