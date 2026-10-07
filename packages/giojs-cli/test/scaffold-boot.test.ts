/**
 * giojs-cli/test/scaffold-boot.test.ts
 *
 * A fresh scaffold must run, not only typecheck. Its node_modules is laid
 * out from the workspace: @gio.js/core is the workspace package (the worker
 * runs its .ts sources through tsx, as an install does), @gio.js/react its
 * build, React from the workspace install.
 *
 * - The static-site scaffold's `gio export` writes an out/ that works on a
 *   static host: every page, every asset it references, and the fonts the
 *   CSS bundles in place of [[fonts]].
 * - The server scaffold boots on the real Rust server and serves the starter
 *   with its self-hosted fonts. Skipped without a server binary: set
 *   GIO_SERVER_BIN, or build one (cargo build -p giojs-server).
 *   npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldApp } from './helpers.ts';
import { buildPackage, coreDir, linkInstalled, packagesDir, reactDir } from './workspace.ts';

const repoRoot = join(packagesDir, '..');
const exe = process.platform === 'win32' ? '.exe' : '';

let workDir = '';
let reactBuild = '';

function serverBinary(): string | undefined {
  const candidates = [
    process.env['GIO_SERVER_BIN'],
    process.env['CARGO_TARGET_DIR'] && join(process.env['CARGO_TARGET_DIR'], 'debug', `giojs-server${exe}`),
    join(repoRoot, 'target', 'debug', `giojs-server${exe}`),
    join(repoRoot, 'target', 'release', `giojs-server${exe}`),
  ];
  return candidates.find((path): path is string => typeof path === 'string' && path !== '' && existsSync(path));
}

/** node_modules for a scaffold: what `npm install` would put there. */
async function installWorkspacePackages(projectDir: string): Promise<void> {
  const nodeModules = join(projectDir, 'node_modules');
  await mkdir(join(nodeModules, '@gio.js'), { recursive: true });
  await symlink(coreDir, join(nodeModules, '@gio.js', 'core'), 'junction');
  await cp(reactBuild, join(nodeModules, '@gio.js', 'react'), { recursive: true });
  // The same realpaths core resolves, so the app and core share one React.
  for (const name of ['react', 'react-dom', 'tsx', 'esbuild']) await linkInstalled(nodeModules, name);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}

before(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'gio-scaffold-boot-')));
  reactBuild = join(workDir, 'react-build');
  buildPackage(reactDir, join(reactBuild, 'dist'));
  await cp(join(reactDir, 'package.json'), join(reactBuild, 'package.json'));
});

after(async () => {
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

test('the static-site scaffold exports an out/ that works on a static host', async () => {
  const siteDir = scaffoldApp(workDir, 'site', ['--ts', '--static']);
  await installWorkspacePackages(siteDir);
  const result = spawnSync(process.execPath, [join(packagesDir, 'giojs', 'bin', 'gio.js'), 'export'], {
    cwd: siteDir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `gio export failed:\n${result.stdout}\n${result.stderr}`);

  const out = join(siteDir, 'out');
  const files = new Set(await listFiles(out));
  for (const page of ['/index.html', '/about/index.html', '/posts/1/index.html', '/posts/3/index.html', '/404.html']) {
    assert.ok(files.has(page), `${page} was not exported`);
  }
  const home = await readFile(join(out, 'index.html'), 'utf8');
  assert.match(home, /Welcome to <em>your app<\/em>/);
  assert.match(await readFile(join(out, 'posts', '1', 'index.html'), 'utf8'), /<title>Post #1 \| site<\/title>/);
  // A static host serves only files: every local asset a page names must be one.
  for (const [, url] of home.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) {
    if (url === '/' || url === undefined) continue;
    const file = url.endsWith('/') ? `${url}index.html` : url;
    assert.ok(files.has(file) || files.has(`${file}/index.html`), `${url} is referenced but not in out/`);
  }
  // [[fonts]] needs the server: the stylesheet bundles the font files instead.
  const css = [...files].filter(file => file.startsWith('/_next/static/css/') && file.endsWith('.css'));
  assert.equal(css.length, 1, css.join(', '));
  const stylesheet = await readFile(join(out, css[0] ?? ''), 'utf8');
  const fontUrls = [...stylesheet.matchAll(/url\(["']?([^"')]+\.woff2)["']?\)/g)].map(match => match[1] ?? '');
  assert.equal(fontUrls.length, 4, stylesheet.slice(0, 400));
  for (const url of fontUrls) {
    const file = url.startsWith('/') ? url : `/_next/static/css/${url.replace(/^\.\//, '')}`;
    assert.ok(files.has(file), `font ${url} is not in out/`);
  }
  assert.doesNotMatch(home, /\/_gio\//, 'nothing points at server-only endpoints');
});

const binary = serverBinary();

test('the server scaffold boots and serves the starter with self-hosted fonts', { skip: binary === undefined && 'no giojs-server binary (set GIO_SERVER_BIN)' }, async () => {
  const appDir = scaffoldApp(workDir, 'server-app', ['--ts', '--server']);
  await installWorkspacePackages(appDir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = '';
  const server = spawn(binary ?? '', [], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      GIO_NODE_SCRIPT: join(appDir, 'node_modules', '@gio.js', 'core', 'src', 'index.ts'),
      GIO_TSX_PKG: join(appDir, 'node_modules', 'tsx'),
      // The server exits with this test process even if the test dies.
      GIO_EXIT_ON_STDIN_EOF: '1',
      RUST_LOG: 'warn',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  server.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ready = await fetch(`${base}/_gio/health`)
        .then(async res => res.ok && ((await res.json()) as { nodeReady?: boolean }).nodeReady === true)
        .catch(() => false);
      if (ready) break;
      assert.ok(server.exitCode === null, `the server exited:\n${log}`);
      assert.ok(Date.now() < deadline, `the server did not become ready:\n${log}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Welcome to <em>your app<\/em>/);
    assert.match(html, /<title>server-app<\/title>/);
    assert.match(html, /<link rel="preload" href="\/_gio\/fonts\/fraunces-400-normal\.woff2" as="font"/);
    assert.match(html, /<link rel="stylesheet" href="\/_next\/static\/css\/[^"]+\.css"/, 'app/globals.css is linked');

    const font = await fetch(`${base}/_gio/fonts/jetbrains-mono-600-normal.woff2`);
    assert.equal(font.status, 200);
    assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString('latin1'), 'wOF2');

    const post = await fetch(`${base}/posts/42`);
    assert.equal(post.status, 200);
    assert.match(await post.text(), /<title>Post #42 \| server-app<\/title>/);
  } finally {
    server.kill('SIGTERM');
    await exited;
  }
});
