// @vitest-environment jsdom
/**
 * packages/giojs-react/src/Link.test.tsx
 *
 * GioLink's prefetch path: a prefetched page is reused by the click, and a
 * page that cannot be swapped in (404/500) is remembered - hovering it again
 * must not refetch it, and clicking it goes straight to a full load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GioLink } from './Link.tsx';

// @ts-expect-error React 19 act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function htmlResponse(status: number, html: string): Response {
  return {
    status,
    headers: { get: (): string | null => null },
    text: async (): Promise<string> => html,
  } as unknown as Response;
}

/** Let the prefetch's fetch().then().then() chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('GioLink prefetch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  function renderLink(href: string): HTMLAnchorElement {
    act(() => {
      root.render(<GioLink href={href}>go</GioLink>);
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
    vi.stubGlobal('location', {
      pathname: '/',
      search: '',
      set href(value: string) {
        assigned.push(value);
      },
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

  it('a 404 is prefetched once: later hovers do not refetch it, a click hard-navigates', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(404, '<html><body><h1>404</h1></body></html>'));
    vi.stubGlobal('fetch', fetchMock);
    const assigned = captureHardNavigations();
    const anchor = renderLink('/prefetch-missing');

    await hover(anchor);
    await hover(anchor);
    await hover(anchor);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await click(anchor);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assigned).toEqual(['/prefetch-missing']);
    // The 404 document is never swapped in under the new URL.
    expect(document.getElementById('__gio')?.textContent).toBe('initial');
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
});
