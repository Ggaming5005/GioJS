/**
 * giojs-core/src/id-tree.ts
 *
 * Keeps React's useId stable across the hydration boundary.
 *
 * useId derives its value from the component's position in the WHOLE React
 * tree: every array of children and every component that calls useId adds
 * bits to a "tree id" on the way down. The server renders the #__gio subtree
 * deep inside the document (under the root layout, its siblings, ssr.ts's own
 * fragment), but the client hydrates it with hydrateRoot(#__gio), where it
 * sits at the root - so without help every id inside differs, and anything
 * built on them (label htmlFor, aria-*, form ids) mismatches.
 *
 * The fix makes the client start from the same tree position:
 *
 * - The server renders the boundary through two components that call useId
 *   (hydrationBoundary). The first marks the position with a set bit, the
 *   second reads the tree id below that mark and writes it onto the
 *   boundary element as `data-gio-tree`. The mark makes the length of the
 *   position exact: the id's leading zero bits would otherwise be lost.
 * - The client (client-runtime.ts) decodes the attribute into a chain of
 *   child arrays (each forks the tree id exactly like an array in the root
 *   layout did, the unused slots are null and render nothing), then renders
 *   the same two useId components (atBoundaryPosition). Below them the
 *   client's tree position equals the server's bit for bit, so every useId
 *   in the hydrated tree - including inside Suspense holes streamed later -
 *   produces the server's value.
 *
 * Positions deeper than React's 30-bit tree id spill into an overflow string
 * whose split points are not recoverable from a printed id; React then prints
 * the same bits the same way unless one spilled group starts with a zero
 * digit - a root layout would need ~15 nested multi-child levels around
 * `children` for that, and only then can ids still differ.
 *
 * Browser-safe: imports only React.
 */
import React from 'react';

/** The boundary element's attribute holding the server's tree id (base 32). */
export const ID_TREE_ATTRIBUTE = 'data-gio-tree';

/**
 * Widest child array the client builds to reproduce one fork. A position
 * needing more (a long run of zero bits, from very wide arrays in the root
 * layout) is not reproduced: the client hydrates from the root position as
 * before rather than allocate huge arrays on every render.
 */
const MAX_FORK_WIDTH = 1 << 16;

/** One array the client renders: `index` is the slot the tree goes in. */
export interface TreeFork {
  index: number;
  total: number;
}

/**
 * The tree id inside a value useId returned: the trailing run of base-32
 * digits ('_R_1d_' in React 19.2, '«R1d»' in 19.1, ':R1d:' in 19.0 → '1d').
 * Only valid for the first useId call of a component (later calls append an
 * 'H<n>' counter).
 */
export function treeIdOf(reactId: string): string | null {
  const match = /([0-9a-v]+)[^0-9a-v]*$/.exec(reactId);
  return match?.[1] ?? null;
}

/** A useId call whose only job is the tree id bit it materializes. */
function TreeMark({ children }: { children?: React.ReactNode }): React.ReactNode {
  React.useId();
  return children;
}

/** The #__gio element, stamped with the tree id at its position. */
function BoundaryElement({
  children,
}: {
  children?: React.ReactNode;
}): React.ReactElement {
  const treeId = treeIdOf(React.useId());
  return React.createElement(
    'div',
    { id: '__gio', ...(treeId !== null ? { [ID_TREE_ATTRIBUTE]: treeId } : {}) },
    children,
  );
}

/**
 * Server: the `<div id="__gio">` boundary around the hydrated tree, rendered
 * where it sits in the document. The tree inside it is at the position
 * atBoundaryPosition reproduces on the client.
 */
export function hydrationBoundary(children: React.ReactNode): React.ReactElement {
  return React.createElement(TreeMark, null, React.createElement(BoundaryElement, null, children));
}

/**
 * The forks that rebuild the position `treeId` (read by the boundary's
 * second useId, below the first one's mark) on a client root, outermost
 * first. Null when it cannot be decoded or would need an array wider than
 * MAX_FORK_WIDTH.
 */
export function treeForks(treeId: string): TreeFork[] | null {
  if (!/^[0-9a-v]+$/.test(treeId)) return null;
  let value = 0n;
  for (const digit of treeId) value = value * 32n + BigInt(parseInt(digit, 32));
  // The highest set bit is the first mark; everything below it is the
  // position of the boundary itself (newest bits highest).
  if (value === 0n) return null;
  const length = value.toString(2).length - 1;
  const bits = value - (1n << BigInt(length));
  const bit = (at: number): boolean => ((bits >> BigInt(at)) & 1n) === 1n;

  // An array of `total` children puts child `index` at slot index+1, written
  // in bitLength(total) bits above the bits so far. Any non-zero group of k
  // bits is such a slot (total between 2^(k-1) and 2^k - 1), so cut the bits
  // into groups ending at each set bit, low to high.
  const groups: { width: number; slot: number }[] = [];
  let at = 0;
  while (at < length) {
    let zeros = 0;
    while (at + zeros < length && !bit(at + zeros)) zeros++;
    if (at + zeros === length) {
      // Zero bits above the last set one belong to the newest group (its
      // slot is written with leading zeros: a smaller slot in a wider array).
      const last = groups[groups.length - 1];
      if (last === undefined) return null;
      last.width += zeros;
      break;
    }
    groups.push({ width: zeros + 1, slot: 2 ** zeros });
    at += zeros + 1;
  }

  const forks: TreeFork[] = [];
  for (const { width, slot } of groups) {
    // The narrowest array whose length takes `width` bits and has the slot.
    const total = Math.max(slot, 2 ** (width - 1));
    if (total > MAX_FORK_WIDTH) return null;
    forks.push({ index: slot - 1, total });
  }
  return forks;
}

/**
 * Client: `children` at the position the server rendered the boundary's
 * content at - the forks of `treeId` (none when it is null or cannot be
 * reproduced), then the boundary's two useId calls. Render it as the root
 * element of the #__gio root, on hydration and every later render alike, so
 * the root's tree keeps one shape.
 */
export function atBoundaryPosition(
  treeId: string | null,
  children: React.ReactNode,
): React.ReactNode {
  let node: React.ReactNode = React.createElement(
    TreeMark,
    null,
    React.createElement(TreeMark, null, children),
  );
  const forks = treeId !== null ? treeForks(treeId) : null;
  if (forks === null) return node;
  for (let i = forks.length - 1; i >= 0; i--) {
    const fork = forks[i]!;
    const slots: React.ReactNode[] = new Array<React.ReactNode>(fork.total).fill(null);
    slots[fork.index] = React.createElement(React.Fragment, { key: 'gio' }, node);
    node = slots;
  }
  return node;
}
