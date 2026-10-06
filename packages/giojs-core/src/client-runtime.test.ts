/**
 * giojs-core/src/client-runtime.test.ts
 *
 * First-load mounting against a minimal fake DOM. PPR pages stream their
 * hydration envelope after the cached shell, so the entry module can run
 * before it exists - the runtime must wait for the document, not give up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hydrateRoot = vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() }));
vi.mock('react-dom/client', () => ({ hydrateRoot, createRoot: vi.fn() }));

interface FakeDocument {
  readyState: string;
  elements: Map<string, { textContent: string | null }>;
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
  });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  fake.elements.set('__gio', { textContent: '' });
  return fake;
}

const ENVELOPE = JSON.stringify({ props: { who: 'bob' }, path: '/ppr', pattern: '/ppr', entry: '/e.js' });

describe('registerRoute first load', () => {
  beforeEach(() => {
    vi.resetModules();
    hydrateRoot.mockClear();
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

  it('waits for DOMContentLoaded when the envelope streams in after the shell', async () => {
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

  it('a partially parsed envelope also waits instead of hydrating with nothing', async () => {
    const dom = installDom('loading');
    dom.elements.set('__gio_props', { textContent: ENVELOPE.slice(0, 20) });
    const { registerRoute } = await import('./client-runtime.ts');
    registerRoute('/ppr', vi.fn(() => null));
    expect(hydrateRoot).not.toHaveBeenCalled();
    expect(dom.listeners.has('DOMContentLoaded')).toBe(true);
  });
});
