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
 */
import React from 'react';
import { flushSync } from 'react-dom';
import { hydrateRoot, createRoot, type Root } from 'react-dom/client';
import { withNavigation, type GioNavigationState } from './navigation-context.ts';
import { sanitizeMetadataTags, withMetadata, type MetadataTag } from './metadata-tags.ts';

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
 * The route's tree with its metadata head tags in front, inside the
 * navigation provider, image config installed.
 */
function routeElement(envelope: GioEnvelope, build: BuildFn): React.ReactNode {
  if (envelope.images !== undefined) {
    (globalThis as Record<string, unknown>)['__GIO_IMAGES__'] = envelope.images;
  }
  return withNavigation(
    navigationState(envelope),
    withMetadata(build(envelope.props, envelope.path), envelope.metadata),
  );
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
  // The server rendered this tree's metadata title, if any, in place of any
  // hand-written one: hydration adopts it.
  rootRendersTitle = rendersTitle(envelope);
  activeRoot = hydrateRoot(container, routeElement(envelope, build));
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
    // on the committed page.
    const element = routeElement(envelope, build);
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
  }
  const current = document.getElementById('__gio');
  if (content !== null && current !== null && content !== current) current.replaceWith(content);
  if (envelope === null || build === undefined) return;
  const container = document.getElementById('__gio');
  if (container === null) return;
  // Rendered, not hydrated: fetched HTML can hold streamed Suspense
  // boundaries whose completion scripts never ran.
  const fresh = createRoot(container);
  activeRoot = fresh;
  activeContainer = container;
  const element = routeElement(envelope, build);
  updateRoot(rendersTitle(envelope), () => flushSync(() => fresh.render(element)));
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
