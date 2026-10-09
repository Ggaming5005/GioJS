// @vitest-environment jsdom
/**
 * packages/giojs-react/src/navigation.test.ts
 *
 * The client router against jsdom with a mocked fetch: only GioJS pages are
 * rendered in place (anything else is a full load), history names the URL a
 * redirect landed on, scroll goes to the top or the #hash target and back/
 * forward restore it (also across a plain #anchor link the browser handled),
 * same-page hash links only scroll, prefetched pages expire, mutations
 * invalidate them and a failed prefetch never decides a click, refresh()
 * re-renders in place, focus moves to a new page (but never out of a field
 * the user is typing in) and its title is announced, and a slow superseded
 * navigation never clobbers a newer one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Nav = typeof import('./navigation.ts');

// Every test gets a fresh module, so router state never leaks between them;
// the window listeners an old instance registered are removed here too.
const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAddEventListener = window.addEventListener.bind(window);

let nav: Nav;
let assigned: string[];
let reloads: number;

async function loadNav(): Promise<Nav> {
  vi.resetModules();
  return import('./navigation.ts');
}

interface PageOptions {
  title?: string;
  /** Inner HTML of #__gio; null for a document without the boundary. */
  body?: string | null;
  envelope?: Record<string, unknown> | string | null;
  status?: number;
  contentType?: string;
  /** res.url after redirects (absolute or path). */
  url?: string;
}

function pageHtml(opts: PageOptions): string {
  const envelope =
    opts.envelope === undefined || opts.envelope === null
      ? ''
      : `<script id="__gio_props" type="application/json">${
          typeof opts.envelope === 'string' ? opts.envelope : JSON.stringify(opts.envelope)
        }</script>`;
  const boundary = opts.body === null ? '<h1>plain</h1>' : `<div id="__gio">${opts.body ?? ''}</div>`;
  return `<!DOCTYPE html><html lang="en"><head><title>${opts.title ?? ''}</title></head><body>${boundary}${envelope}</body></html>`;
}

function response(opts: PageOptions): Response {
  const res = new Response(pageHtml(opts), {
    status: opts.status ?? 200,
    headers: { 'content-type': opts.contentType ?? 'text/html; charset=utf-8' },
  });
  if (opts.url !== undefined) {
    Object.defineProperty(res, 'url', { value: new URL(opts.url, window.location.href).href });
  }
  return res;
}

function serve(routes: Record<string, () => Response | Promise<Response>>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.href);
    const handler = routes[path.pathname + path.search];
    if (handler === undefined) throw new TypeError(`network error: ${String(input)}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const gioText = (): string | null => document.getElementById('__gio')?.textContent ?? null;

/** Lets popstate handlers (async fetch + render) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
}

function setScroll(x: number, y: number): void {
  Object.defineProperty(window, 'scrollX', { value: x, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

/** The user (or the browser) scrolled: the position, then the scroll event. */
function userScroll(y: number): void {
  setScroll(0, y);
  window.dispatchEvent(new Event('scroll'));
}

/**
 * A client runtime that keeps everything in #__gio but its <main>: a layout
 * shared by both pages, as the persistent React root keeps it.
 */
function installLayoutRuntime(): void {
  (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'] = {
    prepare: async () => undefined,
    commit: (content: Element | null) => {
      const next = content?.querySelector('main');
      if (next) document.querySelector('#__gio main')?.replaceWith(document.importNode(next, true));
    },
  };
}

const announced = (): string | null => document.getElementById('__gio-route-announcer')?.textContent ?? null;

beforeEach(async () => {
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    listeners.push([type, listener]);
    realAddEventListener(type, listener, options);
  }) as typeof window.addEventListener);
  history.replaceState(null, '', '/');
  document.title = 'Start';
  document.body.innerHTML = '<div id="__gio"><main>initial</main></div>';
  setScroll(0, 0);
  vi.spyOn(window, 'scrollTo').mockImplementation(((x: number, y: number) => setScroll(x, y)) as typeof window.scrollTo);
  Element.prototype.scrollIntoView = vi.fn();
  assigned = [];
  reloads = 0;
  const realLocation = window.location;
  // location.assign/replace/reload are not implemented by jsdom: record them.
  vi.stubGlobal('location', {
    get href() { return realLocation.href; },
    get origin() { return realLocation.origin; },
    get pathname() { return realLocation.pathname; },
    get search() { return realLocation.search; },
    get hash() { return realLocation.hash; },
    assign: (url: string) => assigned.push(url),
    replace: (url: string) => assigned.push(`replace:${url}`),
    reload: () => {
      reloads += 1;
    },
  });
  nav = await loadNav();
});

afterEach(() => {
  // Flushes the instance's pending scroll write (its timer would otherwise
  // fire into the next test's history entry).
  window.dispatchEvent(new Event('pagehide'));
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'];
});

describe('navigate: what is rendered in place', () => {
  it('swaps a GioJS page in and pushes its URL', async () => {
    serve({ '/only': () => response({ title: 'Only', body: '<main>only-page</main>' }) });
    const push = vi.spyOn(history, 'pushState');
    await nav.navigate('/only');
    expect(gioText()).toBe('only-page');
    expect(document.title).toBe('Only');
    expect(window.location.pathname).toBe('/only');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('pushes the URL a redirect landed on, not the link href', async () => {
    serve({
      '/old': () =>
        response({
          body: '<main>new home</main>',
          url: '/new?from=old',
          envelope: { props: {}, path: '/new', pattern: '/new', entry: '' },
        }),
    });
    await nav.navigate('/old#part');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/new?from=old#part',
    );
    expect(JSON.parse(document.getElementById('__gio_props')?.textContent ?? '{}').path).toBe('/new');
  });

  it('a redirect to another origin is a full load of that URL', async () => {
    serve({ '/away': () => response({ body: 'x', url: 'https://elsewhere.example/landing' }) });
    await nav.navigate('/away');
    expect(assigned).toEqual(['https://elsewhere.example/landing']);
    expect(gioText()).toBe('initial');
  });

  it('a 503 without the GioJS boundary (Rust error page) is a full load', async () => {
    serve({ '/busy': () => response({ status: 503, body: null }) });
    const push = vi.spyOn(history, 'pushState');
    await nav.navigate('/busy');
    expect(assigned).toEqual(['/busy']);
    expect(gioText()).toBe('initial');
    expect(push).not.toHaveBeenCalled();
  });

  it('a static host 404.html is a full load', async () => {
    serve({ '/never-exported': () => response({ status: 404, body: null }) });
    await nav.navigate('/never-exported');
    expect(assigned).toEqual(['/never-exported']);
  });

  it('a non-HTML response is a full load', async () => {
    serve({ '/api/data': () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }) });
    await nav.navigate('/api/data');
    expect(assigned).toEqual(['/api/data']);
  });

  it('a network error is a full load', async () => {
    serve({});
    await nav.navigate('/offline');
    expect(assigned).toEqual(['/offline']);
  });

  it('a malformed envelope is a full load', async () => {
    serve({ '/broken': () => response({ body: 'b', envelope: '{"props":' }) });
    await nav.navigate('/broken');
    expect(assigned).toEqual(['/broken']);
    expect(gioText()).toBe('initial');
  });

  it('renders a GioJS 404 page in place, under its URL', async () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<script id="__gio_props" type="application/json">{"props":{},"path":"/","pattern":"/","entry":""}</script>',
    );
    serve({ '/missing': () => response({ status: 404, title: 'Not found', body: '<main>custom 404</main>' }) });
    await nav.navigate('/missing');
    expect(assigned).toEqual([]);
    expect(gioText()).toBe('custom 404');
    expect(window.location.pathname).toBe('/missing');
    // The previous route's envelope must not survive on a server-only page.
    expect(document.getElementById('__gio_props')).toBeNull();
  });

  it('a deployment-skew 409 hard-loads the target', async () => {
    serve({
      '/next': () => new Response('', { status: 409, headers: { 'x-gio-action': 'hard-reload' } }),
    });
    await nav.navigate('/next');
    expect(assigned).toEqual([`${window.location.origin}/next`]);
  });

  it('a streamed server-only page with a pending Suspense boundary is a full load', async () => {
    // React streams the resolved content after the shell, outside #__gio,
    // with the script that moves it in (inert in fetched HTML).
    const streamed = (envelope: string): Response =>
      new Response(
        '<!DOCTYPE html><html><head><title>S</title></head><body><div id="__gio"><main><!--$?-->' +
          '<template id="B:0"></template><p>LOADING</p><!--/$--></main></div>' +
          envelope +
          '<div hidden id="S:0"><p>LATE_CONTENT</p></div><script>$RC("B:0","S:0")</script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    const done = (): Response =>
      response({ body: '<main><!--$--><p>RESOLVED</p><!--/$--></main>' });
    serve({
      '/streamed': () => streamed(''),
      '/streamed-envelope': () =>
        streamed(
          '<script id="__gio_props" type="application/json">' +
            '{"props":{},"path":"/streamed-envelope","pattern":"/s","entry":""}</script>',
        ),
      '/resolved': done,
    });
    await nav.navigate('/streamed');
    expect(assigned).toEqual(['/streamed']);
    installLayoutRuntime();
    await nav.navigate('/streamed-envelope');
    expect(assigned).toEqual(['/streamed', '/streamed-envelope']);
    expect(gioText()).toBe('initial');
    expect(window.location.pathname).toBe('/');
    // Boundaries that resolved inside the shell render in place.
    delete (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'];
    await nav.navigate('/resolved');
    expect(gioText()).toBe('RESOLVED');
  });

  it('sends the deployment id the server injected, so a newer build can answer 409', async () => {
    window.__GIO_DEPLOYMENT_ID__ = 'old-build';
    try {
      const fetchMock = serve({
        '/b': () => response({ body: '<main>b</main>' }),
        '/c': () => response({ body: '<main>c</main>' }),
        '/': () => response({ body: '<main>home</main>' }),
      });
      await nav.navigate('/b');
      nav.prefetch('/c');
      await nav.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const call of fetchMock.mock.calls) {
        expect(call[1]?.headers).toMatchObject({ 'x-deployment-id': 'old-build' });
      }
    } finally {
      delete window.__GIO_DEPLOYMENT_ID__;
    }
  });

  it('other origins are full loads; script URLs are refused', async () => {
    serve({});
    await nav.navigate('https://other.example/x');
    expect(assigned).toEqual(['https://other.example/x']);
    await expect(nav.navigate('javascript:alert(1)')).rejects.toThrow(/javascript:/);
    expect(assigned).toHaveLength(1);
  });

  it('replace: true replaces the entry and falls back with location.replace', async () => {
    serve({
      '/r': () => response({ body: '<main>r</main>' }),
      '/gone': () => response({ status: 503, body: null }),
    });
    const push = vi.spyOn(history, 'pushState');
    await nav.navigate('/r', { replace: true });
    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/r');
    await nav.navigate('/gone', { replace: true });
    expect(assigned).toEqual(['replace:/gone']);
  });
});

describe('navigate: the client runtime', () => {
  it('prepares the route chunk first, then commits the swapped envelope', async () => {
    const calls: string[] = [];
    (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'] = {
      prepare: async (entry: string, pattern: string) => {
        calls.push(`prepare ${entry} ${pattern}`);
      },
      commit: (content: Element | null) => {
        const envelope = JSON.parse(document.getElementById('__gio_props')?.textContent ?? '{}');
        calls.push(`commit ${envelope.path} at ${window.location.pathname} with ${content?.id}`);
      },
    };
    serve({
      '/posts/3': () =>
        response({
          body: '<main>p3</main>',
          envelope: { props: {}, path: '/posts/3', pattern: '/posts/:id', entry: '/chunks/posts.js' },
        }),
    });
    await nav.navigate('/posts/3');
    expect(calls).toEqual(['prepare /chunks/posts.js /posts/:id', 'commit /posts/3 at /posts/3 with __gio']);
  });

  it('a chunk that fails to load is a full load, before anything changes', async () => {
    (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'] = {
      prepare: async () => {
        throw new Error('chunk 404');
      },
      commit: vi.fn(),
    };
    serve({
      '/p': () =>
        response({ body: 'p', envelope: { props: {}, path: '/p', pattern: '/p', entry: '/chunks/p.js' } }),
    });
    await nav.navigate('/p');
    expect(assigned).toEqual(['/p']);
    expect(window.location.pathname).toBe('/');
  });

  it('never imports a chunk from another origin', async () => {
    const prepare = vi.fn(async () => undefined);
    (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'] = { prepare, commit: vi.fn() };
    // A backslash reads as a slash to the URL parser import() uses, and a
    // dot segment can normalize into a protocol-relative path.
    const entries = [
      '//cdn.evil/x.js',
      '/\\cdn.evil/x.js',
      '/\\/cdn.evil/x.js',
      'https://cdn.evil/x.js',
      '/.//cdn.evil/x.js',
    ];
    const routes: Record<string, () => Response> = {};
    entries.forEach((entry, i) => {
      routes[`/evil${i}`] = () =>
        response({ body: 'e', envelope: { props: {}, path: `/evil${i}`, pattern: '/evil', entry } });
    });
    routes['/ok'] = () =>
      response({ body: 'o', envelope: { props: {}, path: '/ok', pattern: '/ok', entry: '/chunks/./a/../ok.js?v=1' } });
    serve(routes);
    for (let i = 0; i < entries.length; i++) await nav.navigate(`/evil${i}`);
    expect(assigned).toEqual(entries.map((_, i) => `/evil${i}`));
    expect(prepare).not.toHaveBeenCalled();
    // A same-origin chunk is imported by the normalized path that was judged.
    await nav.navigate('/ok');
    expect(prepare).toHaveBeenCalledWith('/chunks/ok.js?v=1', '/ok');
  });
});

describe('scroll', () => {
  it('push scrolls to the top, or keeps the position with scroll: false', async () => {
    serve({
      '/a': () => response({ body: '<main>a</main>' }),
      '/b': () => response({ body: '<main>b</main>' }),
    });
    setScroll(0, 500);
    await nav.navigate('/a');
    expect(window.scrollY).toBe(0);
    setScroll(0, 300);
    await nav.navigate('/b', { scroll: false });
    expect(window.scrollY).toBe(300);
  });

  it('scrolls to the #hash target of the new page', async () => {
    serve({ '/docs': () => response({ body: '<main><h2 id="install">Install</h2></main>' }) });
    await nav.navigate('/docs#install');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0]).toBe(document.getElementById('install'));
  });

  it('same-page hash links only scroll: no fetch, a new history entry', async () => {
    const fetchMock = serve({});
    document.body.innerHTML = '<div id="__gio"><main><h2 id="faq">FAQ</h2></main></div>';
    await nav.navigate('/#faq');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#faq');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(history.state.__gio.key).toEqual(expect.any(String));
  });

  it('href="#" scrolls to the top without fetching, as the browser does', async () => {
    const fetchMock = serve({});
    setScroll(0, 900);
    await nav.navigate('#');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.scrollY).toBe(0);
    expect(window.location.href).toBe(`${window.location.origin}/#`);
    expect(gioText()).toBe('initial');
  });

  it('a hash link to the URL already shown replaces its entry', async () => {
    serve({});
    document.body.innerHTML = '<div id="__gio"><main><h2 id="faq">FAQ</h2></main></div>';
    const push = vi.spyOn(history, 'pushState');
    await nav.navigate('/#faq');
    await nav.navigate('#faq');
    expect(push).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('back and forward restore the saved position once the page has rendered', async () => {
    serve({
      '/': () => response({ body: '<main>home</main>' }),
      '/list': () => response({ body: '<main>list</main>' }),
      '/item': () => response({ body: '<main>item</main>' }),
    });
    await nav.navigate('/list');
    setScroll(0, 1200);
    await nav.navigate('/item');
    expect(window.scrollY).toBe(0);
    setScroll(0, 40);

    history.back();
    await settle();
    expect(window.location.pathname).toBe('/list');
    expect(gioText()).toBe('list');
    expect(window.scrollY).toBe(1200);

    history.forward();
    await settle();
    expect(gioText()).toBe('item');
    expect(window.scrollY).toBe(40);
  });

  it('back after a plain #anchor link the browser handled restores the position it left', async () => {
    serve({});
    document.body.innerHTML = '<div id="__gio"><main><p id="note">note</p></main></div>';
    // Hovering any GioLink activates the router.
    nav.prefetch('/other');
    userScroll(1200);
    // <a href="#note">: the browser adds a state-less entry and scrolls to
    // the target before hashchange fires.
    history.pushState(null, '', '/#note');
    userScroll(3000);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    userScroll(3100);

    history.back();
    await settle();
    expect(window.location.hash).toBe('');
    expect(window.scrollY).toBe(1200);
    history.forward();
    await settle();
    expect(window.location.hash).toBe('#note');
    expect(window.scrollY).toBe(3100);
  });

  it('the same when the browser reports the #anchor entry with a popstate after scrolling', async () => {
    serve({});
    document.body.innerHTML = '<div id="__gio"><main><p id="note">note</p></main></div>';
    // Scrolled before the router was active: it records where it starts.
    setScroll(0, 800);
    nav.prefetch('/other');
    history.pushState(null, '', '/#note');
    setScroll(0, 3000);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    history.back();
    await settle();
    expect(window.scrollY).toBe(800);
  });

  it('writes the position to history.state once scrolling pauses', async () => {
    serve({});
    nav.prefetch('/other');
    userScroll(640);
    expect(history.state.__gio.scroll).toBeUndefined();
    await new Promise(r => setTimeout(r, 200));
    expect(history.state.__gio.scroll).toEqual([0, 640]);
  });

  it('takes over scroll restoration and saves the position in history.state', async () => {
    serve({ '/x': () => response({ body: '<main>x</main>' }) });
    setScroll(0, 77);
    await nav.navigate('/x');
    expect(history.scrollRestoration).toBe('manual');
    history.back();
    await settle();
    expect(history.state.__gio.scroll).toEqual([0, 77]);
    window.dispatchEvent(new Event('pagehide'));
    expect(history.scrollRestoration).toBe('auto');
  });

  it("keeps the app's own history.state beside the router's", async () => {
    serve({
      '/': () => response({ body: '<main>home</main>' }),
      '/next': () => response({ body: '<main>next</main>' }),
    });
    history.replaceState({ filters: ['a'] }, '');
    setScroll(0, 90);
    await nav.navigate('/next');
    history.back();
    await settle();
    expect(history.state).toMatchObject({ filters: ['a'], __gio: { scroll: [0, 90] } });
  });

  it('a hash-only traversal does not refetch the page', async () => {
    const fetchMock = serve({});
    document.body.innerHTML = '<div id="__gio"><main><h2 id="a">A</h2></main></div>';
    await nav.navigate('/#a');
    history.back();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reloads).toBe(0);
    expect(window.location.hash).toBe('');
  });
});

describe('prefetch cache', () => {
  it('a prefetched page is used within its TTL, refetched after it', async () => {
    const fetchMock = serve({
      '/p': () => response({ body: '<main>p</main>' }),
      '/q': () => response({ body: '<main>q</main>' }),
    });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    nav.prefetch('/p');
    nav.prefetch('/q');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Purpose: 'prefetch' });
    nav.prefetch('/p');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    now += nav.PREFETCH_TTL_MS - 1;
    await nav.navigate('/p');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(gioText()).toBe('p');

    now += 2;
    await nav.navigate('/q');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]?.headers).not.toHaveProperty('Purpose');
    expect(gioText()).toBe('q');
  });

  it('a definitive non-GioJS prefetch is remembered: the click is a full load without refetching', async () => {
    const fetchMock = serve({
      '/report.json': () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    });
    nav.prefetch('/report.json');
    nav.prefetch('/report.json');
    await nav.navigate('/report.json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assigned).toEqual(['/report.json']);
  });

  it("a prefetch the server's budget rejected (429) never decides the click", async () => {
    let calls = 0;
    const fetchMock = serve({
      '/post': () =>
        ++calls === 1 ? new Response(null, { status: 429 }) : response({ title: 'Post', body: '<main>post</main>' }),
    });
    nav.prefetch('/post');
    // Hovering again within the TTL does not hammer the budget.
    nav.prefetch('/post');
    await nav.navigate('/post');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty('Purpose');
    expect(assigned).toEqual([]);
    expect(gioText()).toBe('post');
  });

  it('a prefetch that failed (network error, 404, 503) is fetched again by the click', async () => {
    let up = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (!up) {
        if (path === '/flaky') throw new TypeError('network error');
        return response({ status: path === '/gone' ? 404 : 503, body: '<main>error page</main>' });
      }
      return response({ body: `<main>${path}</main>` });
    });
    vi.stubGlobal('fetch', fetchMock);
    for (const path of ['/flaky', '/gone', '/busy']) nav.prefetch(path);
    await settle();
    up = true;
    for (const path of ['/flaky', '/gone', '/busy']) {
      await nav.navigate(path);
      expect(gioText()).toBe(path);
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(assigned).toEqual([]);
  });

  it('a deployment-skew prefetch never reloads the page; the click is a full load of the new build', async () => {
    const fetchMock = serve({
      '/next': () => new Response('', { status: 409, headers: { 'x-gio-action': 'hard-reload' } }),
    });
    nav.prefetch('/next');
    await settle();
    expect(reloads).toBe(0);
    expect(assigned).toEqual([]);
    expect(gioText()).toBe('initial');
    await nav.navigate('/next');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assigned).toEqual([`${window.location.origin}/next`]);
  });

  it('a same-origin mutation invalidates prefetched pages', async () => {
    const fetchMock = serve({
      '/p': () => response({ body: '<main>p</main>' }),
      '/api/save': () => new Response(null, { status: 204 }),
    });
    nav.prefetch('/p');
    await fetch('/api/save', { method: 'POST' });
    await nav.navigate('/p');
    expect(fetchMock.mock.calls.map(c => String(c[0]))).toEqual(['/p', '/api/save', '/p']);
  });

  it('GET requests and other origins leave the cache alone', async () => {
    const fetchMock = serve({
      '/p': () => response({ body: '<main>p</main>' }),
      '/api/read': () => new Response('{}'),
    });
    nav.prefetch('/p');
    await fetch('/api/read');
    await nav.navigate('/p');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('refresh', () => {
  it('re-fetches the current page past the cache and renders it in place', async () => {
    history.replaceState(null, '', '/feed?page=2');
    setScroll(0, 250);
    let version = 1;
    const fetchMock = serve({ '/feed?page=2': () => response({ body: `<main>v${version++}</main>` }) });
    nav.prefetch('/elsewhere');
    const push = vi.spyOn(history, 'pushState');
    await nav.refresh();
    expect(gioText()).toBe('v1');
    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search).toBe('/feed?page=2');
    expect(window.scrollY).toBe(250);
    const refreshCall = fetchMock.mock.calls.find(c => String(c[0]) === '/feed?page=2');
    expect(refreshCall?.[1]).toMatchObject({ cache: 'no-cache' });
    await nav.refresh();
    expect(gioText()).toBe('v2');
  });
});

describe('accessibility', () => {
  it('moves focus to the new main landmark and announces the title', async () => {
    serve({ '/about': () => response({ title: 'About us', body: '<main>about</main>' }) });
    await nav.navigate('/about');
    const main = document.querySelector('main');
    expect(document.activeElement).toBe(main);
    expect(main?.getAttribute('tabindex')).toBe('-1');
    const region = document.getElementById('__gio-route-announcer');
    expect(region?.getAttribute('aria-live')).toBe('assertive');
    expect(region?.textContent).toBe('About us');
    // Outside the React boundary.
    expect(document.getElementById('__gio')?.contains(region ?? null)).toBe(false);
  });

  it('a query-only replace keeps focus in an input outside the page (search as you type)', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<input id="q">');
    const input = document.getElementById('q') as HTMLInputElement;
    input.focus();
    serve({
      '/?q=b': () => response({ title: 'Search', body: '<main>results b</main>' }),
      '/?q=bo': () => response({ title: 'Search', body: '<main>results bo</main>' }),
    });
    await nav.navigate('/?q=b', { replace: true, scroll: false });
    expect(gioText()).toBe('results b');
    expect(document.activeElement).toBe(input);
    // Only the query changed: nothing to announce.
    expect(announced()).toBe('');
    await nav.navigate('/?q=bo', { replace: true });
    expect(document.activeElement).toBe(input);
  });

  it('typing in a field of a shared layout keeps its focus, also when it leads to another page', async () => {
    installLayoutRuntime();
    document.body.innerHTML = '<div id="__gio"><header><input id="q"></header><main>home</main></div>';
    const input = document.getElementById('q') as HTMLInputElement;
    input.focus();
    serve({
      '/search?q=a': () => response({ title: 'Search', body: '<header></header><main>results a</main>' }),
      '/search?q=ab': () => response({ title: 'Search', body: '<header></header><main>results ab</main>' }),
    });
    await nav.navigate('/search?q=a');
    expect(document.querySelector('main')?.textContent).toBe('results a');
    expect(document.activeElement).toBe(input);
    // A new page is still announced.
    expect(announced()).toBe('Search');
    await nav.navigate('/search?q=ab', { replace: true });
    expect(document.activeElement).toBe(input);
  });

  it('a link of a shared layout that leads to another page: focus moves to the new main', async () => {
    installLayoutRuntime();
    document.body.innerHTML = '<div id="__gio"><nav><a id="about" href="/about">About</a></nav><main>home</main></div>';
    const link = document.getElementById('about') as HTMLAnchorElement;
    link.focus();
    serve({ '/about': () => response({ title: 'About', body: '<nav></nav><main>about</main>' }) });
    await nav.navigate('/about');
    expect(document.activeElement).toBe(document.querySelector('main'));
    expect(announced()).toBe('About');
  });

  it('scroll: false to another page (tabs) leaves focus on the tab', async () => {
    installLayoutRuntime();
    document.body.innerHTML = '<div id="__gio"><nav><a id="tab" href="/billing">Billing</a></nav><main>profile</main></div>';
    const tab = document.getElementById('tab') as HTMLAnchorElement;
    tab.focus();
    serve({ '/billing': () => response({ title: 'Billing', body: '<nav></nav><main>billing</main>' }) });
    await nav.navigate('/billing', { scroll: false });
    expect(document.activeElement).toBe(tab);
    expect(announced()).toBe('Billing');
  });

  it('a query-only navigation that removed the focused element moves focus to main', async () => {
    document.body.innerHTML = '<div id="__gio"><main><button id="more">More</button></main></div>';
    (document.getElementById('more') as HTMLButtonElement).focus();
    serve({ '/?page=2': () => response({ title: 'Page 2', body: '<main>page 2</main>' }) });
    await nav.navigate('/?page=2');
    expect(document.activeElement).toBe(document.querySelector('main'));
    expect(announced()).toBe('');
  });

  it('falls back to the h1 when the page has no title', async () => {
    serve({ '/untitled': () => response({ title: '', body: '<main><h1>Untitled page</h1></main>' }) });
    document.title = '';
    await nav.navigate('/untitled');
    expect(document.getElementById('__gio-route-announcer')?.textContent).toBe('Untitled page');
  });
});

describe('sequencing', () => {
  it('a slow superseded navigation never overwrites the newer page or history', async () => {
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>(r => {
      releaseSlow = r;
    });
    serve({
      '/slow': async () => {
        await slowGate;
        return response({ body: '<main>slow-page</main>' });
      },
      '/fast': () => response({ body: '<main>fast-page</main>' }),
    });
    const push = vi.spyOn(history, 'pushState');

    const first = nav.navigate('/slow');
    await nav.navigate('/fast');
    expect(gioText()).toBe('fast-page');

    releaseSlow();
    await first;
    expect(gioText()).toBe('fast-page');
    expect(window.location.pathname).toBe('/fast');
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('route stylesheets on navigation', () => {
  const styledPage = (marker: string, hrefs: string[]): Response =>
    new Response(
      `<!DOCTYPE html><html lang="en"><head>${hrefs
        .map(href => `<link rel="stylesheet" href="${href}" data-precedence="default"/>`)
        .join('')}<title>${marker}</title></head><body><div id="__gio"><main>${marker}</main></div></body></html>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );

  const headSheets = (): (string | null)[] =>
    [...document.head.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href'));

  const loadSheet = (href: string): void => {
    document.head.querySelector(`link[href="${href}"]`)?.dispatchEvent(new Event('load'));
  };

  beforeEach(() => {
    document.head.innerHTML =
      '<link rel="stylesheet" href="/_next/static/css/root-A.css" data-precedence="default"/>' +
      '<link rel="stylesheet" href="/legacy.css"/>';
  });

  afterEach(() => {
    document.head.innerHTML = '';
    vi.useRealTimers();
  });

  it("loads the next route's new stylesheets before rendering it, in cascade order", async () => {
    serve({
      '/styled': () =>
        styledPage('styled-page', ['/_next/static/css/root-A.css', '/_next/static/css/route-B.css']),
    });
    const done = nav.navigate('/styled');
    await vi.waitFor(() => expect(headSheets()).toContain('/_next/static/css/route-B.css'));
    // Only the missing sheet is added - after the other route stylesheets,
    // never after a hand-written link - and the content waits for it.
    expect(headSheets()).toEqual([
      '/_next/static/css/root-A.css',
      '/_next/static/css/route-B.css',
      '/legacy.css',
    ]);
    await settle();
    expect(gioText()).toBe('initial');
    expect(window.location.pathname).toBe('/');
    loadSheet('/_next/static/css/route-B.css');
    await done;
    expect(gioText()).toBe('styled-page');
    expect(window.location.pathname).toBe('/styled');
  });

  it('the persistent root commits only once the stylesheets have loaded', async () => {
    const commits: string[] = [];
    (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'] = {
      prepare: async () => undefined,
      commit: (content: Element | null) => {
        commits.push(content?.textContent ?? '');
      },
    };
    serve({ '/rooted': () => styledPage('rooted-page', ['/_next/static/css/route-E.css']) });
    const done = nav.navigate('/rooted');
    await vi.waitFor(() => expect(headSheets()).toContain('/_next/static/css/route-E.css'));
    await settle();
    expect(commits).toEqual([]);
    loadSheet('/_next/static/css/route-E.css');
    await done;
    expect(commits).toEqual(['rooted-page']);
  });

  it('finds the stylesheets of a page without a root layout, which open its <body>', async () => {
    serve({
      '/bare': () =>
        new Response(
          '<html><head></head><body><link rel="stylesheet" href="/_next/static/css/route-D.css" data-precedence="default"/>' +
            '<div id="__gio"><main>bare-page</main></div></body></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
    });
    const done = nav.navigate('/bare');
    await vi.waitFor(() => expect(headSheets()).toContain('/_next/static/css/route-D.css'));
    loadSheet('/_next/static/css/route-D.css');
    await done;
    expect(gioText()).toBe('bare-page');
  });

  it("copies the next page's inline style resources (<Animate>'s) this document lacks", async () => {
    const animateStyle = '<style data-precedence="default" data-href="gio-animate">[data-gio-animate]{opacity:0}</style>';
    const animated = (): Response =>
      new Response(
        `<html><head>${animateStyle}<style data-precedence="default" data-href="a b">.ab{}</style></head>` +
          '<body><div id="__gio"><main>animated-page</main></div></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    serve({ '/animated': animated, '/animated?again': animated });
    document.head.firstElementChild?.insertAdjacentHTML(
      'afterend',
      '<style data-precedence="default" data-href="a">.a{}</style>',
    );
    await nav.navigate('/animated');
    expect(gioText()).toBe('animated-page');
    const styles = [...document.head.querySelectorAll('style')].map(s => [s.getAttribute('data-href'), s.textContent]);
    // After the route stylesheets; "a b" is copied for the missing "b".
    expect(styles).toEqual([
      ['a', '.a{}'],
      ['gio-animate', '[data-gio-animate]{opacity:0}'],
      ['a b', '.ab{}'],
    ]);
    expect(document.head.lastElementChild?.getAttribute('href')).toBe('/legacy.css');

    // Already present: not copied again.
    await nav.navigate('/animated?again');
    expect(document.head.querySelectorAll('style[data-href="gio-animate"]')).toHaveLength(1);
  });

  it('renders immediately when every stylesheet is already present', async () => {
    serve({ '/same': () => styledPage('same-page', ['/_next/static/css/root-A.css']) });
    await nav.navigate('/same');
    expect(gioText()).toBe('same-page');
    expect(headSheets()).toHaveLength(2);
  });

  it('back/forward waits for the stylesheets too', async () => {
    serve({
      '/first': () => styledPage('first-page', []),
      '/': () => styledPage('home-page', ['/_next/static/css/route-H.css']),
    });
    await nav.navigate('/first');
    history.back();
    await vi.waitFor(() => expect(headSheets()).toContain('/_next/static/css/route-H.css'));
    await settle();
    expect(gioText()).toBe('first-page');
    loadSheet('/_next/static/css/route-H.css');
    await vi.waitFor(() => expect(gioText()).toBe('home-page'));
  });

  it('renders anyway when a stylesheet never loads', async () => {
    vi.useFakeTimers();
    serve({ '/slow-css': () => styledPage('slow-css-page', ['/_next/static/css/route-C.css']) });
    const done = nav.navigate('/slow-css');
    await vi.waitFor(() => expect(headSheets()).toContain('/_next/static/css/route-C.css'));
    await vi.advanceTimersByTimeAsync(nav.STYLESHEET_WAIT_MS);
    await done;
    expect(gioText()).toBe('slow-css-page');
  });
});
