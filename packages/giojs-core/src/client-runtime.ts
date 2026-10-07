/**
 * giojs-core/src/client-runtime.ts
 *
 * Browser-side mount registry shared by every generated route entry (esbuild
 * splits it into a common chunk). Hydrates the #__gio boundary on first load
 * and keeps that ONE React root for the rest of the visit: a soft navigation
 * (@gio.js/react navigation.ts, through `window.__GIO_RUNTIME__`) renders
 * the next route's tree into it, so layouts the two routes share keep their
 * state. Everything outside #__gio (root layout, Rust-injected head tags,
 * the dev overlay) is server HTML that React never touches. Inside it, every
 * folder's error.* is a React error boundary, so an error thrown while
 * rendering in the browser replaces only that segment instead of unmounting
 * the page.
 *
 * Every tree is wrapped in the navigation context (navigation-context.ts)
 * built from the envelope's route info - the values the server rendered
 * with, so the hooks reading it hydrate without a mismatch.
 *
 * The envelope also carries the `<GioImage>` config the server rendered
 * with; it is installed before every render so srcsets hydrate unchanged.
 * Its `metadata` head tags are rendered in front of the route's tree, as on
 * the server (metadata-tags.ts): React adopts the server's head elements on
 * hydration, and each soft navigation's render swaps them for the next
 * page's.
 *
 * The tree starts at the useId tree position the server rendered #__gio's
 * content at (id-tree.ts, from the boundary's `data-gio-tree`): useId values
 * hydrate unchanged however deep the root layout puts the boundary. The
 * persistent root keeps the position it hydrated with for every later
 * render, so the tree's shape - and with it every layout's state - never
 * changes under a soft navigation.
 */
import React from 'react';
import { flushSync } from 'react-dom';
import { hydrateRoot, createRoot, type Root } from 'react-dom/client';
import { withNavigation, type GioNavigationState } from './navigation-context.ts';
import { sanitizeMetadataTags, withMetadata, type MetadataTag } from './metadata-tags.ts';
import { atBoundaryPosition, ID_TREE_ATTRIBUTE } from './id-tree.ts';

// Generated entries build their tree with the same function the server used.
export { buildSegmentTree } from './segment-tree.ts';

/** Payload of the `#__gio_props` JSON script emitted by the SSR renderer. */
export interface GioEnvelope {
  props: Record<string, unknown>;
  path: string;
  pattern: string;
  entry: string;
  /** Route info for the navigation context (absent from older envelopes). */
  params: Record<string, string>;
  search: string;
  locale: string;
  /** image-config.ts ImageRenderConfig, opaque here. */
  images?: Record<string, unknown>;
  /** i18n-config.ts I18nRenderConfig (apps with `[i18n] locales`), opaque here. */
  i18n?: Record<string, unknown>;
  /** The page's head tags (metadata-tags.ts). */
  metadata?: MetadataTag[];
}

/**
 * The runtime's half of soft navigation, published as
 * `window.__GIO_RUNTIME__` for @gio.js/react (a separate package and bundle
 * entry, so the contract is a global rather than an import).
 */
export interface GioClientRuntime {
  /**
   * Load the route entry chunk for `pattern` before the page is shown.
   * Rejects when the chunk fails to load or registers no such route.
   */
  prepare(entry: string, pattern: string): Promise<void>;
  /**
   * Show the page whose envelope is now in the document (or the server-only
   * page without one). `content` is that page's server-rendered #__gio: it
   * is swapped in only when the page has no client tree to render into the
   * persistent root.
   */
  commit(content: Element | null): void;
}

type BuildFn = (props: Record<string, unknown>, path: string) => React.ReactNode;

const routeBuilders = new Map<string, BuildFn>();
let activeRoot: Root | null = null;
let activeContainer: Element | null = null;
/** The useId tree position activeRoot's trees render at (id-tree.ts). */
let activeTreeId: string | null = null;
/** Whether activeRoot's tree renders a metadata <title> (React owns it). */
let rootRendersTitle = false;
let runtimeInstalled = false;
let waitingForEnvelope = false;

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

function readEnvelope(): GioEnvelope | null {
  const el = document.getElementById('__gio_props');
  if (el === null || el.textContent === null) return null;
  try {
    const parsed: unknown = JSON.parse(el.textContent);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const env = parsed as Record<string, unknown>;
    if (typeof env['pattern'] !== 'string' || typeof env['path'] !== 'string') return null;
    return {
      props: (env['props'] ?? {}) as Record<string, unknown>,
      path: env['path'],
      pattern: env['pattern'],
      entry: typeof env['entry'] === 'string' ? env['entry'] : '',
      params: stringRecord(env['params']),
      search: typeof env['search'] === 'string' ? env['search'] : '',
      locale: typeof env['locale'] === 'string' ? env['locale'] : '',
      ...(typeof env['images'] === 'object' && env['images'] !== null
        ? { images: env['images'] as Record<string, unknown> }
        : {}),
      ...(typeof env['i18n'] === 'object' && env['i18n'] !== null
        ? { i18n: env['i18n'] as Record<string, unknown> }
        : {}),
      ...(Array.isArray(env['metadata']) ? { metadata: sanitizeMetadataTags(env['metadata']) } : {}),
    };
  } catch {
    return null;
  }
}

function navigationState(envelope: GioEnvelope): GioNavigationState {
  return {
    pathname: envelope.path,
    params: envelope.params,
    search: envelope.search,
    locale: envelope.locale,
    pattern: envelope.pattern,
  };
}

/**
 * The route's tree with its metadata head tags in front, at the boundary's
 * useId tree position (`treeId`), inside the navigation provider, image
 * and i18n config installed.
 */
function routeElement(envelope: GioEnvelope, build: BuildFn, treeId: string | null): React.ReactNode {
  if (envelope.images !== undefined) {
    (globalThis as Record<string, unknown>)['__GIO_IMAGES__'] = envelope.images;
  }
  if (envelope.i18n !== undefined) {
    (globalThis as Record<string, unknown>)['__GIO_I18N__'] = envelope.i18n;
  }
  return withNavigation(
    navigationState(envelope),
    atBoundaryPosition(treeId, withMetadata(build(envelope.props, envelope.path), envelope.metadata)),
  );
}

/** Where the server rendered `container`'s content in its tree (id-tree.ts). */
function treeIdOfBoundary(container: Element): string | null {
  return container.getAttribute(ID_TREE_ATTRIBUTE);
}

function rendersTitle(envelope: GioEnvelope | null): boolean {
  return envelope?.metadata?.some(tag => tag.tag === 'title') === true;
}

/**
 * Run `update` - a render into the root, or its unmount - keeping exactly
 * one right <title>. navigation.ts has already set document.title to the
 * next page's, which writes into the first <title>: when React owns that
 * element (the current tree renders a metadata title), a next tree without
 * one removes it, so the title is put back afterwards. When the next tree
 * renders a metadata title but the current one does not, the <title> in
 * the head is server-only HTML (a root layout's): it goes first, as the
 * server drops one next to a metadata title (ssr.ts), or it would sit in
 * front of React's and win document.title.
 */
function updateRoot(nextRendersTitle: boolean, update: () => void): void {
  const title = document.title;
  if (nextRendersTitle && !rootRendersTitle) {
    for (const element of document.head.querySelectorAll('title')) element.remove();
  }
  update();
  rootRendersTitle = nextRendersTitle;
  if (!nextRendersTitle && document.title !== title) document.title = title;
}

/** First load: hydrate the server HTML. Later route registrations never re-mount. */
function mount(): void {
  if (activeRoot !== null) return;
  const container = document.getElementById('__gio');
  const envelope = readEnvelope();
  if (container === null || envelope === null) return;
  const build = routeBuilders.get(envelope.pattern);
  if (build === undefined) return;
  // The container holds this exact tree's server HTML.
  activeContainer = container;
  activeTreeId = treeIdOfBoundary(container);
  // The server rendered this tree's metadata title, if any, in place of any
  // hand-written one: hydration adopts it.
  rootRendersTitle = rendersTitle(envelope);
  activeRoot = hydrateRoot(container, routeElement(envelope, build, activeTreeId));
}

async function prepare(entry: string, pattern: string): Promise<void> {
  if (routeBuilders.has(pattern)) return;
  // The chunk registers its route (registerRoute) as it evaluates.
  await import(entry);
  if (!routeBuilders.has(pattern)) {
    throw new Error(`route entry ${entry} did not register ${pattern}`);
  }
}

function commit(content: Element | null): void {
  const envelope = readEnvelope();
  const build = envelope === null ? undefined : routeBuilders.get(envelope.pattern);
  const root = activeRoot;
  if (envelope !== null && build !== undefined && root !== null && activeContainer?.isConnected) {
    // The persistent root: React reconciles the next route's tree against
    // the current one. Synchronous, so the caller can scroll and move focus
    // on the committed page. At the position the root hydrated with, not the
    // next page's: a different one would remount the whole tree.
    const element = routeElement(envelope, build, activeTreeId);
    updateRoot(rendersTitle(envelope), () => flushSync(() => root.render(element)));
    return;
  }
  // No client tree to reconcile with (a server-only page on either side):
  // the next page's server HTML replaces the old root's container. The
  // unmount takes the old tree's metadata head tags with it.
  if (root !== null) {
    updateRoot(false, () => root.unmount());
    activeRoot = null;
    activeContainer = null;
    activeTreeId = null;
  }
  const current = document.getElementById('__gio');
  if (content !== null && current !== null && content !== current) {
    current.replaceWith(content);
    if (envelope === null) startServerOnlyAnimations(content);
  }
  if (envelope === null || build === undefined) return;
  const container = document.getElementById('__gio');
  if (container === null) return;
  // Rendered, not hydrated: fetched HTML can hold streamed Suspense
  // boundaries whose completion scripts never ran.
  const fresh = createRoot(container);
  activeRoot = fresh;
  activeContainer = container;
  activeTreeId = treeIdOfBoundary(container);
  const element = routeElement(envelope, build, activeTreeId);
  updateRoot(rendersTitle(envelope), () => flushSync(() => fresh.render(element)));
}

/**
 * A server-only page's `<Animate>` elements start through the inline script
 * the server put after each one (@gio.js/react's Animate.tsx), but scripts
 * in swapped-in HTML never run - and a nonce from another response would
 * not pass the page's CSP anyway. So do their job: hand each element to the
 * `__GIO_ANIMATE__` observer (`immediate` is the script's last argument).
 */
function startServerOnlyAnimations(content: Element): void {
  const start = animateStarter();
  for (const el of Array.from(content.querySelectorAll<HTMLElement>('[data-gio-animate]'))) {
    const script = el.nextElementSibling;
    const immediate = script?.tagName === 'SCRIPT' && (script.textContent ?? '').endsWith(',1)');
    start(el, immediate ? 1 : 0);
  }
}

/** The inline script passes its previous sibling, which may be missing. */
type AnimateStart = (el: HTMLElement | null, immediate: number) => void;

/**
 * The page's `__GIO_ANIMATE__`, which the first server-only `<Animate>`
 * script on a document defines. When none ran here yet, define the same
 * one: a shared observer that marks an element entered the first time it is
 * 10% visible, or at once for `immediate` and in a browser without
 * IntersectionObserver. Later inline scripts then share it too.
 */
function animateStarter(): AnimateStart {
  const registry = window as unknown as { __GIO_ANIMATE__?: unknown };
  if (typeof registry.__GIO_ANIMATE__ === 'function') return registry.__GIO_ANIMATE__ as AnimateStart;
  let observer: IntersectionObserver | undefined;
  const start: AnimateStart = (el, immediate) => {
    if (el === null) return;
    if (immediate !== 0 || typeof IntersectionObserver !== 'function') {
      el.dataset['gioAnimateState'] = 'entered';
      return;
    }
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset['gioAnimateState'] = 'entered';
          observer?.unobserve(entry.target);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
  };
  registry.__GIO_ANIMATE__ = start;
  return start;
}

/** Called by each generated route entry when its module loads. */
export function registerRoute(pattern: string, build: BuildFn): void {
  routeBuilders.set(pattern, build);
  if (!runtimeInstalled) {
    runtimeInstalled = true;
    const runtime: GioClientRuntime = { prepare, commit };
    (window as unknown as { __GIO_RUNTIME__?: GioClientRuntime }).__GIO_RUNTIME__ = runtime;
  }
  if (document.readyState === 'loading' && readEnvelope() === null) {
    waitForEnvelope();
    return;
  }
  mount();
}

/**
 * PPR pages stream the envelope after the cached shell, so an entry module
 * (async) can run before it has arrived. Mount the moment it is parsed: the
 * Suspense holes behind it can take far longer, and DOMContentLoaded waits
 * for all of them. DOMContentLoaded stays as the fallback (no
 * MutationObserver, or no envelope at all), and whichever fires first mounts
 * exactly once.
 */
function waitForEnvelope(): void {
  if (waitingForEnvelope) return;
  waitingForEnvelope = true;
  let observer: MutationObserver | null = null;
  const ready = (): void => {
    if (!waitingForEnvelope) return;
    waitingForEnvelope = false;
    observer?.disconnect();
    document.removeEventListener('DOMContentLoaded', ready);
    mount();
  };
  if (typeof MutationObserver === 'function') {
    // characterData too: a large envelope's text can arrive in several
    // network chunks, appended to the same text node. readEnvelope() only
    // succeeds once the JSON is complete.
    observer = new MutationObserver(() => {
      if (readEnvelope() !== null) ready();
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  }
  document.addEventListener('DOMContentLoaded', ready);
}
