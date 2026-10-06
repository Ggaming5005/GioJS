// @vitest-environment jsdom
/**
 * giojs-core/src/metadata-navigation.test.ts
 *
 * Head metadata across a real hydration and a GioLink soft navigation, in
 * jsdom: the server renders page A (tags hoisted into <head>), the client
 * runtime hydrates it, then @gio.js/react's navigateTo swaps in page B's
 * server HTML and the runtime mounts B. Exactly B's tags must be in the
 * head afterwards - React removes A's (including fields B inherits from the
 * layout with a different value) and inserts B's - and nothing may be
 * duplicated along the way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { renderRoute } from './ssr.ts';
import { buildSegmentTree } from './segment-tree.ts';
import type { IPCRequest } from './context.ts';
import type { LayoutEntry, LayoutModule, PageModule, RouteModule } from './router.ts';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

// Loaded by path so this package's tsc (rootDir: src) never compiles the
// other package; vitest resolves it like any module.
const NAVIGATION_MODULE = '../../giojs-react/src/navigation.ts';

interface NavigationModule {
  navigateTo(href: string, transition: false): Promise<void>;
}

function makeRequest(path: string): IPCRequest {
  return {
    id: 'nav',
    method: 'GET',
    path,
    params: {},
    query: {},
    headers: {},
    body: null,
    bodyBase64: false,
    deploymentId: 'test',
    locale: 'en',
  };
}

function PageA(): React.ReactElement {
  return React.createElement('p', null, 'PAGE_A');
}
function PageB(): React.ReactElement {
  return React.createElement('p', null, 'PAGE_B');
}

const pageModules: Record<string, PageModule> = {
  '/a': {
    default: PageA,
    metadata: {
      title: 'A',
      description: 'about A',
      openGraph: { title: 'OG A', images: '/a.png' },
    },
  },
  '/b': {
    default: PageB,
    metadata: { title: 'B', alternates: { canonical: '/b' } },
  },
};

function routes(): Map<string, RouteModule> {
  const map = new Map<string, RouteModule>();
  for (const [pattern, mod] of Object.entries(pageModules)) {
    map.set(pattern, { filePath: `/app${pattern}/page.tsx`, urlPattern: pattern, dir: pattern.slice(1), load: async () => mod });
  }
  return map;
}

/** A root layout that still hand-writes a <title> (metadata supersedes it). */
function rootLayout(withHead: boolean): Map<string, LayoutEntry> {
  const mod: LayoutModule = {
    default: ({ children }) =>
      React.createElement(
        'html',
        null,
        React.createElement(
          'head',
          null,
          React.createElement('meta', { charSet: 'utf-8' }),
          React.createElement('title', null, 'Hand-written'),
        ),
        React.createElement('body', null, children),
      ),
    metadata: { title: { default: 'Site', template: '%s | Site' }, description: 'root desc' },
  };
  return withHead
    ? new Map([['', { filePath: '/app/layout.tsx', dir: '', load: async () => mod }]])
    : new Map();
}

const clientScripts = new Map([
  ['/a', '/_next/static/chunks/a.js'],
  ['/b', '/_next/static/chunks/b.js'],
]);

async function serverHtml(path: string, withRootLayout: boolean): Promise<string> {
  const result = await renderRoute(
    makeRequest(path),
    routes(),
    rootLayout(withRootLayout),
    undefined,
    undefined,
    clientScripts,
  );
  if (!('body' in result)) throw new Error('expected a buffered render');
  return result.body;
}

/** Load a server document into jsdom (scripts never run). */
function loadDocument(html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.replaceChild(document.adoptNode(parsed.documentElement), document.documentElement);
}

/** The build function a generated entry registers (no non-root layouts here). */
function build(Page: React.ComponentType) {
  return (props: Record<string, unknown>, path: string): React.ReactNode =>
    buildSegmentTree(React.createElement(Page, props), path, []);
}

function headSummary(): string[] {
  const tags = document.head.querySelectorAll('title, meta[name], meta[property], link:not([rel=modulepreload])');
  return [...tags].map(el => {
    if (el.tagName === 'TITLE') return `title=${el.textContent}`;
    const key = el.getAttribute('name') ?? el.getAttribute('property') ?? el.getAttribute('rel');
    return `${key}=${el.getAttribute('content') ?? el.getAttribute('href')}`;
  });
}

describe('metadata across hydration and soft navigation', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  // Each case loads a fresh client runtime, but jsdom's window is shared by
  // the file: the previous runtime's gio:navigated listener must go, or it
  // would mount its own copy of the next page.
  const windowListeners: Array<[string, EventListenerOrEventListenerObject]> = [];
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GIO_SITE_URL', 'https://example.com');
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const addEventListener = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener !== null) windowListeners.push([type, listener]);
      addEventListener(type, listener, options);
    });
  });
  afterEach(() => {
    for (const [type, listener] of windowListeners.splice(0)) {
      window.removeEventListener(type, listener);
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  for (const withRootLayout of [true, false]) {
    it(`replaces the previous page's tags (${withRootLayout ? 'root layout <head>' : 'no root layout'})`, async () => {
      const htmlA = await serverHtml('/a', withRootLayout);
      const htmlB = await serverHtml('/b', withRootLayout);
      loadDocument(htmlA);
      window.history.replaceState(null, '', '/a');

      // Without a root layout there is no template or inherited description.
      const suffix = withRootLayout ? ' | Site' : '';
      const expectedA = [
        `title=A${suffix}`,
        'description=about A',
        'og:title=OG A',
        'og:image=https://example.com/a.png',
      ];
      // Server HTML: one title (the hand-written one is gone), A's tags in <head>.
      expect(headSummary()).toEqual(expectedA);

      const runtime = await import('./client-runtime.ts');
      await act(async () => {
        runtime.registerRoute('/a', build(PageA));
      });
      // Hydration adopted the server's head elements - nothing added.
      expect(headSummary()).toEqual(expectedA);
      expect(document.getElementById('__gio')?.textContent).toBe('PAGE_A');

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(htmlB, { status: 200, headers: { 'content-type': 'text/html' } })),
      );
      const navigation = (await import(/* @vite-ignore */ NAVIGATION_MODULE)) as NavigationModule;
      await act(async () => {
        await navigation.navigateTo('/b', false);
      });
      // B's entry chunk loads (dynamic import in the real browser) and registers.
      await act(async () => {
        runtime.registerRoute('/b', build(PageB));
      });

      expect(document.getElementById('__gio')?.textContent).toBe('PAGE_B');
      expect(headSummary()).toEqual([
        `title=B${suffix}`,
        ...(withRootLayout ? ['description=root desc'] : []),
        'canonical=https://example.com/b',
      ]);
      expect(document.title).toBe(`B${suffix}`);
      // No hydration mismatch (or any other React error) along the way.
      expect(consoleError).not.toHaveBeenCalled();
    });
  }
});
