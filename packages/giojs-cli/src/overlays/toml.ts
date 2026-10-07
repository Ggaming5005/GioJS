/**
 * giojs-cli/src/overlays/toml.ts
 *
 * Line-based gio.toml additions that never clobber what is there. A TOML
 * file may declare a `[table]` only once, so a key goes into the existing
 * table when there is one (and an array value merges with the one already
 * set); `[[table]]` entries are appended unless one with the same `path`
 * exists. Comments, ordering and formatting of everything else are kept
 * byte for byte - the file is the user's.
 *
 * The parser understands what gio.toml uses: headers, `key = value` lines,
 * single-line string arrays and comments. Anything it cannot merge safely
 * (a multi-line array, a non-array value) is reported instead of rewritten.
 */
import type { TomlArrayEntry, TomlKey } from './types.js';

const HEADER = /^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(?:#.*)?$/;
const ARRAY_HEADER = /^\s*\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]\s*(?:#.*)?$/;

interface Section {
  /** `[name]` or `[[name]]`; the root section (before any header) has name ''. */
  name: string;
  array: boolean;
  /** Index of the header line (-1 for the root section). */
  start: number;
  /** Index one past the section's last line. */
  end: number;
}

function sections(lines: readonly string[]): Section[] {
  const found: Section[] = [{ name: '', array: false, start: -1, end: lines.length }];
  lines.forEach((line, index) => {
    const array = ARRAY_HEADER.exec(line);
    const table = array === null ? HEADER.exec(line) : null;
    const name = array?.[1] ?? table?.[1];
    if (name === undefined) return;
    const previous = found[found.length - 1];
    if (previous !== undefined) previous.end = index;
    found.push({ name, array: array !== null, start: index, end: lines.length });
  });
  return found;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function renderArray(values: readonly string[]): string {
  return `[${values.map(quote).join(', ')}]`;
}

/**
 * The section's last key line, so additions sit right under its content.
 * Trailing comments are skipped: they usually introduce the next table.
 */
function lastContentLine(lines: readonly string[], section: Section): number {
  let index = section.end - 1;
  while (index > section.start) {
    const line = (lines[index] ?? '').trim();
    if (line !== '' && !line.startsWith('#')) break;
    index--;
  }
  return index;
}

/** Parse a single-line TOML array of basic strings; null if it is anything else. */
export function parseStringArray(raw: string): string[] | null {
  const text = raw.replace(/\s+#[^"\]]*$/, '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  const values: string[] = [];
  const item = /\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(,|$)/y;
  let index = 0;
  while (index < inner.length) {
    item.lastIndex = index;
    const match = item.exec(inner);
    if (match === null) return null;
    const literal = match[1] as string;
    values.push(literal.startsWith("'") ? literal.slice(1, -1) : (JSON.parse(literal) as string));
    index = item.lastIndex;
    if (match[2] === '') break;
  }
  return index >= inner.length ? values : null;
}

export interface TomlResult {
  content: string;
  /** What could not be merged automatically, for the user to do by hand. */
  manual: string[];
}

function comments(lines: readonly string[] | undefined): string[] {
  return (lines ?? []).map(line => `# ${line}`);
}

export function addTomlKey(content: string, addition: TomlKey): TomlResult {
  const lines = content.split('\n');
  const table = sections(lines).find(section => !section.array && section.name === addition.table);
  const rendered = `${addition.key} = ${renderArray(addition.values)}`;

  if (table === undefined) {
    const block = [`[${addition.table}]`, ...comments(addition.comment), rendered];
    return { content: appendBlock(content, block), manual: [] };
  }

  const keyPattern = new RegExp(`^\\s*${addition.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=(.*)$`);
  for (let index = table.start + 1; index < table.end; index++) {
    const match = keyPattern.exec(lines[index] ?? '');
    if (match === null) continue;
    const existing = parseStringArray(match[1] ?? '');
    if (existing === null) {
      return {
        content,
        manual: [`gio.toml: add ${addition.values.map(quote).join(', ')} to [${addition.table}] ${addition.key}`],
      };
    }
    const missing = addition.values.filter(value => !existing.includes(value));
    if (missing.length === 0) return { content, manual: [] };
    lines[index] = `${addition.key} = ${renderArray([...existing, ...missing])}`;
    return { content: lines.join('\n'), manual: [] };
  }

  const at = lastContentLine(lines, table) + 1;
  lines.splice(at, 0, ...comments(addition.comment), rendered);
  return { content: lines.join('\n'), manual: [] };
}

export function addTomlArrayEntry(content: string, entry: TomlArrayEntry): TomlResult {
  const lines = content.split('\n');
  const pathLine = new RegExp(`^\\s*path\\s*=\\s*(["'])${entry.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*(?:#.*)?$`);
  const exists = sections(lines).some(
    section =>
      section.array &&
      section.name === entry.table &&
      lines.slice(section.start + 1, section.end).some(line => pathLine.test(line)),
  );
  if (exists) return { content, manual: [] };
  const block = [...comments(entry.comment), `[[${entry.table}]]`, ...entry.body.trimEnd().split('\n')];
  return { content: appendBlock(content, block), manual: [] };
}

function appendBlock(content: string, block: readonly string[]): string {
  const trimmed = content.replace(/\s+$/, '');
  const separator = trimmed === '' ? '' : '\n\n';
  return `${trimmed}${separator}${block.join('\n')}\n`;
}
