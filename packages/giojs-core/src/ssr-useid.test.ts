// @vitest-environment jsdom
/**
 * giojs-core/src/ssr-useid.test.ts
 *
 * useId through the real pipeline: renderRoute renders a page under a root
 * layout (which never hydrates, and puts #__gio deep in the document), the
 * client runtime hydrates #__gio from that HTML - and the ids the page's
 * fields got on the server are the ones the client computes, with no
 * hydration warning. The regression: every useId inside #__gio differed,
 * because the server rendered it at another tree position than hydrateRoot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { renderRoute } from './ssr.ts';
import { withStylesheets, type SegmentLevel } from './segment-tree.ts';
import type { IPCRequest } from './context.ts';
import type { LayoutEntry, LayoutModule, RouteModule } from './router.ts';

// @ts-expect-error React's act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;

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

function request(path: string): IPCRequest {
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

/** A field labelled through useId; shows the id the client computed. */
function Field({ name }: { name: string }): React.ReactElement {
  const id = React.useId();
  const [clientId, setClientId] = React.useState('');
  React.useEffect(() => setClientId(id), [id]);
  return h(
    'p',
    null,
    h('label', { htmlFor: id }, name),
    h('input', { id, name }),
    h('output', { 'data-for': name }, clientId),
  );
}

function FormPage(): React.ReactElement {
  return h('form', null, h(Field, { name: 'email' }), h(Field, { name: 'password' }));
}

function UsesId({ children }: { children?: React.ReactNode }): React.ReactNode {
  React.useId();
  return children;
}

/** A root layout with siblings and its own useId call around `children`. */
function RootLayout({ children }: { children?: React.ReactNode }): React.ReactElement {
  return h(
    'html',
    { lang: 'en' },
    h('head', null, h('meta', { charSet: 'utf-8' })),
    h(
      'body',
      null,
      h('header', null, h('nav', null, 'menu')),
      h(UsesId, null, h('div', { className: 'shell' }, h('aside', null, 'side'), h('main', null, children))),
      h('footer', null, 'footer'),
    ),
  );
}

function routes(): Map<string, RouteModule> {
  return new Map([
    ['/signup', { filePath: '/fake/signup/page.tsx', urlPattern: '/signup', dir: 'signup', load: async () => ({ default: FormPage }) }],
  ]);
}

function rootLayout(): Map<string, LayoutEntry> {
  return new Map([
    ['', { filePath: '/fake/layout.tsx', dir: '', load: async (): Promise<LayoutModule> => ({ default: RootLayout }) }],
  ]);
}

/** Render on the server, load the HTML, hydrate it with the client runtime. */
async function renderAndHydrate(layouts: Map<string, LayoutEntry>): Promise<string[]> {
  const result = await renderRoute(request('/signup'), routes(), layouts, undefined, undefined, new Map([['/signup', '/signup.js']]));
  const html = 'body' in result ? result.body : '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
  const serverIds = [...document.querySelectorAll('#__gio input')].map(input => input.id);
  // The browser gets its own navigation context object: sharing the
  // server's (both renderers in one process) only makes React warn.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('gio.navigation-context')];
  const runtime = await import('./client-runtime.ts');
  const levels: SegmentLevel[] = [];
  await act(async () => {
    // What the generated entry for app/signup/page.tsx registers.
    runtime.registerRoute('/signup', (props, path) =>
      withStylesheets(runtime.buildSegmentTree(h(FormPage, props), path, levels), []),
    );
  });
  return serverIds;
}

describe('useId in a server-rendered page', () => {
  it('hydrates under a root layout with the ids the server rendered', async () => {
    const serverIds = await renderAndHydrate(rootLayout());
    expect(serverIds).toHaveLength(2);
    expect(new Set(serverIds).size).toBe(2);
    expect(document.getElementById('__gio')?.getAttribute('data-gio-tree')).toMatch(/^[0-9a-v]+$/);
    const clientIds = [...document.querySelectorAll('#__gio output')].map(output => output.textContent);
    expect(clientIds).toEqual(serverIds);
    const labels = [...document.querySelectorAll('#__gio label')].map(label => label.getAttribute('for'));
    expect(labels).toEqual(serverIds);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('hydrates without a root layout too', async () => {
    const serverIds = await renderAndHydrate(new Map());
    const clientIds = [...document.querySelectorAll('#__gio output')].map(output => output.textContent);
    expect(clientIds).toEqual(serverIds);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
