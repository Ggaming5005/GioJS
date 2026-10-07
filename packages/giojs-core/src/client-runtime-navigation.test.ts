// @vitest-environment jsdom
/**
 * giojs-core/src/client-runtime-navigation.test.ts
 *
 * The persistent root behind soft navigation, against a real DOM: the
 * first load hydrates the server HTML (navigation context included) without
 * a mismatch, `__GIO_RUNTIME__.commit` renders the next route into the SAME
 * root so a shared layout keeps its state (unless the dynamic segment it
 * lives under changed), a caught error clears on navigation - a query-only
 * one too - and server-only pages swap their HTML in and out of the root.
 * useId values hydrate unchanged however deep a root layout puts #__gio,
 * and the persistent root keeps that tree position across navigations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import type { GioClientRuntime } from './client-runtime.ts';
import { withStylesheets, type GioErrorProps, type SegmentLevel } from './segment-tree.ts';
import { navigationContext, withNavigation, type GioNavigationState } from './navigation-context.ts';
import { withMetadata, type MetadataTag } from './metadata-tags.ts';
import { hydrationBoundary } from './id-tree.ts';

// @ts-expect-error React's act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Runtime = typeof import('./client-runtime.ts');

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  consoleError.mockRestore();
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'];
});

function runtimeApi(): GioClientRuntime {
  const api = (window as unknown as { __GIO_RUNTIME__?: GioClientRuntime }).__GIO_RUNTIME__;
  if (api === undefined) throw new Error('runtime not installed');
  return api;
}

/** A layout with its own state: survives navigation only in a persistent root. */
function CounterLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  const [count, setCount] = React.useState(0);
  return React.createElement(
    'section',
    null,
    React.createElement('button', { id: 'count', onClick: () => setCount(c => c + 1) }, `count=${count}`),
    children,
  );
}

/** Shows what the navigation hooks would read. */
function Where(): React.ReactElement {
  const nav = React.useContext(navigationContext());
  return React.createElement('p', { id: 'where' }, `${nav?.pathname}|${nav?.search}|${JSON.stringify(nav?.params)}`);
}

function Page({ label }: { label: string }): React.ReactElement {
  return React.createElement('main', null, React.createElement('h1', null, label), React.createElement(Where));
}

function ErrorView({ error }: GioErrorProps): React.ReactElement {
  return React.createElement('div', { id: 'caught' }, error.message);
}

const levels: SegmentLevel[] = [{ layout: CounterLayout, error: ErrorView }];

interface PageSpec {
  path: string;
  pattern: string;
  params?: Record<string, string>;
  search?: string;
  props: Record<string, unknown>;
  /** The envelope's head tags (metadata-tags.ts). */
  metadata?: MetadataTag[];
}

function envelopeJson(spec: PageSpec): string {
  return JSON.stringify({
    props: spec.props,
    path: spec.path,
    pattern: spec.pattern,
    entry: `/entry${spec.pattern}.js`,
    params: spec.params ?? {},
    search: spec.search ?? '',
    locale: 'en',
    ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
  });
}

function navState(spec: PageSpec): GioNavigationState {
  return {
    pathname: spec.path,
    params: spec.params ?? {},
    search: spec.search ?? '',
    locale: 'en',
    pattern: spec.pattern,
  };
}

/** Put the new page's envelope in the document, as navigation.ts does before commit. */
function swapEnvelope(spec: PageSpec | null): void {
  document.getElementById('__gio_props')?.remove();
  if (spec === null) return;
  const script = document.createElement('script');
  script.id = '__gio_props';
  script.type = 'application/json';
  script.textContent = envelopeJson(spec);
  document.body.appendChild(script);
}

function serverContent(html: string): HTMLElement {
  const div = document.createElement('div');
  div.id = '__gio';
  div.innerHTML = html;
  return div;
}

/** A root layout (server-only HTML): the boundary sits deep in its tree. */
type RootLayout = (children: React.ReactNode) => React.ReactNode;

async function loadFirstPage(
  spec: PageSpec,
  page: React.ComponentType<{ label: string }>,
  pageLevels: SegmentLevel[] = levels,
  rootLayout: RootLayout = children => children,
): Promise<Runtime> {
  const runtime = await import('./client-runtime.ts');
  const tree = runtime.buildSegmentTree(
    React.createElement(page, spec.props as { label: string }),
    spec.path,
    pageLevels,
  );
  // The server render: the provider around the document, the root layout,
  // #__gio inside next to the envelope, the metadata tags in front of the
  // tree (ssr.ts).
  const html = renderToString(
    withNavigation(
      navState(spec),
      rootLayout(
        React.createElement(
          React.Fragment,
          null,
          hydrationBoundary(withMetadata(tree, spec.metadata)),
          null,
          null,
        ),
      ),
    ),
  );
  document.body.innerHTML = html;
  swapEnvelope(spec);
  await act(async () => {
    runtime.registerRoute(spec.pattern, (props, path) =>
      runtime.buildSegmentTree(React.createElement(page, props as { label: string }), path, pageLevels),
    );
  });
  return runtime;
}

const text = (id: string): string | null => document.getElementById(id)?.textContent ?? null;

describe('persistent root', () => {
  it('hydrates the first page with its navigation context and no mismatch', async () => {
    await loadFirstPage({ path: '/posts/1', pattern: '/posts/:id', params: { id: '1' }, search: '?tab=a', props: { label: 'one' } }, Page);
    expect(text('where')).toBe('/posts/1|?tab=a|{"id":"1"}');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders the next route into the same root: the shared layout keeps its state', async () => {
    const runtime = await loadFirstPage({ path: '/a', pattern: '/a', props: { label: 'A' } }, Page);
    act(() => document.getElementById('count')?.click());
    act(() => document.getElementById('count')?.click());
    expect(text('count')).toBe('count=2');
    const container = document.getElementById('__gio');

    runtime.registerRoute('/posts/:id', (props, path) =>
      runtime.buildSegmentTree(React.createElement(Page, props as { label: string }), path, levels),
    );
    const next: PageSpec = { path: '/posts/7', pattern: '/posts/:id', params: { id: '7' }, props: { label: 'B' } };
    await runtimeApi().prepare('/entry/posts/:id.js', '/posts/:id');
    swapEnvelope(next);
    act(() => runtimeApi().commit(serverContent('<p>server html of B</p>')));

    // Committed synchronously, into the same container.
    expect(document.getElementById('__gio')).toBe(container);
    expect(document.querySelector('h1')?.textContent).toBe('B');
    expect(text('where')).toBe('/posts/7||{"id":"7"}');
    expect(text('count')).toBe('count=2');
    expect(document.body.textContent).not.toContain('server html of B');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps the shared layout between pages with and without head metadata', async () => {
    const runtime = await loadFirstPage({ path: '/b', pattern: '/b', props: { label: 'B' } }, Page);
    act(() => document.getElementById('count')?.click());
    expect(text('count')).toBe('count=1');
    runtime.registerRoute('/a', (props, path) =>
      runtime.buildSegmentTree(React.createElement(Page, props as { label: string }), path, levels),
    );
    const pageA: PageSpec = {
      path: '/a',
      pattern: '/a',
      props: { label: 'A' },
      metadata: [
        { tag: 'title', text: 'TITLE_A' },
        { tag: 'meta', attrs: { name: 'description', content: 'DESC_A' } },
      ],
    };
    const titles = (): string[] => [...document.head.querySelectorAll('title')].map(t => t.textContent ?? '');

    // To a page with metadata: navigation.ts retitles the document first
    // (a server-only <title>), then React renders A's tags - one title.
    document.title = 'TITLE_A';
    swapEnvelope(pageA);
    act(() => runtimeApi().commit(null));
    expect(document.querySelector('h1')?.textContent).toBe('A');
    expect(text('count')).toBe('count=1');
    expect(titles()).toEqual(['TITLE_A']);
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('DESC_A');

    // Back to one without: A's tags go - React's <title> too, so the title
    // navigation set is put back - and the layout above both pages stays.
    document.title = 'TITLE_B';
    swapEnvelope({ path: '/b', pattern: '/b', props: { label: 'B' } });
    act(() => runtimeApi().commit(null));
    expect(document.querySelector('h1')?.textContent).toBe('B');
    expect(text('count')).toBe('count=1');
    expect(document.head.querySelector('meta[name="description"]')).toBeNull();
    expect(titles()).toEqual(['TITLE_B']);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps the shared layout between routes that link different stylesheets', async () => {
    const runtime = await import('./client-runtime.ts');
    // What client-build.ts generates: each entry wraps its route's tree
    // with withStylesheets(), whatever (if anything) the route links.
    const register = (pattern: string, hrefs: string[]): void => {
      runtime.registerRoute(pattern, (props, path) =>
        withStylesheets(
          runtime.buildSegmentTree(React.createElement(Page, props as { label: string }), path, levels),
          hrefs,
        ),
      );
    };
    const first: PageSpec = { path: '/plain', pattern: '/plain', props: { label: 'plain' } };
    document.body.innerHTML = renderToString(
      withNavigation(
        navState(first),
        React.createElement(
          'div',
          { id: '__gio' },
          withMetadata(
            withStylesheets(runtime.buildSegmentTree(React.createElement(Page, { label: 'plain' }), '/plain', levels), []),
            undefined,
          ),
        ),
      ),
    );
    swapEnvelope(first);
    await act(async () => register('/plain', []));
    act(() => document.getElementById('count')?.click());
    expect(text('count')).toBe('count=1');

    register('/styled', ['/_next/static/css/route-styled-A.css', '/_next/static/css/route-styled-B.css']);
    swapEnvelope({ path: '/styled', pattern: '/styled', props: { label: 'styled' } });
    act(() => runtimeApi().commit(null));
    expect(document.querySelector('h1')?.textContent).toBe('styled');
    expect(text('count')).toBe('count=1');
    expect(document.head.querySelectorAll('link[rel="stylesheet"][href^="/_next/static/css/route-styled-"]')).toHaveLength(2);

    register('/other', ['/_next/static/css/route-other-C.css']);
    swapEnvelope({ path: '/other', pattern: '/other', props: { label: 'other' } });
    act(() => runtimeApi().commit(null));
    expect(document.querySelector('h1')?.textContent).toBe('other');
    expect(text('count')).toBe('count=1');

    swapEnvelope({ path: '/plain', pattern: '/plain', props: { label: 'plain again' } });
    act(() => runtimeApi().commit(null));
    expect(document.querySelector('h1')?.textContent).toBe('plain again');
    expect(text('count')).toBe('count=1');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('remounts the page (not the layout) between two URLs of one route', async () => {
    function StatefulPage({ label }: { label: string }): React.ReactElement {
      const [clicks, setClicks] = React.useState(0);
      return React.createElement('button', { id: 'page', onClick: () => setClicks(c => c + 1) }, `${label}:${clicks}`);
    }
    await loadFirstPage({ path: '/p/1', pattern: '/p/:id', props: { label: 'one' } }, StatefulPage);
    act(() => document.getElementById('page')?.click());
    act(() => document.getElementById('count')?.click());
    expect(text('page')).toBe('one:1');

    swapEnvelope({ path: '/p/2', pattern: '/p/:id', props: { label: 'two' } });
    act(() => runtimeApi().commit(null));
    expect(text('page')).toBe('two:0');
    expect(text('count')).toBe('count=1');

    // Same path again (a refresh with new props): the page keeps its state.
    act(() => document.getElementById('page')?.click());
    swapEnvelope({ path: '/p/2', pattern: '/p/:id', props: { label: 'fresh' } });
    act(() => runtimeApi().commit(null));
    expect(text('page')).toBe('fresh:1');
  });

  it('clears an error a shared boundary caught when navigating away', async () => {
    consoleError.mockImplementation(() => undefined);
    function Exploding(): React.ReactElement {
      const [boom, setBoom] = React.useState(false);
      if (boom) throw new Error('page blew up');
      return React.createElement('button', { id: 'boom', onClick: () => setBoom(true) }, 'explode');
    }
    const runtime = await loadFirstPage({ path: '/x', pattern: '/x', props: { label: 'x' } }, Exploding);
    act(() => document.getElementById('boom')?.click());
    expect(text('caught')).not.toBeNull();

    runtime.registerRoute('/y', (props, path) =>
      runtime.buildSegmentTree(React.createElement(Page, props as { label: string }), path, levels),
    );
    swapEnvelope({ path: '/y', pattern: '/y', props: { label: 'Y' } });
    act(() => runtimeApi().commit(null));
    expect(text('caught')).toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe('Y');
  });

  it('clears a caught error on a query-only navigation', async () => {
    consoleError.mockImplementation(() => undefined);
    function SearchPage(): React.ReactElement {
      const search = React.useContext(navigationContext())?.search;
      if (search === '?q=bad') throw new Error('bad query');
      return React.createElement('main', null, React.createElement('h1', null, `results ${search}`));
    }
    await loadFirstPage({ path: '/search', pattern: '/search', search: '?q=ok', props: { label: 's' } }, SearchPage);
    act(() => document.getElementById('count')?.click());

    swapEnvelope({ path: '/search', pattern: '/search', search: '?q=bad', props: { label: 's' } });
    act(() => runtimeApi().commit(null));
    expect(text('caught')).not.toBeNull();

    // Same path, same route: only the query changed.
    swapEnvelope({ path: '/search', pattern: '/search', search: '?q=good', props: { label: 's' } });
    act(() => runtimeApi().commit(null));
    expect(text('caught')).toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe('results ?q=good');
    expect(text('count')).toBe('count=1');
  });

  it('remounts a layout below a dynamic segment when its value changes', async () => {
    function TeamLayout({ children }: { children: React.ReactNode }): React.ReactElement {
      const [count, setCount] = React.useState(0);
      return React.createElement(
        'div',
        null,
        React.createElement('button', { id: 'team-count', onClick: () => setCount(c => c + 1) }, `team=${count}`),
        children,
      );
    }
    // app/(site)/layout.tsx and app/teams/[team]/layout.tsx.
    const teamLevels: SegmentLevel[] = [{ layout: CounterLayout }, { layout: TeamLayout, params: ['team'] }];
    const pattern = '/teams/:team/:tab';
    await loadFirstPage(
      { path: '/teams/a/settings', pattern, params: { team: 'a', tab: 'settings' }, props: { label: 'A' } },
      Page,
      teamLevels,
    );
    expect(consoleError).not.toHaveBeenCalled();
    act(() => document.getElementById('count')?.click());
    act(() => document.getElementById('team-count')?.click());

    // Another tab of the same team: the team's layout keeps its state.
    swapEnvelope({ path: '/teams/a/members', pattern, params: { team: 'a', tab: 'members' }, props: { label: 'A2' } });
    act(() => runtimeApi().commit(null));
    expect(text('team-count')).toBe('team=1');

    // Another team: its layout mounts fresh; the layout above it is kept.
    swapEnvelope({ path: '/teams/b/members', pattern, params: { team: 'b', tab: 'members' }, props: { label: 'B' } });
    act(() => runtimeApi().commit(null));
    expect(document.querySelector('h1')?.textContent).toBe('B');
    expect(text('team-count')).toBe('team=0');
    expect(text('count')).toBe('count=1');
  });

  it("shows the folder's loading.* while the next page suspends, inside the kept layout", async () => {
    const withLoading: SegmentLevel[] = [
      { layout: CounterLayout, loading: () => React.createElement('p', { id: 'loading' }, 'loading') },
    ];
    const runtime = await import('./client-runtime.ts');
    const first: PageSpec = { path: '/s/1', pattern: '/s/:id', props: { label: 'one' } };
    const html = renderToString(
      withNavigation(
        navState(first),
        hydrationBoundary(
          runtime.buildSegmentTree(React.createElement(Page, { label: 'one' }), first.path, withLoading),
        ),
      ),
    );
    document.body.innerHTML = html;
    swapEnvelope(first);
    let release: (value: string) => void = () => undefined;
    const data = new Promise<string>(resolve => {
      release = resolve;
    });
    function Slow(): React.ReactElement {
      return React.createElement('h1', null, React.use(data));
    }
    await act(async () => {
      runtime.registerRoute('/s/:id', (props, path) =>
        runtime.buildSegmentTree(
          React.createElement(path === '/s/1' ? Page : Slow, props as { label: string }),
          path,
          withLoading,
        ),
      );
    });
    act(() => document.getElementById('count')?.click());

    swapEnvelope({ path: '/s/2', pattern: '/s/:id', props: { label: 'two' } });
    // Async act: a sync act() scope never delivers the retry ping of a
    // boundary that suspended inside flushSync (browsers do).
    await act(async () => runtimeApi().commit(null));
    expect(text('loading')).toBe('loading');
    expect(text('count')).toBe('count=1');

    await act(async () => release('second'));
    expect(text('loading')).toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe('second');
    expect(text('count')).toBe('count=1');
  });

  it('swaps server-only pages in, then renders a fresh root for the next client page', async () => {
    await loadFirstPage({ path: '/a', pattern: '/a', props: { label: 'A' } }, Page);
    act(() => document.getElementById('count')?.click());

    // A not-found page: server HTML, no envelope.
    swapEnvelope(null);
    act(() => runtimeApi().commit(serverContent('<h1>Not here</h1>')));
    expect(document.querySelector('h1')?.textContent).toBe('Not here');
    expect(document.getElementById('count')).toBeNull();

    swapEnvelope({ path: '/a', pattern: '/a', props: { label: 'A again' } });
    act(() => runtimeApi().commit(serverContent('<p>server html</p>')));
    expect(document.querySelector('h1')?.textContent).toBe('A again');
    // The layout came back fresh: its old root is gone.
    expect(text('count')).toBe('count=0');
  });

  it('later route registrations never re-mount the page', async () => {
    const runtime = await loadFirstPage({ path: '/a', pattern: '/a', props: { label: 'A' } }, Page);
    act(() => document.getElementById('count')?.click());
    runtime.registerRoute('/other', () => React.createElement('p', null, 'other'));
    expect(text('count')).toBe('count=1');
  });

  it('prepare rejects when the chunk cannot be loaded', async () => {
    await loadFirstPage({ path: '/a', pattern: '/a', props: { label: 'A' } }, Page);
    await expect(runtimeApi().prepare('/definitely-missing-chunk.js', '/missing')).rejects.toThrow();
  });
});

describe('useId under a root layout', () => {
  /** A root layout putting the boundary behind siblings and a useId call. */
  function UsesId({ children }: { children?: React.ReactNode }): React.ReactNode {
    React.useId();
    return children;
  }
  const shell: RootLayout = children =>
    React.createElement(
      'div',
      { className: 'shell' },
      React.createElement('nav', null, 'menu'),
      React.createElement(UsesId, null, React.createElement('section', null, children)),
      React.createElement('footer', null, 'footer'),
    );

  /** A labelled field; shows the id the client computed once mounted. */
  function FieldPage({ label }: { label: string }): React.ReactElement {
    const id = React.useId();
    const [clientId, setClientId] = React.useState('');
    React.useEffect(() => setClientId(id), [id]);
    return React.createElement(
      'main',
      null,
      React.createElement('h1', null, label),
      React.createElement('label', { htmlFor: id }, 'name'),
      React.createElement('input', { id, name: 'name' }),
      React.createElement('output', { id: 'client-id' }, clientId),
    );
  }

  const input = (): HTMLInputElement | null => document.querySelector('input[name="name"]');

  it('hydrates with the ids the server rendered, without a mismatch', async () => {
    await loadFirstPage({ path: '/form', pattern: '/form', props: { label: 'form' } }, FieldPage, levels, shell);
    const serverId = input()?.id;
    expect(serverId).toMatch(/^_R_[0-9a-v]+_$/);
    expect(text('client-id')).toBe(serverId);
    expect(document.querySelector('label')?.htmlFor).toBe(serverId);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps the tree position across soft navigations: layout state survives, ids stay paired', async () => {
    const runtime = await loadFirstPage({ path: '/form', pattern: '/form', props: { label: 'form' } }, FieldPage, levels, shell);
    act(() => document.getElementById('count')?.click());
    runtime.registerRoute('/other', (props, path) =>
      runtime.buildSegmentTree(React.createElement(FieldPage, props as { label: string }), path, levels),
    );
    swapEnvelope({ path: '/other', pattern: '/other', props: { label: 'other' } });
    act(() => runtimeApi().commit(serverContent('<p>server html</p>')));
    expect(document.querySelector('h1')?.textContent).toBe('other');
    expect(text('count')).toBe('count=1');
    expect(document.querySelector('label')?.htmlFor).toBe(input()?.id);
    expect(text('client-id')).toBe(input()?.id);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders a fresh root at the position of the HTML it replaced', async () => {
    const runtime = await loadFirstPage({ path: '/form', pattern: '/form', props: { label: 'form' } }, FieldPage, levels, shell);
    swapEnvelope(null);
    act(() => runtimeApi().commit(serverContent('<h1>Not here</h1>')));
    runtime.registerRoute('/again', (props, path) =>
      runtime.buildSegmentTree(React.createElement(FieldPage, props as { label: string }), path, levels),
    );
    swapEnvelope({ path: '/again', pattern: '/again', props: { label: 'again' } });
    const content = serverContent('<p>server html</p>');
    content.setAttribute('data-gio-tree', '1d');
    act(() => runtimeApi().commit(content));
    expect(document.querySelector('h1')?.textContent).toBe('again');
    expect(document.querySelector('label')?.htmlFor).toBe(input()?.id);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
