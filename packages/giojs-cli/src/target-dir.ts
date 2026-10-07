/**
 * giojs-cli/src/target-dir.ts
 *
 * Where the scaffold may write. Copying a template over a folder that
 * already holds a project silently overwrites its package.json, app/ and
 * config, so a non-empty directory is refused unless --force - except for
 * files a fresh repository clone or an editor leaves behind, which the
 * template never touches.
 */
import { readdir, stat } from 'node:fs/promises';

const HARMLESS_ENTRIES = new Set([
  '.git',
  '.gitattributes',
  '.DS_Store',
  'Thumbs.db',
  '.idea',
  '.vscode',
  'README.md',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
]);

export type TargetDirState =
  | { kind: 'missing' }
  | { kind: 'empty' }
  /** Exists and holds `entries` beyond the harmless ones. */
  | { kind: 'not-empty'; entries: string[] }
  | { kind: 'not-a-directory' };

export async function inspectTargetDir(dir: string): Promise<TargetDirState> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (!isDirectory) return { kind: 'not-a-directory' };
  const entries = (await readdir(dir)).filter(name => !HARMLESS_ENTRIES.has(name)).sort();
  return entries.length === 0 ? { kind: 'empty' } : { kind: 'not-empty', entries };
}

/** The refusal message for a non-empty directory, listing what is there. */
export function describeNonEmpty(displayDir: string, entries: string[]): string {
  const shown = entries.slice(0, 8).map(name => `  ${name}`);
  if (entries.length > shown.length) shown.push(`  ... and ${entries.length - shown.length} more`);
  return (
    `${displayDir} is not empty:\n${shown.join('\n')}\n` +
    'Pick a new directory, empty this one, or pass --force to scaffold into it anyway ' +
    '(files with the same names as the template\'s are overwritten).'
  );
}
