/**
 * tests/integration/run.mjs
 *
 * End-to-end harness for the real Rust↔Node pair: spawns the actual
 * giojs-server binary against tests/integration/fixture, then exercises the
 * failure modes unit tests cannot reach - render, request-body forwarding
 * (UTF-8 and binary), cross-user render isolation, cache hits, and killing
 * the Node worker mid-flight to verify supervision recovers.
 *
 * No test framework: plain node + assert, exits non-zero on failure.
 *   node tests/integration/run.mjs        (build first: cargo build -p giojs-server)
 *   GIO_SERVER_BIN=path/to/giojs-server node tests/integration/run.mjs
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  throw new Error('giojs-server binary not found - run `cargo build -p giojs-server` first');
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
  for (const item of ['app', 'gio.toml', 'gio.config.ts', 'middleware.ts', 'package.json']) {
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

    await test('route.ts binary Response bodies survive the IPC boundary byte-for-byte', async () => {
      const res = await fetch(`${BASE}/api/binary`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/octet-stream/);
      const body = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(
        body,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01, 0x80]),
        'binary payload must not be UTF-8 transcoded',
      );
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
      const firstRes = await fetch(`${BASE}/cached`);
      const first = await firstRes.text();
      const secondRes = await fetch(`${BASE}/cached`);
      const second = await secondRes.text();
      assert.match(first, /INTEGRATION_FIXTURE_CACHED/);
      // rendered_at is baked at render time; identical bodies = cache hit.
      assert.equal(first, second);
      // X-Gio-Cache narrates the tier transitions.
      assert.match(firstRes.headers.get('x-gio-cache') ?? '', /^miss; stored$/);
      assert.match(secondRes.headers.get('x-gio-cache') ?? '', /^hit; ttl=\d+$/);
    });

    await test('streaming SSR: first bytes arrive before suspended content resolves', async () => {
      // accept-encoding: identity keeps the compression layer from buffering
      // chunks, so the timing below measures the server, not the encoder.
      const started = Date.now();
      const res = await fetch(`${BASE}/slow`, { headers: { 'accept-encoding': 'identity' } });
      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      let firstChunkAt = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkAt === null) firstChunkAt = Date.now();
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
      const firstMs = firstChunkAt - started;
      const totalMs = Date.now() - started;
      assert.ok(firstMs < 500, `first chunk must beat the 800ms suspense gap (took ${firstMs}ms)`);
      assert.ok(totalMs >= 700, `total must include the suspended chunk (took ${totalMs}ms)`);
      assert.match(html, /SLOW_FIXTURE_SHELL/);
      assert.match(html, /SLOW_FIXTURE_LATE_CONTENT/, 'late Suspense content must complete the body');
    });

    await test('streamed responses keep the envelope, injected head, and bypass label', async () => {
      const res = await fetch(`${BASE}/slow`, { headers: { 'accept-encoding': 'identity' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-gio-cache'), 'bypass');
      const html = await res.text();
      assert.match(html, /id="__gio"/);
      assert.match(html, /id="__gio_props"/);
      // Rust-side injection must land inside the stream, before </head>.
      const deployPos = html.indexOf('__GIO_DEPLOYMENT_ID__');
      const headClosePos = html.indexOf('</head>');
      assert.ok(deployPos !== -1, 'deployment script injected into streamed HTML');
      assert.ok(deployPos < headClosePos, 'deployment script must sit inside <head>');
      assert.match(html, /<\/html>/);
    });

    await test('HEAD requests to streaming pages stay on the buffered path', async () => {
      const res = await fetch(`${BASE}/slow`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-gio-cache'), 'bypass');
      assert.equal(await res.text(), '');
    });

    await test('PPR: first request streams the full page and stores the shell', async () => {
      const res = await fetch(`${BASE}/ppr`, {
        headers: { 'accept-encoding': 'identity', cookie: 'who=alice' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-gio-cache'), 'ppr; shell=stored');
      const html = await res.text();
      assert.match(html, /PPR_FIXTURE_SHELL/);
      assert.match(html, /PPR_FIXTURE_HOLE who=alice/, 'miss body must include the resolved hole');
    });

    await test('PPR: cached shell arrives instantly while holes stream personalized', async () => {
      // The shell cache put is spawned when shell_end passes through the
      // first response; give it a beat to land before asserting a hit.
      await sleep(250);
      const started = Date.now();
      const res = await fetch(`${BASE}/ppr`, {
        headers: { 'accept-encoding': 'identity', cookie: 'who=bob' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-gio-cache'), 'ppr; shell=hit');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      let firstChunkAt = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkAt === null) firstChunkAt = Date.now();
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
      const firstMs = firstChunkAt - started;
      const totalMs = Date.now() - started;
      assert.ok(firstMs < 500, `cached shell must beat the 600ms hole gap (took ${firstMs}ms)`);
      assert.ok(totalMs >= 500, `total must include the streamed hole (took ${totalMs}ms)`);
      assert.match(html, /PPR_FIXTURE_SHELL/);
      assert.match(html, /PPR_FIXTURE_FALLBACK/, 'cached shell carries the Suspense fallback');
      assert.match(html, /PPR_FIXTURE_HOLE who=bob/, 'hole must carry the second user cookie');
      assert.doesNotMatch(
        html,
        /PPR_FIXTURE_HOLE who=alice/,
        'first user hole content must never come out of the shell cache',
      );
    });

    await test('PPR: shell and holes concatenate into one complete document', async () => {
      const res = await fetch(`${BASE}/ppr`, {
        headers: { 'accept-encoding': 'identity', cookie: 'who=carol' },
      });
      assert.equal(res.headers.get('x-gio-cache'), 'ppr; shell=hit');
      const html = await res.text();
      const shellPos = html.indexOf('PPR_FIXTURE_SHELL');
      const holePos = html.indexOf('PPR_FIXTURE_HOLE who=carol');
      assert.ok(shellPos !== -1, 'shell content present');
      assert.ok(holePos !== -1, 'hole content present');
      assert.ok(shellPos < holePos, 'shell content precedes hole content');
      // The stored shell is composed: Rust-injected head lands inside <head>.
      const deployPos = html.indexOf('__GIO_DEPLOYMENT_ID__');
      assert.ok(deployPos !== -1 && deployPos < html.indexOf('</head>'));
      assert.match(html, /<\/html>/, 'holes render must close the document');
    });

    await test('X-Gio-Cache labels bypass and static tiers', async () => {
      const personalized = await fetch(`${BASE}/whoami`, { headers: { cookie: 'session=x' } });
      assert.equal(personalized.headers.get('x-gio-cache'), 'bypass');
      const asset = await fetch(`${BASE}/_next/static/chunks/nonexistent.js`);
      assert.equal(asset.headers.get('x-gio-cache'), 'static');
    });

    await test('gio.toml [[redirects]] issue the configured status with Location', async () => {
      const res = await fetch(`${BASE}/moved`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/cached');
      assert.equal(res.headers.get('x-gio-cache'), 'bypass');
    });

    await test('middleware.ts redirects execute in Rust before routing', async () => {
      const res = await fetch(`${BASE}/old-home`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      assert.equal(res.headers.get('x-gio-cache'), 'bypass');
    });

    await test('middleware.ts rewrites serve the target content under the requested URL', async () => {
      const res = await fetch(`${BASE}/alias`, { redirect: 'manual' });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /INTEGRATION_FIXTURE_CACHED/);
    });

    await test('guards redirect without the cookie and pass with it', async () => {
      const blocked = await fetch(`${BASE}/admin`, { redirect: 'manual' });
      assert.equal(blocked.status, 302);
      assert.equal(blocked.headers.get('location'), '/');
      const allowed = await fetch(`${BASE}/admin`, {
        headers: { cookie: 'a=1; session=int-test' },
      });
      assert.equal(allowed.status, 200);
      assert.match(await allowed.text(), /INTEGRATION_FIXTURE_ADMIN/);
    });

    await test('query strings survive rule redirects verbatim', async () => {
      const res = await fetch(`${BASE}/moved?a=1&b=two`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/cached?a=1&b=two');
    });

    await test('header rules stamp responses for matching paths', async () => {
      const res = await fetch(`${BASE}/cached`);
      assert.equal(res.headers.get('x-fixture-header'), 'from-middleware');
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
        // CI Windows runners are 2-core and cold: worker respawn (tsx boot +
        // esbuild bundling) can far exceed local timings.
      }, 90_000);
      // The watcher fires on a debounce; wait for its log line and the
      // completed worker restart rather than asserting immediately.
      await waitFor('watch restart logged', () =>
        Promise.resolve(/dev watch: change detected/.test(log)), 15_000);
      await waitFor('worker restart completed', () =>
        Promise.resolve(/dev watch: worker restarted/.test(log)), 90_000);
    });

    await test('dev watch: the page cache is cleared so cached routes update too', async () => {
      await waitFor('cached route to serve fresh content', async () => {
        const html = await (await fetch(`${BASE}/cached`)).text();
        return html.includes('WATCH_UPDATED_CACHED');
      }, 30_000);
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

/**
 * Phase 3 (standalone): `gio build standalone` against a minimal generated
 * app, then boot the output dir with NO node_modules present and prove pages,
 * prebuilt hydration chunks, and API routes all serve - and that tearing the
 * launcher down leaves no orphaned worker. A generated app (not the fixture)
 * keeps the bundle graph free of the fixture's monorepo-relative imports.
 */
async function standalonePhase() {
  const binary = findServerBinary();
  const STANDALONE_BASE = 'http://127.0.0.1:39518';
  const workDir = await mkdtemp(join(tmpdir(), 'gio-standalone-app-'));
  const outDir = join(workDir, 'dist-standalone');

  let log = '';
  let run = null;
  let runGone = true;
  let runExited = Promise.resolve();

  try {
    await mkdir(join(workDir, 'app', 'api', 'hello'), { recursive: true });
    await writeFile(
      join(workDir, 'app', 'page.tsx'),
      "import React from 'react';\n\nexport default function Home() {\n  return <h1>STANDALONE_FIXTURE_HOME</h1>;\n}\n",
    );
    await writeFile(
      join(workDir, 'app', 'api', 'hello', 'route.ts'),
      "export function GET() {\n  return { ok: true, source: 'standalone' };\n}\n",
    );
    await writeFile(
      join(workDir, 'gio.toml'),
      '[app]\nname = "standalone-fixture"\n\n[server]\nhost  = "127.0.0.1"\nport  = 39518\nhttp2 = false\n',
    );
    await writeFile(
      join(workDir, 'package.json'),
      JSON.stringify({ name: 'standalone-fixture', private: true, type: 'module' }),
    );
    await linkFixtureDeps(workDir);

    await test('standalone build produces a self-contained deploy directory', async () => {
      const build = spawnSync(
        process.execPath,
        [join(repoRoot, 'packages', 'giojs', 'bin', 'standalone.mjs'), '--out', outDir],
        {
          cwd: workDir,
          env: { ...process.env, GIO_STANDALONE_SERVER_BIN: binary },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );
      assert.equal(
        build.status,
        0,
        `standalone build failed:\n${build.stdout ?? ''}\n${build.stderr ?? ''}`,
      );
      const serverName = process.platform === 'win32' ? 'server.exe' : 'server';
      for (const item of [serverName, 'worker.js', 'run.mjs', 'gio.toml', 'package.json']) {
        assert.ok(existsSync(join(outDir, item)), `${item} present in output`);
      }
      assert.ok(existsSync(join(outDir, '.gio', 'manifest.json')), 'manifest present');
      assert.ok(!existsSync(join(outDir, 'node_modules')), 'output must not need node_modules');
      const worker = await readFile(join(outDir, 'worker.js'), 'utf8');
      assert.match(worker, /STANDALONE_FIXTURE_HOME/, 'page component bundled into worker.js');
    });

    // The output must be self-contained: delete the app sources and the
    // node_modules the build used before booting it.
    await rm(join(workDir, 'app'), { recursive: true, force: true });
    await rm(join(workDir, 'node_modules'), { recursive: true, force: true });

    run = spawn(process.execPath, [join(outDir, 'run.mjs')], {
      cwd: outDir,
      env: { ...process.env, RUST_LOG: 'info' },
    });
    run.stdout.on('data', (d) => { log += d.toString(); });
    run.stderr.on('data', (d) => { log += d.toString(); });
    runGone = false;
    runExited = new Promise((r) => run.on('exit', () => { runGone = true; r(); }));

    await waitFor('standalone server health', async () => {
      const res = await fetch(`${STANDALONE_BASE}/_gio/health`);
      return res.ok && (await res.json()).nodeReady === true;
    }, 30_000);

    await test('standalone: SSR page renders with envelope and prebuilt chunk', async () => {
      const res = await fetch(`${STANDALONE_BASE}/`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /STANDALONE_FIXTURE_HOME/);
      assert.match(html, /id="__gio"/);
      assert.match(html, /id="__gio_props"/);
      const chunk = html.match(/\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js/)?.[0];
      assert.ok(chunk, 'prebuilt entry chunk URL present in HTML');
      const chunkRes = await fetch(`${STANDALONE_BASE}${chunk}`);
      assert.equal(chunkRes.status, 200);
      assert.match(chunkRes.headers.get('cache-control') ?? '', /immutable/);
    });

    await test('standalone: route.ts API handler responds from the bundle', async () => {
      const res = await fetch(`${STANDALONE_BASE}/api/hello`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await res.json(), { ok: true, source: 'standalone' });
    });

    await test('standalone: stopping the launcher leaves no orphaned worker', async () => {
      const worker = [...log.matchAll(/pid Some\((\d+)\)/g)].map((m) => Number(m[1])).at(-1);
      assert.ok(worker, 'worker pid parsed from standalone server log');
      if (process.platform === 'win32') {
        // child.kill() cannot reach run.mjs's signal handlers on Windows;
        // taskkill the tree instead (the Job Object reaps the worker).
        spawnSync('taskkill', ['/pid', String(run.pid), '/T', '/F']);
      } else {
        run.kill('SIGTERM');
      }
      await waitFor('launcher exit', () => Promise.resolve(runGone), 15_000);
      await waitFor('standalone worker reaped', async () => {
        try {
          process.kill(worker, 0);
          return false;
        } catch {
          return true;
        }
      }, 10_000);
    });
  } catch (err) {
    console.error('\nintegration (standalone): FAILED');
    console.error(err);
    console.error('\n── standalone log tail ──');
    console.error(log.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    if (run !== null && !runGone) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(run.pid), '/T', '/F']);
      } else {
        // SIGTERM reaches run.mjs's forwarding handler, taking the server
        // (and via it the worker) down with the launcher.
        run.kill('SIGTERM');
      }
      await runExited;
    }
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
if (process.exitCode !== 1) {
  await devWatchPhase();
}
if (process.exitCode !== 1) {
  await standalonePhase();
}
console.log(`\nintegration: ${passed} passed${process.exitCode === 1 ? ', with FAILURES' : ''}`);
// Any stray handle (an orphaned worker holding a stdio pipe) must never keep
// the harness alive after the verdict is printed - CI burned 30 minutes on
// exactly that.
process.exit(process.exitCode ?? 0);
