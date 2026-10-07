/**
 * packages/giojs-cli/src/migrate-edits.ts
 *
 * Position-based source editing for the Next.js migration. Transforms parse
 * a file with the TypeScript compiler API, then splice text into the
 * original source at AST positions instead of re-printing the tree, so
 * everything the migration does not touch - formatting, comments, quote
 * style - survives byte for byte.
 */
import ts from 'typescript';

/** Marker every inserted TODO carries; the report is built by scanning for it. */
export const TODO_MARKER = 'TODO(gio-migrate):';

interface Edit {
  start: number;
  end: number;
  text: string;
  seq: number;
}

export interface AppliedEdits {
  output: string;
  /** Map an offset in the original source to the matching output offset. */
  mapOffset(offset: number): number;
}

/**
 * Collects non-overlapping replacements and applies them in one pass.
 * Zero-length inserts at the same offset keep their insertion order and land
 * before a replacement that starts there.
 */
export class EditList {
  private edits: Edit[] = [];
  private seq = 0;

  replace(start: number, end: number, text: string): void {
    this.edits.push({ start, end, text, seq: this.seq++ });
  }

  insert(at: number, text: string): void {
    this.replace(at, at, text);
  }

  remove(start: number, end: number): void {
    this.replace(start, end, '');
  }

  get size(): number {
    return this.edits.length;
  }

  /** Whether [start, end) intersects an edit already queued. */
  overlaps(start: number, end: number): boolean {
    return this.edits.some(e => e.end > e.start && start < e.end && end > e.start);
  }

  apply(source: string): AppliedEdits {
    const sorted = [...this.edits].sort(
      (a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start) || a.seq - b.seq,
    );
    let output = '';
    let cursor = 0;
    // [originalEnd, cumulativeDelta] after each edit, for mapOffset.
    const deltas: Array<[number, number]> = [];
    let delta = 0;
    for (const edit of sorted) {
      if (edit.start < cursor) {
        // Two transforms claimed the same text: a bug in a transform, never
        // something the user's input should be able to trigger silently.
        throw new Error(`overlapping migration edits at offset ${edit.start}`);
      }
      output += source.slice(cursor, edit.start) + edit.text;
      cursor = edit.end;
      delta += edit.text.length - (edit.end - edit.start);
      deltas.push([edit.end, delta]);
    }
    output += source.slice(cursor);
    return {
      output,
      mapOffset(offset: number): number {
        // Text inserted exactly at `offset` lands before it: the mapped
        // position is the start of that insert, where the old text began.
        let d = 0;
        for (let i = 0; i < sorted.length; i++) {
          const edit = sorted[i] as Edit;
          if (edit.end > offset || (edit.end === offset && edit.start === edit.end)) break;
          d = (deltas[i] as [number, number])[1];
        }
        return offset + d;
      },
    };
  }
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function lineStart(text: string, offset: number): number {
  const nl = text.lastIndexOf('\n', offset - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** The whitespace indenting the line that contains `offset`. */
export function indentAt(text: string, offset: number): string {
  const start = lineStart(text, offset);
  const match = /^[ \t]*/.exec(text.slice(start, offset));
  return match?.[0] ?? '';
}

/** End of `node` plus the rest of its line when only whitespace follows. */
export function endWithNewline(text: string, end: number): number {
  let i = end;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  if (text[i] === '\r') i++;
  if (text[i] === '\n') return i + 1;
  return end;
}

/** Every TODO line in `text`, with its 1-based line number. */
export function scanTodos(text: string): Array<{ line: number; message: string }> {
  const todos: Array<{ line: number; message: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const at = line.indexOf(TODO_MARKER);
    if (at === -1) continue;
    const message = line
      .slice(at + TODO_MARKER.length)
      .replace(/\*\/\s*\}?\s*$/, '')
      .trim();
    todos.push({ line: i + 1, message });
  }
  return todos;
}

export function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.ts') || fileName.endsWith('.mts') || fileName.endsWith('.cts')) {
    return ts.ScriptKind.TS;
  }
  // Next allows JSX in .js files, so plain JavaScript is parsed as JSX.
  return ts.ScriptKind.JSX;
}

export function parseSource(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
}

/** Syntax errors the parser recovered from; a file with any is left untouched. */
export function parseErrors(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

/**
 * The statement `node` belongs to - the place a `// TODO` line can go
 * without landing inside an expression or JSX.
 */
export function enclosingStatement(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== undefined) {
    const parent = current.parent;
    if (
      ts.isSourceFile(parent) ||
      ts.isBlock(parent) ||
      ts.isModuleBlock(parent) ||
      ts.isCaseClause(parent) ||
      ts.isDefaultClause(parent)
    ) {
      return current;
    }
    current = parent;
  }
  return current;
}

/** Whether `id` reads the binding it names (not a property name, key or attribute). */
export function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === id) return false;
  if (ts.isJsxAttribute(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isExportSpecifier(parent)) return parent.propertyName === id || parent.propertyName === undefined;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === id) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
}

export function forEachDescendant(node: ts.Node, visit: (n: ts.Node) => void): void {
  const walk = (n: ts.Node): void => {
    visit(n);
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
}

/** A string literal or no-substitution template literal's value. */
export function stringValue(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

export function propertyName(name: ts.PropertyName | ts.JsxAttributeName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  return undefined;
}

/**
 * A minimal line diff for --dry-run: common prefix/suffix trimmed, LCS on
 * the middle, printed as unified-style hunks with three lines of context.
 */
export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string): string {
  // An empty file has no lines (not one empty line), so created files show only additions.
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  // ops over the whole file: ' ' keep, '-' delete, '+' add
  const ops: Array<[' ' | '-' | '+', string]> = a.slice(0, prefix).map(l => [' ', l]);
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000) {
    // Too large to align cheaply: show the middle as a block replacement.
    for (const l of midA) ops.push(['-', l]);
    for (const l of midB) ops.push(['+', l]);
  } else {
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const row = lcs[i] as Uint32Array;
      const next = lcs[i + 1] as Uint32Array;
      for (let j = m - 1; j >= 0; j--) {
        row[j] = midA[i] === midB[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push([' ', midA[i] as string]);
        i++;
        j++;
      } else if (((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number)) {
        ops.push(['-', midA[i++] as string]);
      } else {
        ops.push(['+', midB[j++] as string]);
      }
    }
    while (i < n) ops.push(['-', midA[i++] as string]);
    while (j < m) ops.push(['+', midB[j++] as string]);
  }
  for (const l of a.slice(a.length - suffix)) ops.push([' ', l]);

  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  const CONTEXT = 3;
  let k = 0;
  while (k < ops.length) {
    if ((ops[k] as [string, string])[0] === ' ') {
      k++;
      continue;
    }
    const hunkStart = Math.max(0, k - CONTEXT);
    let hunkEnd = k;
    let quiet = 0;
    while (hunkEnd < ops.length && quiet <= CONTEXT * 2) {
      quiet = (ops[hunkEnd] as [string, string])[0] === ' ' ? quiet + 1 : 0;
      hunkEnd++;
    }
    hunkEnd = Math.min(ops.length, hunkEnd - Math.max(0, quiet - CONTEXT));
    let lineA = 1;
    let lineB = 1;
    for (let x = 0; x < hunkStart; x++) {
      const op = (ops[x] as [string, string])[0];
      if (op !== '+') lineA++;
      if (op !== '-') lineB++;
    }
    const hunk = ops.slice(hunkStart, hunkEnd);
    const lenA = hunk.filter(([op]) => op !== '+').length;
    const lenB = hunk.filter(([op]) => op !== '-').length;
    out.push(`@@ -${lenA === 0 ? lineA - 1 : lineA},${lenA} +${lenB === 0 ? lineB - 1 : lineB},${lenB} @@`);
    for (const [op, line] of hunk) out.push(`${op}${line}`);
    k = hunkEnd;
  }
  return out.join('\n');
}
