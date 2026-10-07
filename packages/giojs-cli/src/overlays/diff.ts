/**
 * giojs-cli/src/overlays/diff.ts
 *
 * A compact line diff for conflict hints: when `add` refuses to overwrite a
 * file the user changed, it shows what the overlay would have written. LCS
 * over lines, printed as -/+ lines with a little context and capped, since
 * it is a hint, not a patch to apply.
 */

export function lineDiff(current: string, next: string, maxLines = 24): string[] {
  const a = current.split('\n');
  const b = next.split('\n');
  // Overlay files are small; an O(n*m) table is fine. Bail out to a plain
  // summary for anything large instead of allocating a huge table.
  if (a.length * b.length > 250_000) {
    return [`  (${a.length} lines in the project, ${b.length} in the overlay)`];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: Array<{ kind: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] as string });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      // Removals first, like git: the user's lines are what the hint is about.
      ops.push({ kind: '-', line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] as string });
      j++;
    }
  }

  // Keep changed lines plus one line of context around each.
  const changed = (index: number): boolean => {
    const op = ops[index];
    return op !== undefined && op.kind !== ' ';
  };
  const keep = ops.map((_, index) => changed(index) || changed(index - 1) || changed(index + 1));
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      if (!skipped) out.push('  ...');
      skipped = true;
      return;
    }
    skipped = false;
    out.push(`${op.kind} ${op.line}`);
  });
  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), `  ... (${out.length - maxLines} more lines)`];
  }
  return out;
}
