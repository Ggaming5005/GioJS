/**
 * giojs/test/helpers.mjs
 *
 * Shared plumbing for the CLI tests: run bin/gio.js (or giojs-server.js) in
 * a child process with a clean environment, temp projects, a fake server
 * binary, and free ports.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const gioBin = join(packageDir, 'bin', 'gio.js');
export const compatBin = join(packageDir, 'bin', 'giojs-server.js');

// Variables that would change what the CLI resolves; tests set their own.
const AMBIENT = [
  'PORT', 'GIO_PORT', 'GIO_HOST', 'NODE_ENV', 'GIO_SERVER_BIN', 'GIO_APP_DIR',
  'GIO_SESSION_SECRET', 'GIO_CACHE_DIR', 'npm_config_user_agent',
];

export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of AMBIENT) delete env[name];
  return { ...env, ...extra };
}

/** Run a bin synchronously: { status, stdout, stderr }. */
export function run(args, { cwd = packageDir, env = {}, bin = gioBin } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: cleanEnv(env),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run a bin without blocking this process's event loop (it may serve the child). */
export function runAsync(args, { cwd = packageDir, env = {}, bin = gioBin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: cleanEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const created = [];
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'gio-cli-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A project directory holding `files` (path -> contents). */
export function tempProject(files) {
  const root = tempDir();
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  }
  return root;
}

/** An executable copy of test-fixtures/fake-server.mjs (POSIX only: shebang). */
export function fakeServerBinary() {
  const path = join(tempDir('gio-fake-bin-'), 'giojs-server');
  copyFileSync(join(packageDir, 'test-fixtures', 'fake-server.mjs'), path);
  chmodSync(path, 0o755);
  return path;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** True when a stack trace leaked into CLI output. */
export function hasStackTrace(text) {
  return /\n\s+at .+\(.+:\d+:\d+\)/.test(text);
}
