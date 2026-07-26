/**
 * giojs-core/src/client-runtime.ts
 *
 * Browser-side mount registry shared by every generated route entry (esbuild
 * splits it into a common chunk). Hydrates the #__gio boundary on first load,
 * and re-mounts after soft navigation swaps (the `gio:navigated` event),
 * dynamically importing the new route's entry chunk when it isn't loaded yet.
 * Everything outside #__gio (root layout, Rust-injected head tags, the dev
 * overlay) is server HTML that React never touches.
 */
import React from 'react';
import { hydrateRoot, createRoot, type Root } from 'react-dom/client';

/** Payload of the `#__gio_props` JSON script emitted by the SSR renderer. */
export interface GioEnvelope {
  props: Record<string, unknown>;
  path: string;
  pattern: string;
  entry: string;
}

type BuildFn = (props: Record<string, unknown>, path: string) => React.ReactNode;

const routeBuilders = new Map<string, BuildFn>();
let activeRoot: Root | null = null;
let listenerInstalled = false;

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
    };
  } catch {
    return null;
  }
}

function mount(): void {
  const container = document.getElementById('__gio');
  const envelope = readEnvelope();
  if (container === null || envelope === null) return;

  const build = routeBuilders.get(envelope.pattern);
  if (build === undefined) {
    // Soft navigation landed on a route whose entry chunk isn't loaded yet;
    // importing it re-enters mount() via registerRoute.
    if (envelope.entry !== '') {
      import(envelope.entry).catch(() => undefined);
    }
    return;
  }

  const element = build(envelope.props, envelope.path);
  if (activeRoot === null) {
    // First load: the container holds this exact tree's server HTML.
    activeRoot = hydrateRoot(container, element);
  } else {
    // After a swap the old root's container is detached; a fresh render
    // replaces the swapped-in server HTML.
    activeRoot.unmount();
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
  mount();
}
