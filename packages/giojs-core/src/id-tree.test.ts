// @vitest-environment jsdom
/**
 * giojs-core/src/id-tree.test.ts
 *
 * useId across the hydration boundary: the server renders #__gio deep in the
 * document (root layout, sibling arrays, useId calls above it), the client
 * hydrates it as a root of its own - and every id inside must still come out
 * the same. Checked against real renders on both sides: renderToString the
 * whole document, hydrateRoot only #__gio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { atBoundaryPosition, hydrationBoundary, ID_TREE_ATTRIBUTE, treeForks, treeIdOf } from './id-tree.ts';

// @ts-expect-error React's act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;

let consoleError: ReturnType<typeof vi.spyOn>;
let root: Root | null = null;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  consoleError.mockRestore();
  document.body.innerHTML = '';
});

/** Form fields labelled through useId, a nested one included. */
function Field({ name }: { name: string }): React.ReactElement {
  const id = React.useId();
  const hint = React.useId();
  return h(
    'p',
    null,
    h('label', { htmlFor: id }, name),
    h('input', { id, 'aria-describedby': hint }),
    h('span', { id: hint }, 'hint'),
  );
}

function Page(): React.ReactElement {
  return h('main', null, h(Field, { name: 'a' }), [h(Field, { key: 'b', name: 'b' }), h(Field, { key: 'c', name: 'c' })]);
}

/** Every useId-derived value in the boundary, in document order. */
function idsIn(container: Element): string[] {
  return [...container.querySelectorAll('[id], [for], [aria-describedby]')].map(el =>
    ['id', 'for', 'aria-describedby'].map(a => el.getAttribute(a) ?? '').join('|'),
  );
}

/** A component that calls useId, then renders its children (a materialized fork). */
function UsesId({ children }: { children?: React.ReactNode }): React.ReactNode {
  React.useId();
  return children;
}

type Wrap = (children: React.ReactNode) => React.ReactNode;

/** Deterministic pseudo-random layout shapes around the boundary. */
function randomLayout(seed: number, minDepth = 1, extraDepth = 7): Wrap {
  let state = seed;
  const next = (n: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  const steps: Wrap[] = [];
  const depth = minDepth + next(extraDepth);
  for (let i = 0; i < depth; i++) {
    const kind = next(4);
    if (kind === 0) {
      // An array of siblings, the slot somewhere in it.
      const total = 1 + next(20);
      const index = next(total);
      steps.push(children =>
        Array.from({ length: total }, (_, j) => (j === index ? h('section', { key: j }, children) : h('i', { key: j }, j))),
      );
    } else if (kind === 1) {
      steps.push(children => h(UsesId, null, children));
    } else if (kind === 2) {
      steps.push(children => h('div', null, h('header', null, 'h'), children, h('footer', null, 'f')));
    } else {
      steps.push(children => h('div', null, children));
    }
  }
  return children => steps.reduceRight<React.ReactNode>((acc, step) => step(acc), children);
}

/** Server: the document as ssr.ts nests it. Client: hydrate #__gio only. */
function renderAndHydrate(
  layout: Wrap,
  page: React.ReactNode = h(Page),
): { server: string[]; client: string[]; treeId: string } {
  const html = renderToString(
    h(
      'html',
      null,
      h(
        'body',
        null,
        layout(h(React.Fragment, null, hydrationBoundary(page), h('script', { type: 'application/json' }), null)),
      ),
    ),
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const serverBoundary = doc.getElementById('__gio');
  if (serverBoundary === null) throw new Error('no boundary');
  document.body.innerHTML = serverBoundary.outerHTML;
  const container = document.getElementById('__gio')!;
  const server = idsIn(container);
  const treeId = container.getAttribute(ID_TREE_ATTRIBUTE) ?? '';
  const recoverable: unknown[] = [];
  act(() => {
    root = hydrateRoot(container, atBoundaryPosition(container.getAttribute(ID_TREE_ATTRIBUTE), page), {
      onRecoverableError: error => recoverable.push(error),
    });
  });
  expect(recoverable).toEqual([]);
  return { server, client: idsIn(container), treeId };
}

describe('useId across the hydration boundary', () => {
  it('hydrates a page under a root layout with the server ids and no warning', () => {
    const layout: Wrap = children => h('div', null, h('nav', null, 'menu'), h(UsesId, null, h('main', null, children)), h('footer', null));
    const { server, client } = renderAndHydrate(layout);
    expect(server.length).toBe(9);
    expect(client).toEqual(server);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('matches without a root layout too', () => {
    const { server, client } = renderAndHydrate(children => children);
    expect(client).toEqual(server);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('matches for many layout shapes', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const { server, client } = renderAndHydrate(randomLayout(seed));
      expect(client, `layout seed ${seed}`).toEqual(server);
      act(() => root?.unmount());
      root = null;
    }
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('matches for layouts deep enough to spill past the 30-bit tree id', () => {
    let spilled = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { server, client, treeId } = renderAndHydrate(randomLayout(seed, 12, 12));
      expect(client, `layout seed ${seed}`).toEqual(server);
      // More than 30 bits of position: React kept some in its overflow string.
      if (treeId.length > 6) spilled++;
      act(() => root?.unmount());
      root = null;
    }
    expect(spilled).toBeGreaterThan(10);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('marks the boundary with its tree position', () => {
    const html = renderToString(h('body', null, h('header', null), hydrationBoundary(h('p', null, 'x'))));
    expect(html).toMatch(new RegExp(`<div id="__gio" ${ID_TREE_ATTRIBUTE}="[0-9a-v]+"><p>x</p></div>`));
  });
});

describe('treeForks', () => {
  it('reads the tree id out of every React 19 useId format', () => {
    expect(treeIdOf('_R_1d_')).toBe('1d');
    expect(treeIdOf('«R1d»')).toBe('1d');
    expect(treeIdOf(':R1d:')).toBe('1d');
  });

  it('needs no fork at the root position (the mark alone)', () => {
    expect(treeForks('1')).toEqual([]);
  });

  it('rebuilds every position bit for bit', () => {
    // 1 (mark) + 01 (slot 1 of 2-3) + 1 (a useId) = 0b1011.
    expect(treeForks((0b1011).toString(32))).toEqual([
      { index: 0, total: 1 },
      { index: 0, total: 2 },
    ]);
    // A slot with zero bits below it: 0b1_100 → slot 4 of an array of 4+.
    expect(treeForks((0b1100).toString(32))).toEqual([{ index: 3, total: 4 }]);
  });

  it('refuses ids it cannot decode or would need huge arrays for', () => {
    expect(treeForks('')).toBeNull();
    expect(treeForks('0')).toBeNull();
    expect(treeForks('_x')).toBeNull();
    // A run of 20 zero bits.
    expect(treeForks((2 ** 21 + 2 ** 20).toString(32))).toBeNull();
  });

  it('falls back to the root position when the attribute is missing or bad', () => {
    for (const treeId of [null, 'zz']) {
      const node = atBoundaryPosition(treeId, 'x');
      expect(React.isValidElement(node)).toBe(true);
    }
  });
});
