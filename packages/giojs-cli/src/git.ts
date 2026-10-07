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
  /** `leftOut`: untracked files the commit skipped (see initGitRepository). */
  | { status: 'committed'; leftOut: string[] }
  | { status: 'unavailable' }
  | { status: 'inside-repo' }
  /** The repository exists but the initial commit failed. */
  | { status: 'no-commit'; reason: string }
  | { status: 'failed'; reason: string };

interface GitOutput {
  ok: boolean;
  stdout: string;
  /** stdout and stderr together, for messages. */
  output: string;
}

function git(args: string[], cwd: string): GitOutput {
  // stdin ignored: a credential or editor prompt must not hang the scaffold.
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error !== undefined) return { ok: false, stdout: '', output: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout, output: `${result.stdout}${result.stderr}`.trim() };
}

/**
 * `include` narrows the initial commit to the files it accepts (paths
 * relative to `dir`, '/'-separated). A --force run passes it: its directory
 * already held files that are not create-giojs's to commit - a .env with
 * secrets, say - so they stay untracked and are returned in `leftOut`.
 */
export function initGitRepository(dir: string, message: string, include?: (path: string) => boolean): GitResult {
  if (!git(['--version'], dir).ok) return { status: 'unavailable' };
  // A scaffold inside a monorepo or an existing checkout belongs to that
  // repository: a nested one would hide its files from the outer one.
  const inside = git(['rev-parse', '--is-inside-work-tree'], dir);
  if (inside.ok && inside.output === 'true') return { status: 'inside-repo' };

  const init = git(['init'], dir);
  if (!init.ok) return { status: 'failed', reason: firstLine(init.output) };
  let leftOut: string[] = [];
  let add: GitOutput;
  if (include === undefined) {
    add = git(['add', '-A'], dir);
  } else {
    // What `git add -A` would stage (untracked and not ignored), narrowed.
    const listed = git(['ls-files', '-z', '--others', '--exclude-standard'], dir);
    const untracked = listed.stdout.split('\0').filter(path => path !== '');
    const kept = untracked.filter(include);
    leftOut = untracked.filter(path => !include(path));
    if (!listed.ok) add = listed;
    else if (kept.length === 0) add = { ok: false, stdout: '', output: 'no new files to commit' };
    // Literal: a file name is never read as a glob.
    else add = git(['--literal-pathspecs', 'add', '--', ...kept], dir);
  }
  const commit = add.ok ? git(['commit', '--no-verify', '-m', message], dir) : add;
  if (!commit.ok) return { status: 'no-commit', reason: firstLine(commit.output) };
  return { status: 'committed', leftOut };
}

function firstLine(output: string): string {
  // The lead line of git's message: "Author identity unknown", a hook's error.
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'unknown error';
}
