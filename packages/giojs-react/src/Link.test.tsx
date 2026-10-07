// @vitest-environment jsdom
/**
 * packages/giojs-react/src/Link.test.tsx
 *
 * GioLink's prefetch path: a prefetched page is reused by the click, and a
 * page that cannot be rendered in place is remembered - hovering it again
 * must not refetch it. A definitive answer (a 200 page without the GioJS
 * boundary) sends the click straight to a full load; a failed one (a static
 * 404.html, a 500) is fetched again by the click. `replace`, `scroll` and
 * same-page hash links (href="#" included) go through the router.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GioLink } from './Link.tsx';

// @ts-expect-error React 19 act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function htmlResponse(status: number, html: string): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

/** Let the prefetch's fetch().then().then() chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('GioLink prefetch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    history.replaceState(null, '', '/');
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    document.body.innerHTML = '<div id="__gio">initial</div>';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderLink(href: string, props: { replace?: boolean; scroll?: boolean } = {}): HTMLAnchorElement {
    act(() => {
      root.render(<GioLink href={href} {...props}>go</GioLink>);
    });
    const anchor = container.querySelector('a');
    if (anchor === null) throw new Error('GioLink rendered no anchor');
    return anchor;
  }

  // React synthesizes onMouseEnter from mouseover with an outside relatedTarget.
  async function hover(anchor: HTMLAnchorElement): Promise<void> {
    act(() => {
      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
    });
    await settle();
  }

  async function click(anchor: HTMLAnchorElement): Promise<void> {
    act(() => {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
  }

  function captureHardNavigations(): string[] {
    const assigned: string[] = [];
    const real = window.location;
    vi.stubGlobal('location', {
      get href() { return real.href; },
      get origin() { return real.origin; },
      get pathname() { return real.pathname; },
      get search() { return real.search; },
      get hash() { return real.hash; },
      assign(value: string) {
        assigned.push(value);
      },
    });
    return assigned;
  }

  it('a prefetched page is swapped in on click without fetching it again', async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(200, '<html><body><div id="__gio">prefetched-page</div></body></html>'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const anchor = renderLink('/prefetch-ok');

    await hover(anchor);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click(anchor);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById('__gio')?.textContent).toBe('prefetched-page');
  });

  it('a 404 is prefetched once: later hovers do not refetch it, a click asks again and hard-navigates', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(404, '<html><body><h1>404</h1></body></html>'));
    vi.stubGlobal('fetch', fetchMock);
    const assigned = captureHardNavigations();
    const anchor = renderLink('/prefetch-missing');

    await hover(anchor);
    await hover(anchor);
    await hover(anchor);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await click(anchor);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(assigned).toEqual(['/prefetch-missing']);
    // The 404 document is never swapped in under the new URL.
    expect(document.getElementById('__gio')?.textContent).toBe('initial');
  });

  it('a 200 page without the GioJS boundary is remembered: the click hard-navigates without refetching', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(200, '<html><body><h1>legacy</h1></body></html>'));
    vi.stubGlobal('fetch', fetchMock);
    const assigned = captureHardNavigations();
    const anchor = renderLink('/prefetch-legacy');
    await hover(anchor);
    await click(anchor);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assigned).toEqual(['/prefetch-legacy']);
  });

  it('the marker outlives a remount of the link', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(500, 'boom'));
    vi.stubGlobal('fetch', fetchMock);
    await hover(renderLink('/prefetch-broken'));
    act(() => root.unmount());
    root = createRoot(container);
    await hover(renderLink('/prefetch-broken'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('replace and scroll={false} reach the router', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(200, '<html><body><div id="__gio">next</div></body></html>')));
    const push = vi.spyOn(history, 'pushState');
    const scrollTo = vi.mocked(window.scrollTo);
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
    await click(renderLink('/replaced', { replace: true, scroll: false }));
    expect(document.getElementById('__gio')?.textContent).toBe('next');
    expect(window.location.pathname).toBe('/replaced');
    expect(push).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('a same-page hash link scrolls without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    document.getElementById('__gio')?.insertAdjacentHTML('beforeend', '<h2 id="details">d</h2>');
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const anchor = renderLink('#details');
    await hover(anchor);
    await click(anchor);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#details');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('href="#" scrolls to the top without fetching the page again', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const scrollTo = vi.mocked(window.scrollTo);
    Object.defineProperty(window, 'scrollY', { value: 700, configurable: true });
    await click(renderLink('#'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.getElementById('__gio')?.textContent).toBe('initial');
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });
});
