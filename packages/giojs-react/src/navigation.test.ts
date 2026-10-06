// @vitest-environment jsdom
/**
 * packages/giojs-react/src/navigation.test.ts
 *
 * Regression tests for navigation sequencing: only the latest navigation may
 * swap content and push history, so a slow response finishing after a newer
 * click can never clobber the newer page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { navigateTo, STYLESHEET_WAIT_MS } from './navigation.ts';

function pageHtml(marker: string): string {
  return `<html><head><title>${marker}</title></head><body><div id="__gio">${marker}</div></body></html>`;
}

interface DeferredFetch {
  response: Promise<Response>;
  resolve: (html: string) => void;
}

function deferredFetch(): DeferredFetch {
  let resolveResponse: (value: Response) => void = () => undefined;
  const response = new Promise<Response>(res => {
    resolveResponse = res;
  });
  return {
    response,
    resolve(html: string): void {
      resolveResponse({
        status: 200,
        headers: { get: (): string | null => null },
        text: async (): Promise<string> => html,
      } as unknown as Response);
    },
  };
}

describe('navigateTo sequencing', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="__gio">initial</div>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('swaps content and pushes history for a single navigation', async () => {
    const only = deferredFetch();
    vi.stubGlobal('fetch', vi.fn(() => only.response));
    const pushSpy = vi.spyOn(history, 'pushState');

    const nav = navigateTo('/only', false);
    only.resolve(pageHtml('only-page'));
    await nav;

    expect(document.getElementById('__gio')?.textContent).toBe('only-page');
    expect(pushSpy).toHaveBeenCalledWith({ gio: true }, '', '/only');
  });

  it('a non-2xx response (static host 404.html) falls back to a full load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 404,
      headers: { get: (): string | null => null },
      text: async (): Promise<string> => '<html><body><h1>404</h1></body></html>',
    }) as unknown as Response));
    const assigned: string[] = [];
    vi.stubGlobal('location', {
      set href(value: string) {
        assigned.push(value);
      },
    });
    const pushSpy = vi.spyOn(history, 'pushState');

    await navigateTo('/never-exported', false);

    expect(assigned).toEqual(['/never-exported']);
    expect(document.getElementById('__gio')?.textContent).toBe('initial');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('a slow superseded navigation never overwrites the newer page or history', async () => {
    const slow = deferredFetch();
    const fast = deferredFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn((href: string) => (href === '/slow' ? slow.response : fast.response)),
    );
    const pushSpy = vi.spyOn(history, 'pushState');

    const firstNav = navigateTo('/slow', false);
    const secondNav = navigateTo('/fast', false);

    fast.resolve(pageHtml('fast-page'));
    await secondNav;
    expect(document.getElementById('__gio')?.textContent).toBe('fast-page');

    // The stale response arrives after the newer navigation already rendered.
    slow.resolve(pageHtml('slow-page'));
    await firstNav;

    expect(document.getElementById('__gio')?.textContent).toBe('fast-page');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith({ gio: true }, '', '/fast');
  });
});

describe('route stylesheets on navigation', () => {
  const styledPage = (marker: string, hrefs: string[]): string =>
    `<html><head>${hrefs
      .map(href => `<link rel="stylesheet" href="${href}" data-precedence="default"/>`)
      .join('')}<title>${marker}</title></head><body><div id="__gio">${marker}</div></body></html>`;

  const headSheets = (): (string | null)[] =>
    [...document.head.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href'));

  beforeEach(() => {
    document.head.innerHTML =
      '<link rel="stylesheet" href="/_next/static/css/root-A.css" data-precedence="default"/>' +
      '<link rel="stylesheet" href="/legacy.css"/>';
    document.body.innerHTML = '<div id="__gio">initial</div>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("loads the next route's new stylesheets before swapping it in, in cascade order", async () => {
    const page = deferredFetch();
    vi.stubGlobal('fetch', vi.fn(() => page.response));
    const nav = navigateTo('/styled', false);
    page.resolve(styledPage('styled-page', ['/_next/static/css/root-A.css', '/_next/static/css/route-B.css']));
    await vi.waitFor(() => expect(headSheets()).toContain('/_next/static/css/route-B.css'));
    // Only the missing sheet is added - after the other route stylesheets,
    // never after a hand-written link - and the content waits for it.
    expect(headSheets()).toEqual([
      '/_next/static/css/root-A.css',
      '/_next/static/css/route-B.css',
      '/legacy.css',
    ]);
    expect(document.getElementById('__gio')?.textContent).toBe('initial');
    document.head.querySelector('link[href="/_next/static/css/route-B.css"]')?.dispatchEvent(new Event('load'));
    await nav;
    expect(document.getElementById('__gio')?.textContent).toBe('styled-page');
  });

  it('finds the stylesheets of a page without a root layout, which open its <body>', async () => {
    const page = deferredFetch();
    vi.stubGlobal('fetch', vi.fn(() => page.response));
    const nav = navigateTo('/bare', false);
    page.resolve(
      '<html><head></head><body><link rel="stylesheet" href="/_next/static/css/route-D.css" data-precedence="default"/>' +
        '<div id="__gio">bare-page</div></body></html>',
    );
    await vi.waitFor(() => expect(headSheets()).toContain('/_next/static/css/route-D.css'));
    document.head.querySelector('link[href="/_next/static/css/route-D.css"]')?.dispatchEvent(new Event('load'));
    await nav;
    expect(document.getElementById('__gio')?.textContent).toBe('bare-page');
  });

  it('swaps immediately when every stylesheet is already present', async () => {
    const page = deferredFetch();
    vi.stubGlobal('fetch', vi.fn(() => page.response));
    const nav = navigateTo('/same', false);
    page.resolve(styledPage('same-page', ['/_next/static/css/root-A.css']));
    await nav;
    expect(document.getElementById('__gio')?.textContent).toBe('same-page');
    expect(headSheets()).toHaveLength(2);
  });

  it('swaps anyway when a stylesheet never loads', async () => {
    vi.useFakeTimers();
    const page = deferredFetch();
    vi.stubGlobal('fetch', vi.fn(() => page.response));
    const nav = navigateTo('/slow-css', false);
    page.resolve(styledPage('slow-css-page', ['/_next/static/css/route-C.css']));
    await vi.waitFor(() => expect(headSheets()).toContain('/_next/static/css/route-C.css'));
    await vi.advanceTimersByTimeAsync(STYLESHEET_WAIT_MS);
    await nav;
    expect(document.getElementById('__gio')?.textContent).toBe('slow-css-page');
  });
});
