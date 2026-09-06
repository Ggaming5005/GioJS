// @vitest-environment jsdom
/**
 * packages/giojs-react/src/navigation.test.ts
 *
 * Regression tests for navigation sequencing: only the latest navigation may
 * swap content and push history, so a slow response finishing after a newer
 * click can never clobber the newer page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { navigateTo } from './navigation.ts';

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
