/**
 * packages/giojs-react/src/navigation.ts
 *
 * The client-side router behind GioLink and useRouter(): soft navigation
 * (fetch the next page's HTML and render it through the client runtime's
 * persistent React root, once the next route's stylesheets have loaded), the
 * prefetch cache, history entries with their scroll positions, and the accessibility follow-up of a soft navigation to
 * another page (focus, route announcement). Deployment-id version skew
 * detection lives here too. GioForm submissions render their answer through
 * the same path (submitForm). All DOM access is guarded so this module is
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

/** Snapshot the deployment id the server injected into this document. */
export function initDeploymentId(): void {
  deploymentId = typeof window !== 'undefined' ? window.__GIO_DEPLOYMENT_ID__ : undefined;
}

/**
 * The deployment that served this document: the id the Rust server injects
 * as window.__GIO_DEPLOYMENT_ID__ (read on first use - nothing has to call
 * initDeploymentId). Every page request the router makes carries it as
 * x-deployment-id, and a server running another build answers 409
 * hard-reload. Soft navigations never run the fetched page's scripts, so the
 * value keeps naming the build whose code is running in this tab.
 */
export function getDeploymentId(): string | undefined {
  if (deploymentId === undefined) initDeploymentId();
  return deploymentId;
}

export function isHardReloadResponse(resp: Response): boolean {
  return resp.status === 409 && resp.headers.get('x-gio-action') === 'hard-reload';
}

/** Reload the tab onto the server's build. A no-op on the server, like the rest of this module. */
export function handleHardReload(): void {
  if (typeof window === 'undefined') return;
  window.location.reload();
}

// ── fetching pages ────────────────────────────────────────────────────────────

/**
 * A fetched page, judged. `url` is the same-origin path + query it came
 * from. `transient` marks an answer the next request may not get again - a
 * network error or a non-2xx status (the server's 429 when the prefetch
 * budget is spent, a 503, a 404) - so a prefetch that got one is never used
 * as a navigation's answer.
 */
export type PageResult =
  | { kind: 'page'; html: string; url: string; transient: boolean }
  /** Not a GioJS page (or unreachable): the browser loads `url` itself. */
  | { kind: 'load'; url: string; transient: boolean }
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
    return await judgePage(res, url);
  } catch {
    return { kind: 'load', url, transient: true };
  }
}

/** Judge a fetched response for `url`. Rejects only when reading its body fails. */
async function judgePage(res: Response, url: string): Promise<PageResult> {
  if (isHardReloadResponse(res)) return { kind: 'reload' };
  const transient = !res.ok;
  // After redirects res.url is where the page really lives: history and
  // the navigation context must name it, not the link's href.
  let finalUrl = url;
  if (res.url) {
    const landed = sameOriginUrl(res.url);
    if (landed === null) return { kind: 'load', url: res.url, transient };
    finalUrl = landed.pathname + landed.search;
  }
  if (!isHtml(res)) return { kind: 'load', url: finalUrl, transient };
  const html = await res.text();
  // 404/500 pages rendered by GioJS carry the boundary and soft-navigate
  // like any page; a static host's 404.html or Rust's 503 page do not.
  if (!html.includes('id="__gio"')) return { kind: 'load', url: finalUrl, transient };
  return { kind: 'page', html, url: finalUrl, transient };
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

/**
 * The answer for a navigation to `url`: a fresh prefetch of it, unless that
 * prefetch got a transient answer - then the page is fetched again.
 */
async function pageForNavigation(url: string): Promise<PageResult> {
  const prefetched = await cachedPage(url)?.result;
  if (prefetched !== undefined && (prefetched.kind === 'reload' || !prefetched.transient)) return prefetched;
  return fetchPage(url, 'navigate');
}

/** Drop every prefetched page (refresh(), and after any same-origin mutation). */
export function invalidatePrefetchCache(): void {
  cacheGeneration += 1;
  prefetchEntries.clear();
}

/**
 * Fetch `href` into the prefetch cache (GioLink hover/viewport, and
 * router.prefetch). Every answer is kept until it expires, so hovering the
 * link again does not refetch it; a definitive non-GioJS answer (JSON, a 200
 * page without the boundary) also sends a click straight to a full load. A
 * transient one - a network error, a 429 from the server's prefetch budget,
 * any non-2xx - is not trusted for the click: the navigation fetches the
 * page itself. No-op on the server and for other origins.
 */
export function prefetch(href: string): void {
  if (typeof window === 'undefined') return;
  const target = sameOriginUrl(href);
  if (target === null) return;
  const url = target.pathname + target.search;
  if (url === currentPageUrl() || cachedPage(url) !== undefined) return;
  ensureRouter();
  // A deployment-skew answer is kept too: the click on the link becomes a
  // full load of the new build. Reloading the page on hover (or as a link
  // scrolls into view) would throw away what the user has on screen.
  const result = fetchPage(url, 'prefetch');
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
 * in-memory positions still cover this document), and so is a browser that
 * refuses the write (Safari rate-limits replaceState).
 */
function writeEntryState(entry: EntryState): void {
  const state: unknown = history.state;
  if (state !== null && state !== undefined && !isRecord(state)) return;
  try {
    history.replaceState({ ...(state ?? {}), [STATE_KEY]: entry }, '');
  } catch {
    // The in-memory position still covers this document.
  }
}

let keyCounter = 0;
function newEntryKey(): string {
  keyCounter += 1;
  return `${Date.now().toString(36)}-${keyCounter}`;
}

let routerActive = false;
// The current history entry's key.
let currentKey: string | null = null;
// The entry whose page is on screen, and the URL fragment it was shown
// with. They trail currentKey while a traversal's page is still loading,
// and the fragment trails the address bar while the browser handles a plain
// `<a href="#x">` (it scrolls to the target before hashchange keys the new
// entry): scroll positions are recorded only while both still match.
let shownKey: string | null = null;
let shownHash = '';
// The path + query the page on screen was rendered for: a popstate to the
// same one is a hash-only traversal, nothing to fetch.
let renderedUrl: string | null = null;
// Back/forward cannot write the entry being left, so positions also live
// here, kept current by a scroll listener (an entry can be left without the
// router seeing it go: a plain #anchor link).
const scrollPositions = new Map<string, [number, number]>();
// history.state gets the position too (it survives a full load of another
// document), written once scrolling pauses.
const SCROLL_PERSIST_DELAY_MS = 150;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function currentPageUrl(): string {
  return window.location.pathname + window.location.search;
}

/** The pathname part of a path + query such as renderedUrl. */
function pathnameOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** The current entry's page is the one on screen: record positions for it. */
function markShown(): void {
  shownKey = currentKey;
  shownHash = window.location.hash;
}

function onShownEntry(): boolean {
  return currentKey !== null && currentKey === shownKey && window.location.hash === shownHash;
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
  markShown();
  scrollPositions.set(currentKey, [window.scrollX, window.scrollY]);
  setScrollRestoration('manual');
  window.addEventListener('popstate', onPopState);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('scroll', onScroll, { passive: true });
  trackMutations();
  // The live region must exist before its first message, or screen readers
  // may not announce it.
  announcer();
}

/** Record the position of the page on screen in its entry (memory and history.state). */
function saveScroll(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  if (!onShownEntry() || currentKey === null) return;
  const scroll: [number, number] = [window.scrollX, window.scrollY];
  scrollPositions.set(currentKey, scroll);
  writeEntryState({ key: currentKey, scroll });
}

function onScroll(): void {
  if (!onShownEntry() || currentKey === null) return;
  scrollPositions.set(currentKey, [window.scrollX, window.scrollY]);
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(saveScroll, SCROLL_PERSIST_DELAY_MS);
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
  markShown();
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

const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
]);

/** A field the user types into: navigating as they type must not take it away. */
function isTextEntry(element: Element): boolean {
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(element.type);
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLElement && element.isContentEditable === true;
}

interface Arrival {
  /** The pathname changed: another page, not a new query of the same one. */
  newPage: boolean;
  /** The navigation keeps the view where it is (`scroll: false`). */
  keepView: boolean;
}

/**
 * After a soft navigation to another page: announce its title, and move
 * focus to it (its <main>, else the #__gio boundary) so keyboard and
 * screen-reader users start there instead of on a link that may be gone.
 * Focus stays where it is when the page focused something itself
 * (autoFocus), when the user is typing in a field that is still there
 * (search as you type), and when a `scroll: false` navigation (tabs) leaves
 * the focused element in place.
 *
 * A navigation within the page (only the query changed: filters, sorting,
 * ?page=2) neither announces nor moves focus - unless the render removed
 * the focused element, which would leave keyboard users at the top.
 */
function focusAndAnnounce(focusedBefore: Element | null, arrival: Arrival): void {
  const boundary = document.getElementById('__gio');
  const active = document.activeElement;
  const hadFocus = focusedBefore !== null && focusedBefore !== document.body;
  const focusLost = active === null || active === document.body;
  const pageTookFocus = !focusLost && active !== focusedBefore && boundary?.contains(active) === true;
  const kept = !focusLost && active === focusedBefore;
  let moveFocus: boolean;
  if (pageTookFocus) moveFocus = false;
  else if (!arrival.newPage) moveFocus = hadFocus && focusLost;
  else moveFocus = !(kept && active !== null && (arrival.keepView || isTextEntry(active)));
  if (moveFocus) {
    const target = boundary?.querySelector('main') ?? document.querySelector('main') ?? boundary;
    if (target instanceof HTMLElement) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  }
  if (!arrival.newPage) return;
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
    const rawEntry = typeof envelope['entry'] === 'string' ? envelope['entry'] : '';
    let entry = '';
    if (rawEntry !== '') {
      // The chunk is imported by URL: only ever a same-origin path, judged
      // by the URL parser that import() resolves it with (which reads
      // '/\host/x.js' as another origin), and imported as the normalized
      // path it judged - never one that normalized into '//host/...'.
      if (!rawEntry.startsWith('/')) return null;
      const resolved = sameOriginUrl(rawEntry);
      if (resolved === null || resolved.pathname.startsWith('//')) return null;
      entry = resolved.pathname + resolved.search;
    }
    return { doc, content, envelopeScript, entry, pattern: envelope['pattern'] };
  } catch {
    return null;
  }
}

/**
 * Whether `content` still holds a Suspense boundary that was pending when the
 * shell streamed (React marks it `<!--$?-->`): its resolved HTML sits outside
 * the #__gio boundary, behind a script.
 */
function hasPendingBoundary(content: Element): boolean {
  const comments = content.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_COMMENT);
  for (let node = comments.nextNode(); node !== null; node = comments.nextNode()) {
    if (node.nodeValue === '$?') return true;
  }
  return false;
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

/** How long a navigation waits for the next route's stylesheets before rendering anyway. */
export const STYLESHEET_WAIT_MS = 3000;

/**
 * Load the route stylesheets the next page links (React stylesheet
 * resources - `<link rel="stylesheet" data-precedence>`, hoisted out of
 * #__gio) that this document does not have yet, and resolve once each has
 * loaded or failed (at most STYLESHEET_WAIT_MS), so the next route is never
 * shown unstyled. The persistent root renders inside flushSync, where React
 * does not hold the commit back for new stylesheets, and a server-only page
 * is swapped in as plain HTML: both rely on this. Inserted after the
 * existing ones, keeping cascade order; React adopts them by href when it
 * renders the route.
 *
 * Inline style resources (`<style data-precedence data-href>`, such as
 * `<Animate>`'s) this document lacks are copied too, and need no wait.
 */
export function adoptStylesheets(page: string | Document): Promise<void> {
  const parsed = typeof page === 'string' ? new DOMParser().parseFromString(page, 'text/html') : page;
  adoptInlineStyles(parsed);
  const present = new Set(
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link =>
      link.getAttribute('href'),
    ),
  );
  const pending: Promise<void>[] = [];
  // Anywhere in the document: without a root layout they open the <body>.
  for (const incoming of parsed.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-precedence]')) {
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
 * Copy `parsed`'s React style resources whose hrefs (`data-href` lists them,
 * space-separated) this document has none of. A server-only page is swapped
 * in as plain HTML, so without this its `<Animate>` elements would have no
 * stylesheet unless the previous page happened to load it. React adopts a
 * copy by its `data-href` when it renders the route.
 */
function adoptInlineStyles(parsed: Document): void {
  const hrefsOf = (style: Element): string[] =>
    (style.getAttribute('data-href') ?? '').split(/\s+/).filter(href => href !== '');
  const present = new Set(
    [...document.querySelectorAll('style[data-href]')].flatMap(style => hrefsOf(style)),
  );
  for (const incoming of parsed.querySelectorAll<HTMLStyleElement>('style[data-precedence][data-href]')) {
    const hrefs = hrefsOf(incoming);
    if (hrefs.every(href => present.has(href))) continue;
    for (const href of hrefs) present.add(href);
    const style = document.createElement('style');
    style.setAttribute('data-precedence', incoming.getAttribute('data-precedence') ?? 'default');
    style.setAttribute('data-href', hrefs.join(' '));
    style.textContent = incoming.textContent;
    const last = [...document.head.querySelectorAll('[data-precedence]')].at(-1);
    if (last !== undefined) last.after(style);
    else document.head.append(style);
  }
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
  markShown();
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
  if (page.entry === '' && hasPendingBoundary(page.content)) {
    // A streamed page without a client tree: its server HTML is shown as is,
    // but the content its Suspense boundaries resolved to was streamed after
    // #__gio (with the scripts that move it in, which never run here).
    // Swapped in, it would show the loading fallback for good.
    throw new Error('streamed server-only page: load it in full');
  }
  if (page.entry !== '') {
    // The route chunk loads before anything changes on screen. Without a
    // runtime yet (the current page does not hydrate), importing the chunk
    // brings it in.
    if (clientRuntime() === undefined) await import(page.entry);
    await clientRuntime()?.prepare(page.entry, page.pattern);
  }
  if (!isCurrentNavigation(seq)) return false;
  // Its new stylesheets load before anything changes on screen, too.
  await adoptStylesheets(page.doc);
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
  // A link to the URL already shown replaces its entry, as browsers do.
  const replace = options.replace === true || target.href === window.location.href;
  // href="#": an empty fragment, which the browser treats as the top of the page.
  const fragment = target.hash !== '' ? target.hash : target.href.endsWith('#') ? '#' : '';

  if (path === currentPageUrl() && fragment !== '') {
    // Same page, new fragment: no fetch, just a history entry and a scroll.
    beginNavigation();
    updateHistory(replace ? 'replace' : 'push', path + fragment);
    if (scroll) scrollAfterPush(target.hash);
    return;
  }

  const fromPathname = pathnameOf(renderedUrl ?? currentPageUrl());
  const seq = beginNavigation();
  const result = await pageForNavigation(path);
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
  focusAndAnnounce(focusedBefore, { newPage: window.location.pathname !== fromPathname, keepView: !scroll });
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

// ── form submissions ──────────────────────────────────────────────────────────

/** The request header marking a GioForm submission (giojs-core ssr.ts). */
const FORM_SUBMISSION_HEADER = 'x-gio-form';
/**
 * Where the server names the target of a redirect answering a submission:
 * a 204 instead of a 3xx, which fetch would follow on its own - off-site,
 * into a CORS failure after the action had already run.
 */
const FORM_REDIRECT_HEADER = 'x-gio-redirect';

/**
 * How a form submission ended (GioForm turns it into its result and
 * callbacks). `status`, `url` (path + query) and `redirected` describe the
 * final response, after any redirect.
 */
export type FormSubmitOutcome =
  /** A GioJS page - the action's re-render, or where its redirect led - is on screen. */
  | { kind: 'shown'; status: number; url: string; redirected: boolean; actionData: unknown }
  /** Not a GioJS page and not a redirect: nothing was rendered. */
  | { kind: 'response'; status: number; url: string; redirected: boolean; response: Response }
  /**
   * A redirect led somewhere the router cannot render - another site, a
   * file, a page it could not fetch - and the browser is loading it. When
   * the browser goes there without the router seeing the answer, `status`
   * is the submission's own (2xx) and, off-site, `url` the absolute target.
   * `download`: the target is a file the browser saves, so this page stays.
   */
  | { kind: 'loading'; status: number; url: string; redirected: boolean; download: boolean }
  /** Deployment skew: the server refused the request before the action ran. */
  | { kind: 'reload' }
  /** A newer navigation took over; its page is the one shown. */
  | { kind: 'superseded' }
  /** The request failed (network error); it may or may not have reached the server. */
  | { kind: 'failed'; error: unknown };

/** The `actionData` prop the page's envelope carries, if any. */
function envelopeActionData(page: ParsedPage): unknown {
  if (page.envelopeScript === null) return undefined;
  try {
    const envelope: unknown = JSON.parse(page.envelopeScript.textContent ?? '');
    return isRecord(envelope) && isRecord(envelope['props']) ? envelope['props']['actionData'] : undefined;
  } catch {
    return undefined;
  }
}

function pageRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'text/html' };
  const id = getDeploymentId();
  if (id) headers['x-deployment-id'] = id;
  return headers;
}

/**
 * A redirect's Location resolved against the URL that answered it, or null
 * when it is not an http(s) URL - browsers refuse to follow those too, and
 * a javascript: target must never reach location.assign.
 */
function redirectTarget(location: string, base: string): URL | null {
  let target: URL;
  try {
    target = new URL(location, new URL(base, window.location.href));
  } catch {
    return null;
  }
  return target.protocol === 'http:' || target.protocol === 'https:' ? target : null;
}

/**
 * GET a same-origin redirect target, revalidating any copy in the HTTP
 * cache: it shows what the mutation changed. Null when only the browser can
 * load it - unreachable, redirecting on off-site (a sign-in), or answered
 * from a newer deployment.
 */
async function fetchRedirectTarget(path: string): Promise<Response | null> {
  try {
    const res = await fetch(path, { headers: pageRequestHeaders(), cache: 'no-cache' });
    return isHardReloadResponse(res) ? null : res;
  } catch {
    return null;
  }
}

/** A file download (Content-Disposition: attachment): loading it leaves this page on screen. */
function isAttachment(res: Response): boolean {
  return /^\s*attachment\b/i.test(res.headers.get('content-disposition') ?? '');
}

/**
 * POST `body` to `url` (same-origin path + query) and render the answer the
 * way a navigation renders a page: through the persistent root, so state
 * outside what changed survives. A redirect's target (Post/Redirect/Get) -
 * which the server names in x-gio-redirect for these requests - is fetched
 * and shown under its own URL (a new history entry, scrolled to the top);
 * one on another site is handed to the browser. A re-render of the same URL
 * replaces the current entry and keeps the scroll position. Never rejects.
 * Internal: GioForm's half of the router.
 */
export async function submitForm(url: string, body: FormData | URLSearchParams): Promise<FormSubmitOutcome> {
  if (typeof window === 'undefined') return { kind: 'superseded' };
  ensureRouter();
  const fromPathname = pathnameOf(renderedUrl ?? currentPageUrl());
  const seq = beginNavigation();
  let res: Response;
  // A mutation: no page prefetched before (or during) it may be shown after.
  invalidatePrefetchCache();
  try {
    res = await fetch(url, {
      method: 'POST',
      body,
      headers: { ...pageRequestHeaders(), [FORM_SUBMISSION_HEADER]: '1' },
      // A redirect fetch does follow itself (a 307/308, one from the
      // server's own rules) must not be answered from the HTTP cache either.
      cache: 'no-cache',
    });
  } catch (error) {
    return { kind: 'failed', error };
  } finally {
    invalidatePrefetchCache();
  }
  if (isHardReloadResponse(res)) return { kind: 'reload' };
  let { status, redirected } = res;
  let requested = url;
  let hash = '';
  const location = res.headers.get(FORM_REDIRECT_HEADER);
  if (location !== null) {
    // The action ran and redirected: from here on, only GETs.
    const target = redirectTarget(location, res.url || url);
    if (target === null) {
      const error = new TypeError(`GioForm: refusing to follow a redirect to ${JSON.stringify(location)}`);
      return { kind: 'failed', error };
    }
    if (!isCurrentNavigation(seq)) return { kind: 'superseded' };
    redirected = true;
    if (target.origin !== window.location.origin) {
      hardNavigate(target.href, false);
      return { kind: 'loading', status, url: target.href, redirected, download: false };
    }
    requested = target.pathname + target.search;
    hash = target.hash;
    const followed = await fetchRedirectTarget(requested);
    if (followed === null) {
      if (!isCurrentNavigation(seq)) return { kind: 'superseded' };
      hardNavigate(requested + hash, false);
      return { kind: 'loading', status, url: requested, redirected, download: false };
    }
    res = followed;
    status = res.status;
  }
  // Callbacks get the untouched response when it is not a page.
  const raw = res.clone();
  let result: PageResult;
  try {
    result = await judgePage(res, requested);
  } catch (error) {
    return { kind: 'failed', error };
  }
  if (!isCurrentNavigation(seq)) return { kind: 'superseded' };
  if (result.kind === 'reload') return { kind: 'reload' };
  const page = result.kind === 'page' ? parsePage(result.html) : null;
  if (page === null) {
    if (!redirected) return { kind: 'response', status, url: result.url, redirected, response: raw };
    // The action already ran and sent the browser on: loading the target is
    // the GET the browser would make anyway.
    hardNavigate(result.url + hash, false);
    return { kind: 'loading', status, url: result.url, redirected, download: isAttachment(raw) };
  }
  const shownUrl = result.url + hash;
  const mode = result.url === currentPageUrl() ? 'replace' : 'push';
  const focusedBefore = document.activeElement;
  let shown: boolean;
  try {
    shown = await showPage(page, shownUrl, mode, false, seq);
  } catch {
    if (!isCurrentNavigation(seq)) return { kind: 'superseded' };
    hardNavigate(shownUrl, mode === 'replace');
    return { kind: 'loading', status, url: result.url, redirected, download: false };
  }
  if (!shown) return { kind: 'superseded' };
  const newPage = window.location.pathname !== fromPathname;
  if (newPage || hash !== '') scrollAfterPush(hash);
  focusAndAnnounce(focusedBefore, { newPage, keepView: !newPage });
  return { kind: 'shown', status, url: result.url, redirected, actionData: envelopeActionData(page) };
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
  const state = entryState(event.state);
  // Back/forward to one of our entries: the scroll position still belongs to
  // the page being left. A state-less entry may instead be one a plain
  // #anchor link just created, and the browser may already have scrolled to
  // its target: the scroll listener recorded the position before that.
  if (state !== null && currentKey !== null && currentKey === shownKey) {
    scrollPositions.set(currentKey, [window.scrollX, window.scrollY]);
  }
  const key = state?.key ?? newEntryKey();
  if (state === null) writeEntryState({ key });
  currentKey = key;
  const url = window.location.pathname + window.location.search;
  const seq = beginNavigation();
  if (url === renderedUrl) {
    // Only the fragment changed: the page on screen is this entry's.
    markShown();
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
  const result = await pageForNavigation(url);
  if (!isCurrentNavigation(seq)) return;
  const page = result.kind === 'page' ? parsePage(result.html) : null;
  if (result.kind !== 'page' || page === null) {
    // Already at the URL: the browser loads it in place.
    window.location.reload();
    return;
  }
  const fromPathname = pathnameOf(renderedUrl ?? '');
  const focusedBefore = document.activeElement;
  try {
    if (!(await showPage(page, result.url + window.location.hash, 'pop', false, seq))) return;
  } catch {
    if (isCurrentNavigation(seq)) window.location.reload();
    return;
  }
  restoreScroll(key, saved);
  focusAndAnnounce(focusedBefore, { newPage: window.location.pathname !== fromPathname, keepView: false });
}
