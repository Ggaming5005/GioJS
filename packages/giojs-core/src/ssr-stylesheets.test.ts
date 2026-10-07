/**
 * giojs-core/src/ssr-stylesheets.test.ts
 *
 * Route stylesheets (css-build.ts) in the server render: rendered inside
 * #__gio as React stylesheet resources, they land in <head> - the root
 * layout's first, then the route's - on buffered and streamed renders,
 * without a root layout, and on not-found/error pages; and the browser tree
 * built the way generated entries build it hydrates the server HTML with
 * no mismatch.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderRoute, type RenderExtras, type StreamRenderResult } from './ssr.ts';
import type { IPCRequest, IPCResponse } from './context.ts';
import { emptySegmentFiles, type LayoutEntry, type PageModule, type RouteModule } from './router.ts';
import { buildSegmentTree, withStylesheets } from './segment-tree.ts';
import { emptyStyleManifest, segmentStylesheetKey, type StyleManifest } from './style-manifest.ts';

const ROOT_CSS = '/_next/static/css/root-AAAA1111.css';
const DOCS_CSS = '/_next/static/css/route-docs-BBBB2222.css';
const NOT_FOUND_CSS = '/_next/static/css/not-found-root-CCCC3333.css';

function makeRequest(path: string): IPCRequest {
  return {
    id: 'req-1',
    method: 'GET',
    path,
    params: {},
    query: {},
    headers: {},
    body: null,
    bodyBase64: false,
    deploymentId: 'test-deploy',
    locale: 'en',
  };
}

function DocsPage(): React.ReactNode {
  return React.createElement('h1', { className: 'docs_123abc_title' }, 'docs');
}

function DocsLayout({ children }: { children?: React.ReactNode }): React.ReactNode {
  return React.createElement('section', null, children);
}

function RootLayout({ children }: { children?: React.ReactNode }): React.ReactNode {
  return React.createElement(
    'html',
    null,
    React.createElement('head', null, React.createElement('title', null, 'site')),
    React.createElement('body', null, children),
  );
}

function routes(page: Partial<PageModule> = {}): Map<string, RouteModule> {
  return new Map([
    [
      '/docs',
      {
        filePath: '/app/docs/page.tsx',
        urlPattern: '/docs',
        dir: 'docs',
        load: async () => ({ default: DocsPage, ...page }),
      },
    ],
  ]);
}

function layouts(withRoot: boolean): Map<string, LayoutEntry> {
  const map = new Map<string, LayoutEntry>([
    ['docs', { filePath: '/app/docs/layout.tsx', dir: 'docs', load: async () => ({ default: DocsLayout }) }],
  ]);
  if (withRoot) {
    map.set('', { filePath: '/app/layout.tsx', dir: '', load: async () => ({ default: RootLayout }) });
  }
  return map;
}

function manifest(): StyleManifest {
  const styles = emptyStyleManifest();
  styles.routes.set('/docs', [ROOT_CSS, DOCS_CSS]);
  styles.segmentPages.set(segmentStylesheetKey('notFound', ''), [ROOT_CSS, NOT_FOUND_CSS]);
  return styles;
}

async function streamed(result: StreamRenderResult): Promise<string> {
  return result.prefix + (await new Response(result.stream).text()) + result.suffix;
}

/** The <head> of a rendered document. */
function headOf(html: string): string {
  return /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
}

describe('route stylesheets in the server render', () => {
  it('hoists the root and route stylesheets into <head>, root first', async () => {
    const out = (await renderRoute(
      makeRequest('/docs'),
      routes({ revalidate: 60 }),
      layouts(true),
      undefined,
      undefined,
      undefined,
      { stylesheets: manifest() },
    )) as IPCResponse;
    expect(out.status).toBe(200);
    const head = headOf(out.body);
    const root = head.indexOf(`<link rel="stylesheet" href="${ROOT_CSS}" data-precedence="default"/>`);
    const docs = head.indexOf(`<link rel="stylesheet" href="${DOCS_CSS}" data-precedence="default"/>`);
    expect(root).toBeGreaterThanOrEqual(0);
    expect(docs).toBeGreaterThan(root);
    // Nothing stays behind inside the hydration boundary.
    expect(/<div id="__gio"[^>]*>([\s\S]*?)<\/div>/.exec(out.body)?.[1]).not.toContain('<link');
  });

  it('puts them in <head> on streamed renders too', async () => {
    const out = (await renderRoute(
      makeRequest('/docs'),
      routes(),
      layouts(true),
      undefined,
      undefined,
      undefined,
      { stylesheets: manifest(), streaming: true },
    )) as StreamRenderResult;
    expect(out.type).toBe('stream');
    const head = headOf(await streamed(out));
    expect(head).toContain(`href="${ROOT_CSS}"`);
    expect(head).toContain(`href="${DOCS_CSS}"`);
  });

  it('links them ahead of the content when there is no root layout', async () => {
    const out = (await renderRoute(
      makeRequest('/docs'),
      routes({ revalidate: 60 }),
      layouts(false),
      undefined,
      undefined,
      undefined,
      { stylesheets: manifest() },
    )) as IPCResponse;
    const docs = out.body.indexOf(`href="${DOCS_CSS}"`);
    expect(docs).toBeGreaterThan(0);
    expect(docs).toBeLessThan(out.body.indexOf('<div id="__gio" '));
  });

  it('streams them at the top of <body> of a complete document when there is no root layout', async () => {
    const out = (await renderRoute(
      makeRequest('/docs'),
      routes(),
      layouts(false),
      undefined,
      undefined,
      undefined,
      { stylesheets: manifest(), streaming: true },
    )) as StreamRenderResult;
    expect(out.type).toBe('stream');
    const html = await streamed(out);
    expect(html.startsWith('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>')).toBe(true);
    expect(html.endsWith('</body></html>')).toBe(true);
    const body = html.slice(html.indexOf('<body>'));
    const root = body.indexOf(`<link rel="stylesheet" href="${ROOT_CSS}" data-precedence="default"/>`);
    const docs = body.indexOf(`<link rel="stylesheet" href="${DOCS_CSS}" data-precedence="default"/>`);
    expect(root).toBeGreaterThan(0);
    expect(docs).toBeGreaterThan(root);
    expect(docs).toBeLessThan(body.indexOf('<div id="__gio" '));
    expect(/<div id="__gio"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]).not.toContain('<link');
  });

  it('links nothing for routes the manifest does not know', async () => {
    const out = (await renderRoute(
      makeRequest('/docs'),
      routes({ revalidate: 60 }),
      layouts(true),
      undefined,
      undefined,
      undefined,
      { stylesheets: emptyStyleManifest() },
    )) as IPCResponse;
    expect(out.body).not.toContain('rel="stylesheet"');
  });

  it("gives a not-found page its own stylesheets after the root layout's", async () => {
    const segmentFiles = emptySegmentFiles();
    segmentFiles.notFound.set('', {
      kind: 'not-found',
      filePath: '/app/not-found.tsx',
      dir: '',
      load: async () => ({ default: () => React.createElement('p', null, 'missing') }),
    });
    const extras: RenderExtras = { stylesheets: manifest(), segmentFiles };
    const out = (await renderRoute(
      makeRequest('/nope'),
      routes(),
      layouts(true),
      undefined,
      undefined,
      undefined,
      extras,
    )) as IPCResponse;
    expect(out.status).toBe(404);
    const head = headOf(out.body);
    expect(head.indexOf(`href="${ROOT_CSS}"`)).toBeGreaterThanOrEqual(0);
    expect(head.indexOf(`href="${NOT_FOUND_CSS}"`)).toBeGreaterThan(head.indexOf(`href="${ROOT_CSS}"`));
  });

  it('hydrates against the tree a generated entry builds, without a mismatch', async () => {
    const out = (await renderRoute(
      makeRequest('/docs'),
      routes({ revalidate: 60 }),
      layouts(true),
      undefined,
      undefined,
      new Map([['/docs', '/_next/static/chunks/route-docs-X.js']]),
      { stylesheets: manifest() },
    )) as IPCResponse;
    document.documentElement.innerHTML = out.body.replace(/^<!DOCTYPE html><html>|<\/html>$/g, '');
    const container = document.getElementById('__gio');
    expect(container).not.toBeNull();
    const recoverable: unknown[] = [];
    // Attribute mismatches are only console errors, never recoverable ones.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // What client-build.ts generates for this route.
    const tree = withStylesheets(
      buildSegmentTree(React.createElement(DocsPage), '/docs', [{ layout: DocsLayout, error: null, loading: null }]),
      [ROOT_CSS, DOCS_CSS],
    );
    await act(async () => {
      hydrateRoot(container as HTMLElement, tree, {
        onRecoverableError: error => recoverable.push(error),
      });
    });
    consoleError.mockRestore();
    expect(recoverable).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(container?.innerHTML).toBe('<section><h1 class="docs_123abc_title">docs</h1></section>');
    // The server's links were adopted, not duplicated.
    expect(document.head.querySelectorAll(`link[href="${DOCS_CSS}"]`)).toHaveLength(1);
  });

  it('hydrates a page without a root layout, adopting the links in <body>', async () => {
    const out = (await renderRoute(
      makeRequest('/docs'),
      routes({ revalidate: 60 }),
      layouts(false),
      undefined,
      undefined,
      new Map([['/docs', '/_next/static/chunks/route-docs-X.js']]),
      { stylesheets: manifest() },
    )) as IPCResponse;
    // A document of its own: React keeps its stylesheet records per
    // document, and the test above already hydrated these URLs.
    const doc = document.implementation.createHTMLDocument('');
    doc.documentElement.innerHTML = out.body.replace(/^<!DOCTYPE html><html>|<\/html>$/g, '');
    expect(doc.body.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(2);
    const container = doc.getElementById('__gio');
    expect(container).not.toBeNull();
    const recoverable: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tree = withStylesheets(
      buildSegmentTree(React.createElement(DocsPage), '/docs', [{ layout: DocsLayout, error: null, loading: null }]),
      [ROOT_CSS, DOCS_CSS],
    );
    await act(async () => {
      hydrateRoot(container as HTMLElement, tree, {
        onRecoverableError: error => recoverable.push(error),
      });
    });
    consoleError.mockRestore();
    expect(recoverable).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(container?.innerHTML).toBe('<section><h1 class="docs_123abc_title">docs</h1></section>');
    // Found where the server put them, so neither stylesheet loads twice.
    for (const href of [ROOT_CSS, DOCS_CSS]) {
      expect(doc.querySelectorAll(`link[href="${href}"]`)).toHaveLength(1);
    }
  });
});
