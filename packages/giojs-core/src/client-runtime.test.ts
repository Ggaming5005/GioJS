/**
 * giojs-core/src/client-runtime.test.ts
 *
 * First-load mounting against a minimal fake DOM. PPR pages stream their
 * hydration envelope after the cached shell, so the entry module can run
 * before it exists - the runtime must wait for the envelope (not give up),
 * and mount as soon as it is parsed rather than after the slowest hole.
 * Generated entries build their tree with the runtime's buildSegmentTree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const hydrateRoot = vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() }));
vi.mock('react-dom/client', () => ({ hydrateRoot, createRoot: vi.fn() }));

interface FakeDocument {
  readyState: string;
  elements: Map<string, { textContent: string | null; getAttribute?: (name: string) => string | null }>;
  listeners: Map<string, () => void>;
}

function installDom(readyState: string): FakeDocument {
  const fake: FakeDocument = { readyState, elements: new Map(), listeners: new Map() };
  vi.stubGlobal('document', {
    get readyState() {
      return fake.readyState;
    },
    getElementById: (id: string) => fake.elements.get(id) ?? null,
    addEventListener: (type: string, fn: () => void) => fake.listeners.set(type, fn),
    removeEventListener: (type: string, fn: () => void) => {
      if (fake.listeners.get(type) === fn) fake.listeners.delete(type);
    },
  });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  // The boundary at the root position (id-tree.ts): only the marks, no forks.
  fake.elements.set('__gio', { textContent: '', getAttribute: name => (name === 'data-gio-tree' ? '1' : null) });
  return fake;
}

/** Records MutationObservers so a test can play the parser's mutations. */
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  observing: { target: unknown; options: MutationObserverInit } | null = null;
  constructor(readonly callback: () => void) {
    FakeMutationObserver.instances.push(this);
  }
  observe(target: unknown, options: MutationObserverInit): void {
    this.observing = { target, options };
  }
  disconnect(): void {
    this.observing = null;
  }
  /** The parser inserted or appended something. */
  static mutate(): void {
    for (const observer of FakeMutationObserver.instances) {
      if (observer.observing !== null) observer.callback();
    }
  }
}

const ENVELOPE = JSON.stringify({ props: { who: 'bob' }, path: '/ppr', pattern: '/ppr', entry: '/e.js' });

describe('registerRoute first load', () => {
  beforeEach(() => {
    vi.resetModules();
    hydrateRoot.mockClear();
    FakeMutationObserver.instances = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hydrates immediately when the envelope is already parsed', async () => {
    const dom = installDom('loading');
    dom.elements.set('__gio_props', { textContent: ENVELOPE });
    const { registerRoute } = await import('./client-runtime.ts');
    const build = vi.fn(() => null);
    registerRoute('/ppr', build);
    expect(build).toHaveBeenCalledWith({ who: 'bob' }, '/ppr');
    expect(hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it('mounts as soon as the deferred envelope is parsed, not after the slowest hole', async () => {
    const dom = installDom('loading');
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    const { registerRoute } = await import('./client-runtime.ts');
    const build = vi.fn(() => null);
    registerRoute('/ppr', build);
    expect(hydrateRoot).not.toHaveBeenCalled();
    const [observer] = FakeMutationObserver.instances;
    expect(observer?.observing?.options).toMatchObject({ childList: true, subtree: true });

    // Unrelated shell/hole nodes, then the envelope's text in two pieces.
    FakeMutationObserver.mutate();
    dom.elements.set('__gio_props', { textContent: ENVELOPE.slice(0, 20) });
    FakeMutationObserver.mutate();
    expect(hydrateRoot).not.toHaveBeenCalled();
    dom.elements.set('__gio_props', { textContent: ENVELOPE });
    FakeMutationObserver.mutate();

    // Still parsing (holes outstanding) - hydrated anyway, exactly once.
    expect(dom.readyState).toBe('loading');
    expect(build).toHaveBeenCalledWith({ who: 'bob' }, '/ppr');
    expect(hydrateRoot).toHaveBeenCalledTimes(1);
    expect(observer?.observing).toBeNull();
    expect(dom.listeners.has('DOMContentLoaded')).toBe(false);
    FakeMutationObserver.mutate();
    expect(hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it('DOMContentLoaded mounts when the observer never saw the envelope, and only once', async () => {
    const dom = installDom('loading');
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    const { registerRoute } = await import('./client-runtime.ts');
    registerRoute('/ppr', vi.fn(() => null));
    dom.elements.set('__gio_props', { textContent: ENVELOPE });
    dom.readyState = 'interactive';
    dom.listeners.get('DOMContentLoaded')?.();
    expect(hydrateRoot).toHaveBeenCalledTimes(1);
    expect(FakeMutationObserver.instances[0]?.observing).toBeNull();
    FakeMutationObserver.mutate();
    expect(hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it('falls back to DOMContentLoaded without MutationObserver', async () => {
    const dom = installDom('loading');
    const { registerRoute } = await import('./client-runtime.ts');
    const build = vi.fn(() => null);
    registerRoute('/ppr', build);
    expect(hydrateRoot).not.toHaveBeenCalled();

    // The holes (and the deferred envelope) arrive; parsing finishes.
    dom.elements.set('__gio_props', { textContent: ENVELOPE });
    dom.readyState = 'interactive';
    dom.listeners.get('DOMContentLoaded')?.();
    expect(build).toHaveBeenCalledWith({ who: 'bob' }, '/ppr');
    expect(hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it('installs the envelope image config before the hydration render', async () => {
    const dom = installDom('complete');
    const images = { widths: [640, 1080], quality: 80, unoptimized: false };
    dom.elements.set('__gio_props', {
      textContent: JSON.stringify({ ...JSON.parse(ENVELOPE), images }),
    });
    vi.stubGlobal('__GIO_IMAGES__', undefined);
    const { registerRoute } = await import('./client-runtime.ts');
    let seen: unknown;
    registerRoute('/ppr', () => {
      seen = (globalThis as Record<string, unknown>)['__GIO_IMAGES__'];
      return null;
    });
    expect(seen).toEqual(images);
    expect(hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it('a partially parsed envelope also waits instead of hydrating with nothing', async () => {
    const dom = installDom('loading');
    dom.elements.set('__gio_props', { textContent: ENVELOPE.slice(0, 20) });
    const { registerRoute } = await import('./client-runtime.ts');
    registerRoute('/ppr', vi.fn(() => null));
    expect(hydrateRoot).not.toHaveBeenCalled();
    expect(dom.listeners.has('DOMContentLoaded')).toBe(true);
  });
});

describe('generated entries', () => {
  beforeEach(() => {
    vi.resetModules();
    hydrateRoot.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hydrate the tree the server built: buildSegmentTree comes from the runtime itself', async () => {
    const dom = installDom('complete');
    dom.elements.set('__gio_props', { textContent: ENVELOPE });
    const runtime = await import('./client-runtime.ts');
    const { buildSegmentTree, SegmentErrorScope } = await import('./segment-tree.ts');
    const { navigationContext } = await import('./navigation-context.ts');
    expect(runtime.buildSegmentTree).toBe(buildSegmentTree);
    const ErrorView = (): null => null;
    // What a generated entry registers for a page under an error.* folder.
    runtime.registerRoute('/ppr', (props, path) =>
      runtime.buildSegmentTree(React.createElement('p', props), path, [{ error: ErrorView }]),
    );
    const hydrated = hydrateRoot.mock.calls[0] as unknown[] | undefined;
    // Inside the navigation provider, built from the envelope's route info.
    const provider = hydrated?.[1] as
      | React.ReactElement<{ value: unknown; children: React.ReactElement<{ fallback: unknown }> }>
      | undefined;
    expect(provider?.type).toBe(navigationContext());
    expect(provider?.props.value).toEqual({
      pathname: '/ppr',
      params: {},
      search: '',
      locale: '',
      pattern: '/ppr',
    });
    // Then the boundary's useId tree position (id-tree.ts): at the root
    // position, just its two useId marks.
    type Wrapping = React.ReactElement<{ children: unknown }>;
    const firstMark = provider?.props.children as unknown as Wrapping | undefined;
    const secondMark = firstMark?.props.children as Wrapping | undefined;
    expect(typeof firstMark?.type).toBe('function');
    expect(secondMark?.type).toBe(firstMark?.type);
    // Then the metadata wrapper (metadata-tags.ts withMetadata): the page's
    // head tags in front of the tree, in the same shape with none.
    const wrapper = secondMark?.props.children as
      | React.ReactElement<{ children: React.ReactElement<{ fallback: unknown }>[] }>
      | undefined;
    expect(wrapper?.type).toBe(React.Fragment);
    const element = wrapper?.props.children[1];
    expect(element?.type).toBe(SegmentErrorScope);
    expect(element?.props.fallback).toBe(ErrorView);
  });
});
