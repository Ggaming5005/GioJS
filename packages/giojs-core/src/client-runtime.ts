/**
 * giojs-core/src/client-runtime.ts
 *
 * Browser-side mount registry shared by every generated route entry (esbuild
 * splits it into a common chunk). Hydrates the #__gio boundary on first load,
 * and re-mounts after soft navigation swaps (the `gio:navigated` event),
 * dynamically importing the new route's entry chunk when it isn't loaded yet.
 * Everything outside #__gio (root layout, Rust-injected head tags, the dev
 * overlay) is server HTML that React never touches. Inside it, every folder's
 * error.* is a React error boundary, so an error thrown while rendering in
 * the browser replaces only that segment instead of unmounting the page.
 *
 * The envelope also carries the `<GioImage>` config the server rendered
 * with; it is installed before every render so srcsets hydrate unchanged.
 * Its `metadata` head tags are rendered in front of the route's tree, as on
 * the server (metadata-tags.ts): React adopts the server's head elements on
 * hydration and swaps them for the next page's when the tree changes.
 */
import React from 'react';
import { hydrateRoot, createRoot, type Root } from 'react-dom/client';
import { sanitizeMetadataTags, withMetadata, type MetadataTag } from './metadata-tags.ts';

// Generated entries build their tree with the same function the server used.
export { buildSegmentTree } from './segment-tree.ts';

/** Payload of the `#__gio_props` JSON script emitted by the SSR renderer. */
export interface GioEnvelope {
  props: Record<string, unknown>;
  path: string;
  pattern: string;
  entry: string;
  /** image-config.ts ImageRenderConfig, opaque here. */
  images?: Record<string, unknown>;
  /** The page's head tags (metadata-tags.ts). */
  metadata?: MetadataTag[];
}

type BuildFn = (props: Record<string, unknown>, path: string) => React.ReactNode;

const routeBuilders = new Map<string, BuildFn>();
let activeRoot: Root | null = null;
/** Set by the first mount: later ones render swapped-in HTML afresh. */
let hydrated = false;
let listenerInstalled = false;
let waitingForEnvelope = false;

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
      ...(typeof env['images'] === 'object' && env['images'] !== null
        ? { images: env['images'] as Record<string, unknown> }
        : {}),
      ...(Array.isArray(env['metadata']) ? { metadata: sanitizeMetadataTags(env['metadata']) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Unmount the previous page's root. Its React-owned head tags go with it -
 * that is how the next page's replace them - and so does its <title>,
 * which navigation has already retitled for the next page. Unless the next
 * tree renders a metadata title of its own, that title is put back; when it
 * does, a leftover server-only <title> would sit next to it, so it goes -
 * as the server drops one next to a metadata title (ssr.ts).
 */
function unmountActiveRoot(nextRendersTitle: boolean): void {
  const title = document.title;
  activeRoot?.unmount();
  activeRoot = null;
  if (nextRendersTitle) {
    for (const element of document.head.querySelectorAll('title')) element.remove();
  } else if (document.title !== title) {
    document.title = title;
  }
}

function mount(): void {
  const container = document.getElementById('__gio');
  const envelope = readEnvelope();
  if (container === null || envelope === null) {
    // Soft navigation to a page that never hydrates (no client bundle, or
    // props that could not be serialized): the previous page's root would
    // otherwise keep the head tags it hoisted.
    if (activeRoot !== null) unmountActiveRoot(false);
    return;
  }

  const build = routeBuilders.get(envelope.pattern);
  if (build === undefined) {
    // Soft navigation landed on a route whose entry chunk isn't loaded yet;
    // importing it re-enters mount() via registerRoute.
    if (envelope.entry !== '') {
      import(envelope.entry).catch(() => undefined);
    }
    return;
  }

  if (envelope.images !== undefined) {
    (globalThis as Record<string, unknown>)['__GIO_IMAGES__'] = envelope.images;
  }
  const element = withMetadata(build(envelope.props, envelope.path), envelope.metadata);
  if (!hydrated) {
    // First load: the container holds this exact tree's server HTML.
    hydrated = true;
    activeRoot = hydrateRoot(container, element);
  } else {
    // After a swap the old root's container is detached (or there is none:
    // the previous page did not hydrate); a fresh render replaces the
    // swapped-in server HTML.
    unmountActiveRoot(envelope.metadata?.some(tag => tag.tag === 'title') === true);
    activeRoot = createRoot(container);
    activeRoot.render(element);
  }
}

/** Called by each generated route entry when its module loads. */
export function registerRoute(pattern: string, build: BuildFn): void {
  routeBuilders.set(pattern, build);
  if (!listenerInstalled) {
    listenerInstalled = true;
    window.addEventListener('gio:navigated', mount);
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
