/**
 * giojs-cli/test/overlay-boot.test.ts
 *
 * Boot smoke test: a scaffold with the api, auth and db overlays runs on the
 * real Rust server and Node worker - the JSON route's status codes, the
 * page actions' 422/303 answers, the require_session guard, login/logout,
 * CSRF, and SQLite rows through Drizzle. Then the docker overlay's
 * Dockerfile is checked against a real `gio build standalone` of the same
 * app: every path it copies or runs exists, and the folder serves the app
 * on its own the way the runtime stage starts it.
 *
 * Needs a giojs-server binary (GIO_SERVER_BIN, or cargo's target dir) and
 * skips without one, like in the Node-only CI job.
 *   npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFeatures, coreDir, createNodeModules, read, repoRoot, runHealthcheck, scaffold, type Scaffold } from './overlay-helpers.ts';

function findServerBinary(): string | null {
  const exe = process.platform === 'win32' ? 'giojs-server.exe' : 'giojs-server';
  const candidates = [
    process.env['GIO_SERVER_BIN'],
    process.env['CARGO_TARGET_DIR'] && join(process.env['CARGO_TARGET_DIR'], 'debug', exe),
    join(repoRoot, 'target', 'debug', exe),
    join(repoRoot, 'target', 'release', exe),
  ];
  return candidates.find((path): path is string => typeof path === 'string' && path !== '' && existsSync(path)) ?? null;
}

const binary = findServerBinary();
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
// The db overlay's node:sqlite code needs 22.16+ (its engines field).
const sqliteReady = major > 22 || (major === 22 && minor >= 16);
const skip =
  binary === null
    ? 'no giojs-server binary (cargo build -p giojs-server, or set GIO_SERVER_BIN)'
    : !sqliteReady
      ? `Node ${process.versions.node} predates the db overlay's node:sqlite requirements`
      : false;

let workDir = '';
let project: Scaffold;
let log = '';

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

async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}):\n${log}`);
    try {
      const res = await fetch(`${base}/_gio/health`);
      if (res.ok && ((await res.json()) as { nodeReady?: boolean }).nodeReady === true) return;
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`server never became healthy:\n${log}`);
}

const ENV = {
  NODE_ENV: 'production',
  GIO_HOST: '127.0.0.1',
  GIO_SESSION_SECRET: randomBytes(32).toString('base64url'),
  DEMO_EMAIL: 'demo@example.com',
  DEMO_PASSWORD: 'correct horse',
};

async function start(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ base: string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(command, args, { cwd, env: { ...process.env, ...ENV, ...env, PORT: String(port) } });
  child.stdout?.on('data', chunk => { log += String(chunk); });
  child.stderr?.on('data', chunk => { log += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, child);
  return { base, child };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  };
}

before(async () => {
  if (skip !== false) return;
  workDir = await mkdtemp(join(tmpdir(), 'gio-overlay-boot-'));
  project = await scaffold(join(workDir, 'app'), 'ts');
  await applyFeatures(project, ['api', 'auth', 'db', 'docker']);
  const nodeModules = join(workDir, 'node_modules');
  await createNodeModules(nodeModules, { coreSource: true });
  await symlink(nodeModules, join(project.dir, 'node_modules'), 'junction');
});

after(async () => {
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

test('api + auth + db overlays boot on the real server', { skip }, async () => {
  const { base, child } = await start(binary as string, [], project.dir, {
    GIO_NODE_SCRIPT: join(coreDir, 'src', 'index.ts'),
    GIO_TSX_PKG: await realpath(join(coreDir, 'node_modules', 'tsx')),
  });
  try {
    // api: route.ts
    assert.equal((await fetch(`${base}/api/guestbook`)).status, 200);
    const json = (body: string): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const created = await fetch(`${base}/api/guestbook`, json('{"name":"Ada","message":"Hello"}'));
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { entry: { name: string } }).entry.name, 'Ada');
    assert.equal((await fetch(`${base}/api/guestbook`, json('{"name":'))).status, 400);
    assert.equal((await fetch(`${base}/api/guestbook`, json('{"name":""}'))).status, 422);
    assert.equal((await fetch(`${base}/api/guestbook`, { method: 'POST', body: 'name=x' })).status, 415);

    // api: the page action
    const page = await fetch(`${base}/guestbook`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Ada<\/strong>/);
    const invalid = await fetch(`${base}/guestbook`, form({ name: '', message: 'hi' }));
    assert.equal(invalid.status, 422);
    assert.match(await invalid.text(), /Enter your name\./);
    const signed = await fetch(`${base}/guestbook`, form({ name: 'Grace', message: 'Hi there' }));
    assert.equal(signed.status, 303);
    assert.match(await (await fetch(`${base}/guestbook`)).text(), /Grace<\/strong>/);

    // auth: the guard runs in Rust before Node
    const guarded = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    assert.equal(guarded.status, 302);
    assert.match(guarded.headers.get('location') ?? '', /\/login$/);
    const wrong = await fetch(`${base}/login`, form({ email: ENV.DEMO_EMAIL, password: 'nope' }));
    assert.equal(wrong.status, 422);
    assert.match(await wrong.text(), /Wrong email or password/);
    const crossSite = await fetch(`${base}/login`, {
      ...form({ email: ENV.DEMO_EMAIL, password: ENV.DEMO_PASSWORD }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    });
    assert.equal(crossSite.status, 403, 'cross-site POSTs are refused (CSRF)');
    const login = await fetch(`${base}/login`, form({ email: ENV.DEMO_EMAIL, password: ENV.DEMO_PASSWORD }));
    assert.equal(login.status, 303);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.match(cookie, /^gio_session=v1\./);
    const dashboard = await fetch(`${base}/dashboard`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Signed in as <strong>demo@example\.com/);
    const logout = await fetch(`${base}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    assert.equal(logout.status, 303);
    assert.match(logout.headers.get('set-cookie') ?? '', /^gio_session=;/);

    // db: seeded rows, then a write through the action
    assert.match(await (await fetch(`${base}/notes`)).text(), /Rows come from data\/app\.db/);
    assert.equal((await fetch(`${base}/notes`, form({ title: '' }))).status, 422);
    assert.equal((await fetch(`${base}/notes`, form({ title: 'Written by the boot test' }))).status, 303);
    assert.match(await (await fetch(`${base}/notes`)).text(), /Written by the boot test/);
    assert.ok(existsSync(join(project.dir, 'data', 'app.db')));
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    await stop(child);
  }
});

test('the docker overlay matches a real gio build standalone, which serves the app on its own', { skip }, async () => {
  const dockerfile = await read(project.dir, 'Dockerfile');
  const build = spawnSync(
    process.execPath,
    [join(repoRoot, 'packages', 'giojs', 'bin', 'standalone.mjs'), '--out', 'standalone'],
    { cwd: project.dir, encoding: 'utf8', env: { ...process.env, GIO_STANDALONE_SERVER_BIN: binary as string } },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  assert.match(dockerfile, /gio build standalone --out standalone/);

  // Everything the runtime stage copies, creates and runs.
  const out = join(project.dir, 'standalone');
  assert.match(dockerfile, /COPY --from=build \/app\/standalone \.\//);
  const server = process.platform === 'win32' ? 'server.exe' : 'server';
  for (const path of ['run.mjs', server, 'worker.js', 'static', 'gio.toml', '.gio/manifest.json', 'public']) {
    assert.ok(existsSync(join(out, path)), `standalone/${path}`);
  }
  assert.match(dockerfile, /CMD \["node", "run\.mjs"\]/);
  assert.match(dockerfile, /RUN if \[ -d drizzle \]; then cp -R drizzle standalone\/drizzle; fi/);
  await cp(join(project.dir, 'drizzle'), join(out, 'drizzle'), { recursive: true });

  // No node_modules, no project around it: only what the image holds.
  const isolated = join(workDir, 'image');
  await cp(out, isolated, { recursive: true });
  const { base, child } = await start(process.execPath, ['run.mjs'], isolated, {});
  try {
    assert.match(await (await fetch(`${base}/notes`)).text(), /Rows come from data\/app\.db/);
    assert.equal((await fetch(`${base}/notes`, form({ title: 'From the image' }))).status, 303);
    assert.ok(existsSync(join(isolated, 'data', 'app.db')), 'data/ is where the compose volume mounts');
    assert.equal((await fetch(`${base}/dashboard`, { redirect: 'manual' })).status, 302);
    // The image's HEALTHCHECK against the real /_gio/health.
    assert.equal(await runHealthcheck(dockerfile, Number(new URL(base).port)), 0);
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    await stop(child);
  }
});
