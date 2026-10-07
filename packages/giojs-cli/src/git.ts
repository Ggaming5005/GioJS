/**
 * giojs-cli/src/git.ts
 *
 * `git init` plus an initial commit for a fresh scaffold. Best effort by
 * design: a missing git, a project inside an existing repository, or a
 * commit that fails (no user.name configured, a failing hook) never fails
 * the scaffold - the project is already complete without it.
 */
import { spawnSync } from 'node:child_process';

export type GitResult =
  | { status: 'committed' }
  | { status: 'unavailable' }
  | { status: 'inside-repo' }
  /** The repository exists but the initial commit failed. */
  | { status: 'no-commit'; reason: string }
  | { status: 'failed'; reason: string };

function git(args: string[], cwd: string): { ok: boolean; output: string } {
  // stdin ignored: a credential or editor prompt must not hang the scaffold.
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error !== undefined) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

export function initGitRepository(dir: string, message: string): GitResult {
  if (!git(['--version'], dir).ok) return { status: 'unavailable' };
  // A scaffold inside a monorepo or an existing checkout belongs to that
  // repository: a nested one would hide its files from the outer one.
  const inside = git(['rev-parse', '--is-inside-work-tree'], dir);
  if (inside.ok && inside.output === 'true') return { status: 'inside-repo' };

  const init = git(['init'], dir);
  if (!init.ok) return { status: 'failed', reason: firstLine(init.output) };
  const add = git(['add', '-A'], dir);
  const commit = add.ok ? git(['commit', '--no-verify', '-m', message], dir) : add;
  if (!commit.ok) return { status: 'no-commit', reason: firstLine(commit.output) };
  return { status: 'committed' };
}

function firstLine(output: string): string {
  // The lead line of git's message: "Author identity unknown", a hook's error.
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'unknown error';
}
