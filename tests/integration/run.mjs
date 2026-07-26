/**
 * tests/integration/run.mjs
 *
 * End-to-end harness for the real Rust↔Node pair: spawns the actual
 * giojs-server binary against tests/integration/fixture, then exercises the
 * failure modes unit tests cannot reach — render, request-body forwarding
 * (UTF-8 and binary), cross-user render isolation, cache hits, and killing
 * the Node worker mid-flight to verify supervision recovers.
 *
 * No test framework: plain node + assert, exits non-zero on failure.
 *   node tests/integration/run.mjs        (build first: cargo build -p giojs-server)
 *   GIO_SERVER_BIN=path/to/giojs-server node tests/integration/run.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtureDir = join(repoRoot, 'tests', 'integration', 'fixture');
const BASE = 'http://127.0.0.1:39517';
const EXT = process.platform === 'win32' ? '.exe' : '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findServerBinary() {
  if (process.env.GIO_SERVER_BIN) return process.env.GIO_SERVER_BIN;
  for (const profile of ['debug', 'release']) {
    const p = join(repoRoot, 'target', profile, `giojs-server${EXT}`);
    if (existsSync(p)) return p;
  }
  throw new Error('giojs-server binary not found — run `cargo build -p giojs-server` first');
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

async function waitFor(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== undefined && result !== false) return result;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError}` : ''}`);
}

/**
 * A real app has react in its own node_modules; the fixture borrows
 * giojs-core's installation via links (pnpm does not hoist to the repo root).
 */
async function linkFixtureDeps(targetDir = fixtureDir) {
  const sourceModules = join(repoRoot, 'packages', 'giojs-core', 'node_modules');
  const fixtureModules = join(targetDir, 'node_modules');
  await rm(fixtureModules, { recursive: true, force: true });
  await mkdir(fixtureModules, { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dep of ['react', 'react-dom']) {
    await symlink(join(sourceModules, dep), join(fixtureModules, dep), linkType);
  }
}

/**
 * Dev-watch needs a fixture it can mutate. The copy lives at the same
 * directory depth as the original so the fixture's relative
 * `../../../packages/` imports keep resolving.
 */
async function copyFixtureForDev() {
  const devDir = join(repoRoot, 'tests', 'integration', '.dev-fixture');
  await rm(devDir, { recursive: true, force: true });
  for (const item of ['app', 'gio.toml', 'gio.config.ts', 'package.json']) {
    await cp(join(fixtureDir, item), join(devDir, item), { recursive: true });
  }
  await linkFixtureDeps(devDir);
  return devDir;
}

async function main() {
  const binary = findServerBinary();
  const cacheDir = await mkdtemp(join(tmpdir(), 'gio-int-cache-'));
  await linkFixtureDeps();
  console.log(`server: ${binary}`);

  let log = '';
  const server = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIO_APP_DIR: join(fixtureDir, 'app'),
      GIO_CACHE_DIR: cacheDir,
      RUST_LOG: 'info',
      NODE_ENV: 'production',
    },
  });
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  // exitCode stays null for signal-terminated children (signalCode is set
  // instead), so liveness is tracked via the exit event.
  let serverGone = false;
  const serverExited = new Promise((r) =>
    server.on('exit', () => { serverGone = true; r(); }),
  );

  const workerPids = () =>
    [...log.matchAll(/pid Some\((\d+)\)/g)].map((m) => Number(m[1]));

  try {
    await waitFor('server health', async () => {
      const res = await fetch(`${BASE}/_gio/health`);
      return res.ok;
    }, 30_000);

    await test('SSR renders with hydration boundary and envelope', async () => {
      const res = await fetch(`${BASE}/`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /INTEGRATION_FIXTURE_HOME/);
      assert.match(html, /id="__gio"/);
      assert.match(html, /id="__gio_props"/);
      assert.match(html, /\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js/);
    });

    await test('hydration chunk is served with immutable caching', async () => {
      const html = await (await fetch(`${BASE}/`)).text();
      const chunk = html.match(/\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js/)?.[0];
      assert.ok(chunk, 'entry chunk URL present in HTML');
      const res = await fetch(`${BASE}${chunk}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    });

    await test('POST bodies are forwarded to Node', async () => {
      const res = await fetch(`${BASE}/echo`, { method: 'POST', body: 'hello body' });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /method=POST/);
      assert.match(body, /base64=false/);
      assert.match(body, /body=hello body/);
    });

    await test('binary POST bodies cross base64-encoded', async () => {
      const raw = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]);
      const res = await fetch(`${BASE}/echo`, { method: 'POST', body: raw });
      const body = await res.text();
      assert.match(body, /base64=true/);
      const encoded = body.match(/body=(\S+)/)?.[1] ?? '';
      assert.deepEqual(Buffer.from(encoded, 'base64'), raw);
    });

    await test('concurrent users never share a render', async () => {
      const users = ['session=alice', 'session=bob', 'session=carol'];
      const bodies = await Promise.all(
        users.map((cookie) =>
          fetch(`${BASE}/whoami`, { headers: { cookie } }).then((r) => r.text()),
        ),
      );
      users.forEach((cookie, i) => {
        assert.equal(bodies[i], `cookie=${cookie}`, 'each user must get their own render');
      });
    });

    await test('route.ts API handlers serve JSON with params and cookies', async () => {
      const post = await fetch(`${BASE}/api/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'session=int-test' },
        body: JSON.stringify({ text: 'first note' }),
      });
      assert.equal(post.status, 200);
      const created = await post.json();
      assert.equal(created.added, 'first note');
      assert.equal(created.cookie, 'int-test');

      const list = await fetch(`${BASE}/api/notes`);
      assert.equal(list.status, 200);
      assert.match(list.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual((await list.json()).notes, ['first note']);
    });

    await test('unexported methods get 405 with an Allow header', async () => {
      const res = await fetch(`${BASE}/api/notes`, { method: 'DELETE' });
      assert.equal(res.status, 405);
      assert.match(res.headers.get('allow') ?? '', /GET/);
      assert.match(res.headers.get('allow') ?? '', /POST/);
    });

    await test('unmatched paths render the custom not-found page with 404', async () => {
      const res = await fetch(`${BASE}/definitely/not/a/route`);
      assert.equal(res.status, 404);
      assert.match(await res.text(), /FIXTURE_CUSTOM_404/);
    });

    await test('route.ts SSE handlers stream events', async () => {
      const controller = new AbortController();
      const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = res.body.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);
      assert.match(chunk, /"tick":1/);
      controller.abort();
    });

    await test('cacheable pages are served from cache on the second hit', async () => {
      const first = await (await fetch(`${BASE}/cached`)).text();
      const second = await (await fetch(`${BASE}/cached`)).text();
      assert.match(first, /INTEGRATION_FIXTURE_CACHED/);
      // rendered_at is baked at render time; identical bodies = cache hit.
      assert.equal(first, second);
    });

    await test('killing the Node worker mid-flight recovers within seconds', async () => {
      const pidsBefore = workerPids();
      assert.ok(pidsBefore.length > 0, 'worker pid parsed from server log');
      const victim = pidsBefore[pidsBefore.length - 1];
      process.kill(victim);

      // Order matters: first observe the death (a fast /whoami poll could be
      // answered by the old worker before the kill lands), then the respawn,
      // then live recovery. Uncacheable route so recovery proves a fresh worker.
      await waitFor('worker death observed', () => {
        try {
          process.kill(victim, 0);
          return Promise.resolve(false);
        } catch {
          return Promise.resolve(true);
        }
      }, 10_000);
      await waitFor('worker respawn logged', () =>
        Promise.resolve(/Node worker respawned/.test(log)), 15_000);
      const recovered = await waitFor('worker recovery', async () => {
        const res = await fetch(`${BASE}/whoami`, { headers: { cookie: 'session=after' } });
        return res.status === 200 && (await res.text()) === 'cookie=session=after';
      }, 15_000);
      assert.ok(recovered);
      const pidsAfter = workerPids();
      assert.ok(
        pidsAfter[pidsAfter.length - 1] !== victim,
        'a fresh worker pid must appear after the kill',
      );
    });

    await test('stopping the server leaves no orphaned worker', async () => {
      const worker = workerPids().at(-1);
      server.kill();
      await waitFor('server exit', () => Promise.resolve(serverGone), 10_000);
      // kill(pid, 0) probes liveness; the worker tree must die with the server.
      await waitFor('worker reaped', async () => {
        try {
          process.kill(worker, 0);
          return false;
        } catch {
          return true;
        }
      }, 10_000);
    });

  } catch (err) {
    console.error('\nintegration: FAILED');
    console.error(err);
    console.error('\n── server log tail ──');
    console.error(log.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(cacheDir, { recursive: true, force: true });
  }
}

/** Phase 2 (dev mode): file watching restarts the worker and reloads pages. */
async function devWatchPhase() {
  const binary = findServerBinary();
  const devDir = await copyFixtureForDev();
  const cacheDir = await mkdtemp(join(tmpdir(), 'gio-int-devcache-'));

  let log = '';
  const server = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIO_APP_DIR: join(devDir, 'app'),
      GIO_CACHE_DIR: cacheDir,
      RUST_LOG: 'info',
      NODE_ENV: 'development',
    },
  });
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  let serverGone = false;
  const serverExited = new Promise((r) =>
    server.on('exit', () => { serverGone = true; r(); }),
  );

  try {
    await waitFor('dev server health', async () => {
      const res = await fetch(`${BASE}/_gio/health`);
      return res.ok;
    }, 30_000);

    await test('dev watch: editing a page restarts the worker and serves new content', async () => {
      assert.match(await (await fetch(`${BASE}/`)).text(), /INTEGRATION_FIXTURE_HOME/);
      // Prime the cache so the cached-route assertion below proves clearing.
      assert.match(await (await fetch(`${BASE}/cached`)).text(), /INTEGRATION_FIXTURE_CACHED/);

      const homeFile = join(devDir, 'app', 'page.tsx');
      const cachedFile = join(devDir, 'app', 'cached', 'page.tsx');
      await writeFile(
        homeFile,
        (await readFile(homeFile, 'utf8')).replace('INTEGRATION_FIXTURE_HOME', 'WATCH_UPDATED_HOME'),
      );
      await writeFile(
        cachedFile,
        (await readFile(cachedFile, 'utf8')).replace('INTEGRATION_FIXTURE_CACHED', 'WATCH_UPDATED_CACHED'),
      );

      await waitFor('watch-triggered restart to serve the edit', async () => {
        const html = await (await fetch(`${BASE}/`)).text();
        return html.includes('WATCH_UPDATED_HOME');
      }, 30_000);
      // The watcher fires on a debounce; wait for its log line and the
      // completed worker restart rather than asserting immediately.
      await waitFor('watch restart logged', () =>
        Promise.resolve(/dev watch: change detected/.test(log)), 15_000);
      await waitFor('worker restart completed', () =>
        Promise.resolve(/dev watch: worker restarted/.test(log)), 30_000);
    });

    await test('dev watch: the page cache is cleared so cached routes update too', async () => {
      await waitFor('cached route to serve fresh content', async () => {
        const html = await (await fetch(`${BASE}/cached`)).text();
        return html.includes('WATCH_UPDATED_CACHED');
      }, 15_000);
    });
  } catch (err) {
    console.error('\nintegration (dev watch): FAILED');
    console.error(err);
    console.error('\n── dev server log tail ──');
    console.error(log.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(cacheDir, { recursive: true, force: true });
    await rm(devDir, { recursive: true, force: true });
  }
}

await main();
if (process.exitCode !== 1) {
  await devWatchPhase();
}
console.log(`\nintegration: ${passed} passed${process.exitCode === 1 ? ', with FAILURES' : ''}`);
