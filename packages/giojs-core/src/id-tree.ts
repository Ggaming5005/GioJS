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
 * Positions longer than React's 30-bit tree id spill their oldest bits into
 * an overflow string, a chunk of whole base-32 digits at a time, each chunk
 * printed with toString(32) - so a chunk whose top digit is zero loses that
 * digit. Where React splits depends on how the bits were grouped into forks
 * on the way down, and the printed id does not record it, so the client
 * cannot replay the server's splits: its own forks spill at other offsets.
 * Grouped the plain way (cut at each set bit), one of the client's chunks
 * can then start with a zero digit the server printed inside a chunk, and
 * the client prints one '0' fewer in every id of the tree. That takes a
 * position over 30 bits and a run of five zero bits, i.e. a slot in an
 * array of 8+ children - a few levels of wide arrays around `children` get
 * there (about 1 in 100 random deep layouts with arrays up to 200 wide).
 * treeForks therefore picks the grouping so that none of the client's
 * spills drops a digit, and the boundary prints exactly the server's id.
 *
 * Known limit: the printed id does not say how many bits the server still
 * held below its overflow at the boundary either, and the client may hold
 * a different number. The page's own forks then spill at different points
 * on the two sides, and an id can still differ when one of those spills
 * puts a zero digit (from the layout's or the page's wide arrays) at the
 * top of a chunk. It needs a position over 30 bits at the boundary and
 * slots in arrays of 8+ in the layout or the page: 1 in 1500 of those
 * random layouts around a small form page (16 before the grouping search;
 * id-tree.test.ts keeps one as a known failure), more under deep pages
 * full of wide lists. Fixing it would take the server reporting that
 * length. A tree whose arrays all have at most 7 children never forms a
 * run of five zero bits, so it always matches.
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

/** The widest fork, in tree id bits (an array of MAX_FORK_WIDTH children). */
const MAX_FORK_BITS = 32 - Math.clz32(MAX_FORK_WIDTH);

/**
 * The longest position treeForks rebuilds (the search recurses once per
 * fork). Hundreds of nested forks above the boundary - far past any layout.
 */
const MAX_POSITION_BITS = 2048;

/**
 * React's tree id after pushing a `width`-bit fork (`value` = slot) onto
 * `low` (the `length` bits not yet spilled into the overflow string), as
 * pushTreeContext/pushTreeId do it - or null when that push spills a chunk
 * whose top base-32 digit is zero, which the printed id would drop.
 */
function pushBits(
  low: number,
  length: number,
  value: number,
  width: number,
): { low: number; length: number } | null {
  if (length + width <= 30) return { low: low | (value << length), length: length + width };
  const spilled = length - (length % 5);
  if (spilled === 0 || ((low >>> (spilled - 5)) & 31) === 0) return null;
  const kept = length - spilled;
  return { low: (low >>> spilled) | (value << kept), length: kept + width };
}

/**
 * The forks that rebuild the position `treeId` (read by the boundary's
 * second useId, below the first one's mark) on a client root, outermost
 * first, chosen so that no overflow spill on the way - the boundary's two
 * useId calls after them included - drops a digit. Null when it cannot be
 * decoded, is longer than MAX_POSITION_BITS or would need an array wider
 * than MAX_FORK_WIDTH.
 */
export function treeForks(treeId: string): TreeFork[] | null {
  if (!/^[0-9a-v]+$/.test(treeId)) return null;
  let value = 0n;
  for (const digit of treeId) value = value * 32n + BigInt(parseInt(digit, 32));
  // The highest set bit is the first mark; everything below it is the
  // position of the boundary itself (newest bits highest).
  if (value === 0n) return null;
  const length = value.toString(2).length - 1;
  if (length > MAX_POSITION_BITS) return null;
  const bits: number[] = [];
  for (let at = 0; at < length; at++) bits.push(Number((value >> BigInt(at)) & 1n));

  // An array of `total` children puts child `index` at slot index+1, written
  // in bitLength(total) bits above the bits so far. Any non-zero group of w
  // bits is such a slot (total between 2^(w-1) and 2^w - 1), so the bits can
  // be cut into groups in many ways; they all print the same id while it
  // fits in 30 bits. Past that, the cuts decide where React spills, so search
  // them depth-first: the plain cut (each group ends at its first set bit)
  // first, wider groups when a spill would drop a digit. A state is the bits
  // consumed plus how many of them are still unspilled (that fixes their
  // value), so dead ends are remembered by that pair.
  const forks: TreeFork[] = [];
  const deadEnds = new Set<number>();
  const search = (at: number, low: number, unspilled: number): boolean => {
    if (at === length) {
      // The boundary's own two useId calls (TreeMark, TreeMark) push a set
      // bit each.
      const marked = pushBits(low, unspilled, 1, 1);
      return marked !== null && pushBits(marked.low, marked.length, 1, 1) !== null;
    }
    const key = at * 32 + unspilled;
    if (deadEnds.has(key)) return false;
    let zeros = 0;
    while (at + zeros < length && bits[at + zeros] === 0) zeros++;
    // Zero bits above the last set one belong to the newest group (its
    // slot is written with leading zeros: a smaller slot in a wider array).
    const narrowest = at + zeros === length ? length - at : zeros + 1;
    let slot = 0;
    for (let i = 0; i < narrowest - 1; i++) slot |= bits[at + i]! << i;
    for (let width = narrowest; width <= Math.min(MAX_FORK_BITS, length - at); width++) {
      slot |= bits[at + width - 1]! << (width - 1);
      // The narrowest array whose length takes `width` bits and has the slot.
      const total = Math.max(slot, 2 ** (width - 1));
      if (slot === 0 || total > MAX_FORK_WIDTH) continue;
      const next = pushBits(low, unspilled, slot, width);
      if (next === null) continue;
      forks.push({ index: slot - 1, total });
      if (search(at + width, next.low, next.length)) return true;
      forks.pop();
    }
    deadEnds.add(key);
    return false;
  };
  return search(0, 0, 0) ? forks : null;
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
