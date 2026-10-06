// @vitest-environment jsdom
/**
 * giojs-core/src/segment-tree.test.ts
 *
 * The tree inside #__gio as the browser sees it: every folder's error.* is
 * an error boundary that catches render errors below it (never its own
 * folder's layout) and can reset the segment, error details follow the
 * production contract, and the server markup - loading boundaries and
 * probes included - hydrates against the client tree without a mismatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  buildSegmentTree,
  publicErrorInfo,
  type GioErrorProps,
  type SegmentLevel,
} from './segment-tree.ts';
import { notFound } from './not-found.ts';

// @ts-expect-error React's act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function marker(name: string): React.ComponentType<{ children: React.ReactNode }> {
  return function Layout({ children }) {
    return React.createElement('section', { 'data-layout': name }, children);
  };
}

function errorView(name: string): React.ComponentType<GioErrorProps> {
  return function ErrorView({ error, reset }: GioErrorProps) {
    return React.createElement(
      'div',
      { 'data-error': name },
      `${name}: ${error.message}${error.digest !== undefined ? ` (${error.digest})` : ''}`,
      reset !== undefined ? React.createElement('button', { onClick: reset }, 'retry') : null,
    );
  };
}

let container: HTMLElement;
let root: Root | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  // React reports every caught error on the console.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  consoleError.mockRestore();
  vi.unstubAllEnvs();
});

function mount(element: React.ReactNode): void {
  root = createRoot(container);
  act(() => root?.render(element));
}

function click(text: string): void {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === text);
  if (button === undefined) throw new Error(`no "${text}" button in ${container.innerHTML}`);
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

/** Throws while rendering once `explode` is clicked; renders fine again after a reset if `healed`. */
function makeExplodingPage(state: { healed: boolean }): React.ComponentType {
  return function Page() {
    const [exploded, setExploded] = React.useState(false);
    if (exploded && !state.healed) throw new Error('render blew up');
    return React.createElement(
      'main',
      null,
      'PAGE_OK',
      React.createElement('button', { onClick: () => setExploded(true) }, 'explode'),
    );
  };
}

describe('client error boundaries', () => {
  it('catches an error thrown after an event handler changed state, inside the layouts above', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const Page = makeExplodingPage({ healed: false });
    mount(
      buildSegmentTree(React.createElement(Page), '/dash', [
        { error: errorView('ROOT_ERROR') },
        { layout: marker('DASH_LAYOUT'), error: errorView('DASH_ERROR') },
      ]),
    );
    expect(container.textContent).toContain('PAGE_OK');
    click('explode');
    // The nearest boundary replaced only the page; the folder layout stays.
    expect(container.querySelector('[data-layout="DASH_LAYOUT"] [data-error="DASH_ERROR"]')).not.toBeNull();
    expect(container.textContent).toContain('DASH_ERROR: render blew up');
    expect(container.textContent).not.toContain('ROOT_ERROR');
  });

  it('reset() renders the segment again', () => {
    const state = { healed: false };
    const Page = makeExplodingPage(state);
    mount(buildSegmentTree(React.createElement(Page), '/', [{ error: errorView('ERR') }]));
    click('explode');
    expect(container.textContent).toContain('ERR:');
    state.healed = true;
    click('retry');
    expect(container.textContent).toContain('PAGE_OK');
    expect(container.querySelector('[data-error]')).toBeNull();
  });

  it("never catches its own folder's layout - the boundary above does", () => {
    vi.stubEnv('NODE_ENV', 'development');
    const BrokenLayout = (): React.ReactNode => {
      throw new Error('layout broke');
    };
    mount(
      buildSegmentTree(React.createElement('p', null, 'page'), '/dash', [
        { error: errorView('ROOT_ERROR') },
        { layout: BrokenLayout, error: errorView('DASH_ERROR') },
      ]),
    );
    expect(container.querySelector('[data-error="ROOT_ERROR"]')?.textContent).toContain(
      'ROOT_ERROR: layout broke',
    );
    expect(container.querySelector('[data-error="DASH_ERROR"]')).toBeNull();
  });

  it('shows only generic messages in production, with the digest of server errors', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(publicErrorInfo(new Error('client detail'))).toEqual({ message: 'Application Error' });
    const fromServer = Object.assign(new Error('server detail'), { digest: 'abc123def456' });
    expect(publicErrorInfo(fromServer)).toEqual({
      message: 'Internal Server Error',
      digest: 'abc123def456',
    });
    vi.stubEnv('NODE_ENV', 'development');
    expect(publicErrorInfo(fromServer)).toEqual({ message: 'server detail', digest: 'abc123def456' });
    expect(publicErrorInfo('thrown string')).toEqual({ message: 'thrown string' });
  });

  it('labels a notFound() caught in the browser as Not Found', () => {
    const Missing = (): React.ReactNode => notFound();
    mount(buildSegmentTree(React.createElement(Missing), '/', [{ error: errorView('ERR') }]));
    expect(container.textContent).toContain('ERR: Not Found');
  });
});

describe('server markup hydrates against the client tree', () => {
  it('matches with layouts, error and loading boundaries, and probes on the server only', async () => {
    function Page(): React.ReactNode {
      const id = React.useId();
      return React.createElement('label', { htmlFor: id }, `PAGE ${id}`);
    }
    const levels = (probe: boolean): SegmentLevel[] => {
      const noop = { enter: () => undefined, exit: () => undefined };
      return [
        { error: errorView('ROOT_ERROR'), loading: () => React.createElement('p', null, 'ROOT_LOADING'), ...(probe ? { probe: noop } : {}) },
        { layout: marker('DASH_LAYOUT') },
        {
          layout: marker('TEAM_LAYOUT'),
          error: errorView('TEAM_ERROR'),
          loading: () => React.createElement('p', null, 'TEAM_LOADING'),
          ...(probe ? { probe: noop } : {}),
        },
      ];
    };
    const serverHtml = renderToString(buildSegmentTree(React.createElement(Page), '/dash/a', levels(true)));
    expect(serverHtml).toContain('<!--$-->');
    expect(serverHtml).not.toContain('LOADING');
    container.innerHTML = serverHtml;

    const recoverable = vi.fn();
    await act(async () => {
      root = hydrateRoot(
        container,
        buildSegmentTree(React.createElement(Page), '/dash/a', levels(false)),
        { onRecoverableError: recoverable },
      );
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe(serverHtml);
  });
});
