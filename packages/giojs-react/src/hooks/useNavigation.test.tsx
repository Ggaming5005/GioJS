// @vitest-environment jsdom
/**
 * packages/giojs-react/src/hooks/useNavigation.test.tsx
 *
 * The router hooks end to end in jsdom: rendered on the "server" with
 * react-dom/server inside the navigation provider (as ssr.ts does), then
 * hydrated from the same envelope route info (as client-runtime.ts does)
 * without a single hydration warning - LocaleLink's prefixed href included.
 * A soft navigation through a runtime with one persistent root updates every
 * hook while a shared layout keeps its state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { navigationContext, type GioNavigationState } from '../navigation-context.ts';

// @ts-expect-error React 19 act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Hooks = typeof import('./useNavigation.ts');
type Locale = typeof import('./useLocale.ts');
type LocaleLinkModule = typeof import('../LocaleLink.tsx');

const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAddEventListener = window.addEventListener.bind(window);

let hooks: Hooks;
let useLocale: Locale['useLocale'];
let LocaleLink: LocaleLinkModule['LocaleLink'];
let root: Root | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    listeners.push([type, listener]);
    realAddEventListener(type, listener, options);
  }) as typeof window.addEventListener);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  consoleError = vi.spyOn(console, 'error');
  history.replaceState(null, '', '/fr/posts/1?tab=comments');
  hooks = await import('./useNavigation.ts');
  ({ useLocale } = await import('./useLocale.ts'));
  ({ LocaleLink } = await import('../LocaleLink.tsx'));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'];
});

interface Envelope {
  props: Record<string, unknown>;
  path: string;
  pattern: string;
  entry: string;
  params: Record<string, string>;
  search: string;
  locale: string;
}

function stateOf(env: Envelope): GioNavigationState {
  return { pathname: env.path, params: env.params, search: env.search, locale: env.locale, pattern: env.pattern };
}

function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  const [opened, setOpened] = React.useState(0);
  return (
    <div>
      <button id="layout" onClick={() => setOpened(n => n + 1)}>{`opened=${opened}`}</button>
      {children}
    </div>
  );
}

function PostPage(): React.ReactElement {
  const pathname = hooks.usePathname();
  const params = hooks.useParams<{ id: string }>();
  const searchParams = hooks.useSearchParams();
  const locale = useLocale();
  return (
    <main>
      <p id="values">{`${pathname}|${params.id}|${searchParams.get('tab') ?? '-'}|${locale}`}</p>
      <LocaleLink href="/about" defaultLocale="en">about</LocaleLink>
    </main>
  );
}

function tree(env: Envelope): React.ReactElement {
  const Provider = navigationContext().Provider;
  return (
    <Provider value={stateOf(env)}>
      <Layout>
        <PostPage key={env.path} />
      </Layout>
    </Provider>
  );
}

const FIRST: Envelope = {
  props: {},
  path: '/posts/1',
  pattern: '/posts/:id',
  entry: '/chunks/post.js',
  params: { id: '1' },
  search: '?tab=comments',
  locale: 'fr',
};

function envelopeScript(env: Envelope): string {
  return `<script id="__gio_props" type="application/json">${JSON.stringify(env)}</script>`;
}

/** Server HTML (provider around the #__gio boundary), then hydration as the runtime does it. */
async function serverRenderAndHydrate(env: Envelope): Promise<void> {
  const Provider = navigationContext().Provider;
  const html = renderToString(
    <Provider value={stateOf(env)}>
      <div id="__gio">
        <Layout>
          <PostPage key={env.path} />
        </Layout>
      </div>
    </Provider>,
  );
  document.body.innerHTML = html + envelopeScript(env);
  const container = document.getElementById('__gio');
  if (container === null) throw new Error('no boundary');
  await act(async () => {
    root = hydrateRoot(container, tree(env));
  });
}

/** A runtime with one persistent root - the contract client-runtime.ts implements. */
function installRuntime(): void {
  (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'] = {
    prepare: async () => undefined,
    commit: () => {
      const env = JSON.parse(document.getElementById('__gio_props')?.textContent ?? '{}') as Envelope;
      const current = root;
      if (current !== null) flushSync(() => current.render(tree(env)));
    },
  };
}

const values = (): string | null => document.getElementById('values')?.textContent ?? null;

describe('router hooks', () => {
  it('render the request values on the server, LocaleLink prefixed', () => {
    const html = renderToString(tree(FIRST));
    expect(html).toContain('/posts/1|1|comments|fr');
    expect(html).toContain('href="/fr/about"');
  });

  it('hydrate from the envelope route info without a mismatch', async () => {
    await serverRenderAndHydrate(FIRST);
    expect(values()).toBe('/posts/1|1|comments|fr');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/fr/about');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('follow a soft navigation while the shared layout keeps its state', async () => {
    await serverRenderAndHydrate(FIRST);
    installRuntime();
    act(() => document.getElementById('layout')?.click());
    expect(document.getElementById('layout')?.textContent).toBe('opened=1');

    const next: Envelope = { ...FIRST, path: '/posts/2', params: { id: '2' }, search: '', locale: 'fr' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          `<html><head><title>Post 2</title></head><body><div id="__gio"></div>${envelopeScript(next)}</body></html>`,
          { headers: { 'content-type': 'text/html' } },
        ),
      ),
    );
    await act(async () => {
      await hooks.useRouter().push('/fr/posts/2');
    });

    expect(window.location.pathname).toBe('/fr/posts/2');
    expect(values()).toBe('/posts/2|2|-|fr');
    expect(document.getElementById('layout')?.textContent).toBe('opened=1');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('useSearchParams is read-only', () => {
    let captured: ReturnType<Hooks['useSearchParams']> | null = null;
    function Reader(): null {
      captured = hooks.useSearchParams();
      return null;
    }
    const Provider = navigationContext().Provider;
    renderToString(
      <Provider value={stateOf({ ...FIRST, search: '?a=1&a=2' })}>
        <Reader />
      </Provider>,
    );
    const params = captured as unknown as URLSearchParams;
    expect(params.getAll('a')).toEqual(['1', '2']);
    expect(() => params.set('a', '3')).toThrow(/read-only/);
    expect(() => params.append('b', '1')).toThrow(/read-only/);
    expect(params.toString()).toBe('a=1&a=2');
  });

  it('useRouter returns one stable object', () => {
    const seen: unknown[] = [];
    function Reader(): null {
      seen.push(hooks.useRouter());
      return null;
    }
    renderToString(<Reader />);
    renderToString(<Reader />);
    expect(seen[0]).toBe(seen[1]);
    expect(Object.keys(seen[0] as object).sort()).toEqual(
      ['back', 'forward', 'prefetch', 'push', 'refresh', 'replace'],
    );
  });

  it('outside a GioJS tree: the browser URL, and the document lang for useLocale', async () => {
    document.documentElement.lang = 'de';
    function Bare(): React.ReactElement {
      return <p id="values">{`${hooks.usePathname()}|${hooks.useSearchParams().get('tab')}|${useLocale()}`}</p>;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { createRoot } = await import('react-dom/client');
    await act(async () => {
      root = createRoot(container);
      root.render(<Bare />);
    });
    expect(values()).toBe('/fr/posts/1|comments|de');
    document.documentElement.lang = '';
  });
});
