/**
 * giojs-cli/test/helpers.ts
 *
 * Runs the built CLI (dist/ - `npm test` compiles first) as a user would:
 * a child process with piped stdin, so it is never an interactive terminal.
 * The environment is scrubbed of the package manager and git identity of
 * whoever runs the tests, so results do not depend on the machine.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const cliEntry = join(cliDir, 'dist', 'index.js');

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  entry?: string;
}

/** The process env minus anything that would leak the test machine's setup in. */
export function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_') || key.startsWith('GIT_')) delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Runs a scaffold the way the starter tests need it: no install, no git, no prompts. */
export function scaffoldApp(cwd: string, name: string, flags: string[] = []): string {
  const result = runCli([name, '--yes', '--no-install', '--no-git', ...flags], { cwd });
  if (result.status !== 0) throw new Error(`create-giojs failed:\n${result.stdout}\n${result.stderr}`);
  return join(cwd, name);
}

export function runCli(args: string[], options: RunOptions): CliResult {
  const result = spawnSync(process.execPath, [options.entry ?? cliEntry, ...args], {
    cwd: options.cwd,
    env: cleanEnv(options.env),
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
