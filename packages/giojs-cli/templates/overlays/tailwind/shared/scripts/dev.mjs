// `npm run dev` with Tailwind: the Tailwind watcher (the "css:watch" script)
// and the GioJS dev server ("dev:server") side by side. The server starts
// once the watcher's first build has written app/tailwind.out.css, which
// the root layout imports; whichever process ends first stops the other.
//
// No dependencies, and the same on macOS, Linux and Windows with any package
// manager: each script runs through the shell with node_modules/.bin on
// PATH, the way `npm run` runs it.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
const isWindows = process.platform === 'win32';
// The server starts anyway if the watcher never reports its first build.
const FIRST_BUILD_TIMEOUT_MS = 15_000;

const env = { ...process.env };
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = [join(root, 'node_modules', '.bin'), env[pathKey]].filter(Boolean).join(delimiter);

const children = new Set();
let exiting = false;

function run(name, stdio) {
  const command = scripts[name];
  if (typeof command !== 'string') {
    console.error(`dev: package.json has no "${name}" script`);
    stop(1);
    return null;
  }
  // POSIX: each script in its own process group, so stopping it reaches
  // everything the shell started.
  const child = spawn(command, { cwd: root, env, shell: true, stdio, detached: !isWindows });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!exiting) {
      if (code !== 0) console.error(`dev: "${name}" exited with ${signal ?? code}`);
      stop(code ?? 1);
    }
  });
  return child;
}

function kill(child) {
  if (child.pid === undefined) return;
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

function stop(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) kill(child);
  process.exitCode = code;
  // Never hang on a child that ignores SIGTERM.
  setTimeout(() => process.exit(code), 5_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    // Windows delivers a console Ctrl+C to every process in it, the scripts
    // included, and taskkill would cut the server's graceful shutdown short:
    // just wait for them. POSIX: the scripts run in their own process groups.
    if (isWindows) exiting = true;
    else stop(0);
  });
}

// stdin is a pipe held open and never written: Tailwind's watcher exits when
// its stdin closes, so it cannot outlive this runner even if it is killed.
const watcher = run('css:watch', ['pipe', 'inherit', 'pipe']);
if (watcher !== null) {
  watcher.stdin.on('error', () => {});
  let server = null;
  const startServer = () => {
    clearTimeout(timer);
    if (server === null && !exiting) server = run('dev:server', 'inherit');
  };
  const timer = setTimeout(startServer, FIRST_BUILD_TIMEOUT_MS);
  timer.unref();
  watcher.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    if (/Done in/.test(String(chunk))) startServer();
  });
}
