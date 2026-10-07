// @vitest-environment jsdom
/**
 * packages/giojs-react/src/Animate.test.tsx
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { Animate, SERVER_ONLY_ANIMATE_SCRIPT } from './Animate.tsx';
import { initAnimateObserver, observeElement } from './animate-observer.ts';
import { renderScopeContext, type GioRenderScope } from './render-scope.ts';

// Required for React 19 act() to work in non-browser environments.
// @ts-expect-error global React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Default IntersectionObserver stub - jsdom does not implement it.
const mockObserve = vi.fn();
const mockUnobserve = vi.fn();

beforeAll(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe = mockObserve;
    unobserve = mockUnobserve;
    disconnect = vi.fn();
    constructor(public callback: IntersectionObserverCallback, public options?: IntersectionObserverInit) {}
  });
});

// ── animate-observer.ts ────────────────────────────────────────────────────

describe('animate-observer', () => {
  it('initAnimateObserver is a no-op when window is undefined', () => {
    const original = globalThis.window;
    // @ts-expect-error intentional SSR simulation
    delete globalThis.window;
    expect(() => initAnimateObserver()).not.toThrow();
    globalThis.window = original;
  });

  it('observeElement is a no-op when window is undefined', () => {
    const original = globalThis.window;
    // @ts-expect-error intentional SSR simulation
    delete globalThis.window;
    const el = document.createElement('div');
    expect(() => observeElement(el)).not.toThrow();
    globalThis.window = original;
  });
});

// ── Animate component ──────────────────────────────────────────────────────

describe('Animate component', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    mockObserve.mockClear();
    mockUnobserve.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function render(ui: React.ReactElement): void {
    act(() => {
      createRoot(container).render(ui);
    });
  }

  it('renders children with data-gio-animate set to the enter preset', () => {
    render(<Animate enter="fade-up"><span>hello</span></Animate>);
    const el = container.querySelector('[data-gio-animate]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-gio-animate')).toBe('fade-up');
    expect(el?.textContent).toBe('hello');
  });

  it('applies duration and delay as CSS custom properties', () => {
    render(<Animate enter="zoom-in" duration={600} delay={100}><p>test</p></Animate>);
    const el = container.querySelector('[data-gio-animate]') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el?.style.getPropertyValue('--gio-duration')).toBe('600ms');
    expect(el?.style.getPropertyValue('--gio-delay')).toBe('100ms');
  });

  it('sets entered state immediately when when="immediate"', () => {
    render(<Animate enter="fade-in" when="immediate"><p>now</p></Animate>);
    const el = container.querySelector('[data-gio-animate]') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el?.dataset['gioAnimateState']).toBe('entered');
  });

  it('does not set entered state for when="visible" before observer fires', () => {
    render(<Animate enter="slide-right" when="visible"><p>scroll</p></Animate>);
    const el = container.querySelector('[data-gio-animate]') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el?.dataset['gioAnimateState']).toBeUndefined();
    expect(mockObserve).toHaveBeenCalledWith(el);
  });

  it('renders a <style> tag containing the animate keyframes and reduced-motion override', () => {
    render(<Animate enter="fade-down"><div>x</div></Animate>);
    // React 19 may hoist style tags; check the document.
    const styles = Array.from(document.querySelectorAll('style'));
    const animateStyle = styles.find(s => s.textContent?.includes('__gio-fade-down'));
    expect(animateStyle).not.toBeUndefined();
    expect(animateStyle?.textContent).toContain('prefers-reduced-motion');
  });
});

// ── HTML that never hydrates (the root layout) ─────────────────────────────

describe('Animate outside a hydrating tree', () => {
  function serverHtml(scope: GioRenderScope | null, ui: React.ReactElement): string {
    const Provider = renderScopeContext().Provider;
    return renderToString(scope === null ? ui : <Provider value={scope}>{ui}</Provider>);
  }

  let container: HTMLDivElement;

  beforeEach(() => {
    mockObserve.mockClear();
    delete (window as unknown as Record<string, unknown>)['__GIO_ANIMATE__'];
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  /**
   * Put the server HTML in the document and run its inline scripts in order,
   * as the parser would (jsdom here runs none): document.currentScript is
   * the script, so its previous sibling is the element.
   */
  function load(html: string): HTMLElement[] {
    container.innerHTML = html;
    for (const script of Array.from(container.querySelectorAll('script'))) {
      new Function('document', script.textContent ?? '')({ currentScript: script });
    }
    return Array.from(container.querySelectorAll<HTMLElement>('[data-gio-animate]'));
  }

  it('renders a nonced inline script that observes the element in place of the effect', () => {
    const html = serverHtml(
      { hydrating: false, nonce: 'N0NCE' },
      <Animate enter="fade-up"><span id="a">A</span></Animate>,
    );
    expect(html).toContain(`<script nonce="N0NCE">${SERVER_ONLY_ANIMATE_SCRIPT}0)</script>`);
    const [el] = load(html);
    expect(mockObserve.mock.calls).toEqual([[el]]);
    expect(el?.dataset['gioAnimateState']).toBeUndefined();
  });

  it('when="immediate" enters at once, and one observer serves every element', () => {
    const html = serverHtml(
      { hydrating: false },
      <>
        <Animate enter="fade-in" when="immediate"><span>now</span></Animate>
        <Animate enter="fade-in"><span>one</span></Animate>
        <Animate enter="fade-in"><span>two</span></Animate>
      </>,
    );
    const [now, one, two] = load(html);
    expect(now?.dataset['gioAnimateState']).toBe('entered');
    expect(mockObserve.mock.calls).toEqual([[one], [two]]);
  });

  it('renders no script in a hydrating tree, in the browser, or outside a GioJS render', () => {
    const ui = <Animate enter="fade-up"><span>x</span></Animate>;
    expect(serverHtml({ hydrating: true }, ui)).not.toContain('<script');
    expect(serverHtml(null, ui)).not.toContain('<script');
  });
});
