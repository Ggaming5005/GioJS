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
import { request as httpRequest } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
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

/**
 * Failure log tail with the request-completed spam removed - a 90s poll loop
 * otherwise pushes the one line that explains the failure out of the window.
 */
function significantLogTail(log) {
  return log
    .split('\n')
    .filter((line) => !line.includes('request completed'))
    .slice(-80)
    .join('\n');
}

/**
 * Raw HTTP request against BASE with full control of Host / Origin /
 * Sec-Fetch-Site (fetch treats those as browser-owned). Resolves with the
 * status and body; event streams resolve on headers and are torn down.
 */
function rawRequest(method, path, headers = {}) {
  const url = new URL(path, BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        if (String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
          resolve({ status: res.statusCode, body: '' });
          res.destroy();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
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

/**
 * Raw TCP exchange with the fixture server: write `payload` (possibly an
 * incomplete request) and collect everything until the SERVER closes the
 * socket. Fetch cannot express a stalled head or a half-sent body.
 */
function rawExchange(payload, { port = 39517, maxMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let data = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(payload));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`server kept the connection open past ${maxMs}ms; got: ${data}`));
    }, maxMs);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', () => {}); // a reset still ends in 'close'
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ data, closedAfterMs: Date.now() - started });
    });
  });
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
  const items = [
    'app', 'lib', 'gio.toml', 'gio.config.ts', 'middleware.ts', 'package.json',
    '.env', '.env.development', '.env.production',
  ];
  for (const item of items) {
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
      // Also set in fixture/.env: the real environment must win.
      GIO_FIXTURE_PROCESS_WINS: 'from-process',
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

    await test('.env files load at startup and the worker inherits them', async () => {
      const res = await fetch(`${BASE}/api/env`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        dotenv: 'from-dotenv',
        // NODE_ENV=production: .env.production beats .env, and
        // .env.development never loads.
        precedence: 'from-env-production',
        processWins: 'from-process',
      });
      // File names are logged (from the project root, not the cwd); values never.
      assert.match(log, /loaded \.env files.*\.env\.production, \.env/);
      assert.doesNotMatch(log, /FIXTURE_PRIVATE_VALUE/);
    });

    await test('GIO_PUBLIC_* vars are inlined into client chunks, others never', async () => {
      const res = await fetch(`${BASE}/env`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /ENV_FIXTURE greeting=(<!-- -->)?FIXTURE_PUBLIC_VALUE/);
      const chunk = html.match(/\/_next\/static\/chunks\/route-env-[A-Z0-9]+\.js/)?.[0];
      assert.ok(chunk, 'env page has a hydration chunk');
      const js = await (await fetch(`${BASE}${chunk}`)).text();
      assert.match(js, /FIXTURE_PUBLIC_VALUE/, 'public value inlined at build time');
      assert.doesNotMatch(js, /FIXTURE_PRIVATE_VALUE/, 'non-public value must never ship');
    });

    await test('server-only imports in client code: page SSRs but never hydrates', async () => {
      const res = await fetch(`${BASE}/server-only-leak`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /SERVER_ONLY_LEAK_FIXTURE key=(<!-- -->)?FIXTURE_SERVER_ONLY_VALUE/);
      assert.doesNotMatch(html, /route-server-only-leak-/, 'no bundle for the leaking route');
      assert.doesNotMatch(html, /id="__gio_props"/);
      assert.doesNotMatch(html, /__GIO_SSR_ERROR__/, 'the overlay hand-off is dev-only');
      assert.match(
        log,
        /imports server-only code.*app\/server-only-leak\/page\.tsx -> lib\/fixture-keys\.server\.ts/,
      );
    });

    await test('the rejected route does not cost the others their shared chunks', async () => {
      const html = await (await fetch(`${BASE}/`)).text();
      const chunk = html.match(/\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js/)?.[0];
      assert.ok(chunk, 'home page still hydrates');
      const js = await (await fetch(`${BASE}${chunk}`)).text();
      // Per-route fallback bundles would each carry their own React.
      assert.match(js, /\.\/shared-[A-Z0-9]+\.js/, 'entry imports a shared chunk');
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

    await test('catch-all pages match one or more segments, never the bare parent', async () => {
      const deep = await fetch(`${BASE}/docs/guides/getting-started`);
      assert.equal(deep.status, 200);
      assert.match(await deep.text(), /FIXTURE_CATCH_ALL slug=\[guides\/getting-started\]/);
      const bare = await fetch(`${BASE}/docs`);
      assert.equal(bare.status, 404);
      assert.match(await bare.text(), /FIXTURE_CUSTOM_404/);
    });

    await test('optional catch-all pages also match the bare parent', async () => {
      const bare = await fetch(`${BASE}/shop`);
      assert.equal(bare.status, 200);
      assert.match(await bare.text(), /FIXTURE_OPTIONAL_CATCH_ALL path=\[\]/);
      const deep = await fetch(`${BASE}/shop/shoes/red`);
      assert.equal(deep.status, 200);
      assert.match(await deep.text(), /FIXTURE_OPTIONAL_CATCH_ALL path=\[shoes\/red\]/);
    });

    /** The hydration entry chunk URL a page's HTML bootstraps. */
    const entryChunkOf = (html) =>
      html.match(/\/_next\/static\/chunks\/route-[^"]+?-[A-Z0-9]+\.js/)?.[0];

    await test('route-group pages drop the group from the URL and get only their group layout', async () => {
      const res = await fetch(`${BASE}/pricing`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /FIXTURE_GROUP_PRICING/);
      // The group layout renders inside the hydration boundary, around the page.
      assert.ok(html.indexOf('id="__gio"') < html.indexOf('FIXTURE_MARKETING_LAYOUT'));
      assert.ok(html.indexOf('FIXTURE_MARKETING_LAYOUT') < html.indexOf('FIXTURE_GROUP_PRICING'));
      const chunk = entryChunkOf(html);
      assert.ok(chunk, 'group page has a hydration chunk');
      assert.match(await (await fetch(`${BASE}${chunk}`)).text(), /FIXTURE_MARKETING_LAYOUT/,
        'the client bundle must wrap the same group layout the server rendered');

      const home = await (await fetch(`${BASE}/`)).text();
      assert.doesNotMatch(home, /FIXTURE_MARKETING_LAYOUT/, 'a group layout never leaks outside its group');
      assert.equal((await fetch(`${BASE}/(marketing)/pricing`)).status, 404);
    });

    await test('a layout inside a dynamic [id] folder wraps its pages on server and client', async () => {
      const res = await fetch(`${BASE}/posts/42`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /FIXTURE_POST id=\[42\]/);
      assert.ok(html.indexOf('FIXTURE_POST_LAYOUT') !== -1, 'the [id] layout must apply');
      assert.ok(html.indexOf('FIXTURE_POST_LAYOUT') < html.indexOf('FIXTURE_POST id='));
      const chunk = entryChunkOf(html);
      assert.ok(chunk, 'dynamic page has a hydration chunk');
      assert.match(await (await fetch(`${BASE}${chunk}`)).text(), /FIXTURE_POST_LAYOUT/,
        'the client bundle must wrap the same [id] layout the server rendered');
    });

    await test('private _folders are never routable', async () => {
      const res = await fetch(`${BASE}/_private`);
      assert.equal(res.status, 404);
      assert.doesNotMatch(await res.text(), /FIXTURE_PRIVATE_MUST_NOT_RENDER/);
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

    await test('SSE streams outlive header_read_timeout_secs', async () => {
      // The fixture's 2s head deadline must never cut an established stream.
      const controller = new AbortController();
      const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const started = Date.now();
      let late = '';
      while (Date.now() - started < 2600) {
        const { done, value } = await reader.read();
        assert.ok(!done, `SSE stream ended after ${Date.now() - started}ms`);
        if (Date.now() - started > 2000) late += decoder.decode(value);
      }
      controller.abort();
      assert.match(late, /"tick":2/, 'events still arrive past the head deadline');
    });

    await test('stalled request heads and idle keep-alive sockets are closed after header_read_timeout_secs', async () => {
      // Both run concurrently so the suite pays the 2s deadline once.
      const [stalled, idle] = await Promise.all([
        rawExchange('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: '),
        rawExchange('GET /_gio/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'),
      ]);
      assert.ok(
        stalled.closedAfterMs >= 1500,
        `slowloris head closed too early (${stalled.closedAfterMs}ms)`,
      );
      assert.match(idle.data, /^HTTP\/1\.1 200/);
      // Clients that honor the hint stop reusing the socket before we close it.
      assert.match(idle.data, /\r\nkeep-alive: timeout=2\r\n/i);
      assert.ok(idle.closedAfterMs >= 1500, `idle socket closed too early (${idle.closedAfterMs}ms)`);
    });

    await test('request bodies trickled past request_body_timeout_secs get 408', async () => {
      const { data, closedAfterMs } = await rawExchange(
        'POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\npartial',
      );
      assert.match(data, /^HTTP\/1\.1 408/);
      assert.ok(closedAfterMs >= 1500, `408 before the body deadline (${closedAfterMs}ms)`);
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

    await test('the worker runs in the mode Rust decided (NODE_ENV=production)', async () => {
      const html = await (await fetch(`${BASE}/node-env`)).text();
      assert.match(html, /WORKER_NODE_ENV=production/);
    });

    await test('production error pages show only a digest; the log has the details', async () => {
      const res = await fetch(`${BASE}/boom`);
      assert.equal(res.status, 500);
      const html = await res.text();
      assert.doesNotMatch(html, /FIXTURE_SECRET_FAILURE|hunter2/, 'error message must not leak');
      assert.doesNotMatch(html, /__GIO_SSR_ERROR__|page\.tsx|\bat \S+ \(/, 'no stack or dev payload');
      assert.match(html, /Internal Server Error/);
      const digest = html.match(/Error reference: <code>([0-9a-f]{12})<\/code>/)?.[1];
      assert.ok(digest, `error page must carry a digest:\n${html}`);
      // Operators correlate by digest: the worker logged message + stack under it.
      await waitFor('digest in the server log', () => Promise.resolve(
        log.split('\n').some((line) =>
          line.includes(digest) && line.includes('FIXTURE_SECRET_FAILURE') && line.includes('"stack"')),
      ), 5_000);
    });

    await test('a revalidate page that reads cookies is never cached for everyone', async () => {
      const as = (who) => fetch(`${BASE}/personal`, { headers: { cookie: `who=${who}` } });
      const alice = await as('alice');
      assert.match(await alice.text(), /PERSONAL_FIXTURE who=alice/);
      assert.equal(alice.headers.get('x-gio-cache'), 'bypass');
      const bob = await as('bob');
      assert.match(await bob.text(), /PERSONAL_FIXTURE who=bob/, 'second visitor must get their own page');
      assert.equal(bob.headers.get('x-gio-cache'), 'bypass');
      const anon = await (await fetch(`${BASE}/personal`)).text();
      assert.match(anon, /PERSONAL_FIXTURE who=anon/);
      await waitFor('personal-render warning logged', () =>
        Promise.resolve(/read request credentials/.test(log)), 5_000);
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

    await test('PPR: the cached shell never carries the first visitor\'s props', async () => {
      // The shell was stored from alice's render; her gSSP props (the
      // hydration envelope) must have stayed out of it.
      const res = await fetch(`${BASE}/ppr`, {
        headers: { 'accept-encoding': 'identity', cookie: 'who=dave' },
      });
      assert.equal(res.headers.get('x-gio-cache'), 'ppr; shell=hit');
      const html = await res.text();
      assert.doesNotMatch(html, /alice|bob|carol/, 'no earlier visitor data may come out of the shell cache');
      const envelopes = html.match(/<script id="__gio_props"[^>]*>[^<]*<\/script>/g) ?? [];
      assert.equal(envelopes.length, 1, 'exactly one hydration envelope - this visitor\'s');
      assert.match(envelopes[0], /"who":"dave"/);
      assert.ok(
        html.indexOf('id="__gio_props"') > html.indexOf('PPR_FIXTURE_SHELL'),
        'the envelope streams after the shell',
      );
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
    console.error(significantLogTail(log));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(cacheDir, { recursive: true, force: true });
  }
}

/**
 * Phase 1b (NODE_ENV unset - the template's `npm start`): Rust runs in
 * production mode, so the worker must not write build diagnostics into
 * public HTML either - no overlay is there to read them.
 */
async function unsetNodeEnvPhase() {
  const binary = findServerBinary();
  const cacheDir = await mkdtemp(join(tmpdir(), 'gio-int-unset-cache-'));
  const env = {
    ...process.env,
    GIO_APP_DIR: join(fixtureDir, 'app'),
    GIO_CACHE_DIR: cacheDir,
    RUST_LOG: 'info',
  };
  delete env.NODE_ENV;

  let log = '';
  const server = spawn(binary, [], { cwd: repoRoot, env });
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  let serverGone = false;
  const serverExited = new Promise((r) =>
    server.on('exit', () => { serverGone = true; r(); }),
  );

  try {
    await waitFor('server health (NODE_ENV unset)', async () => {
      const res = await fetch(`${BASE}/_gio/health`);
      return res.ok && (await res.json()).nodeReady === true;
    }, 30_000);

    await test('NODE_ENV unset: rejected bundles stay out of public HTML', async () => {
      assert.match(log, /loaded \.env files.*"production"/);
      const html = await (await fetch(`${BASE}/server-only-leak`)).text();
      assert.match(html, /SERVER_ONLY_LEAK_FIXTURE/);
      assert.doesNotMatch(html, /__gio_dev_overlay_script/, 'production mode: no overlay');
      assert.doesNotMatch(html, /__GIO_SSR_ERROR__/);
      assert.doesNotMatch(html, /imports server-only code|fixture-keys\.server/);
      // The diagnostic still reaches the server log.
      assert.match(log, /imports server-only code/);
    });
  } catch (err) {
    console.error('\nintegration (NODE_ENV unset): FAILED');
    console.error(err);
    console.error('\n── server log tail ──');
    console.error(significantLogTail(log));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(cacheDir, { recursive: true, force: true });
  }
}

/**
 * Phase 1b (inherited NODE_ENV): Rust decides the runtime mode and sets
 * NODE_ENV on the worker it spawns. A server started with NODE_ENV unset or
 * 'test' is production on the Rust side, so its worker must be production
 * too - never a dev worker (dev bundles, error details) behind a prod server.
 */
async function inheritedModePhase() {
  const binary = findServerBinary();
  for (const inherited of [undefined, 'test']) {
    const label = inherited === undefined ? 'unset' : inherited;
    const cacheDir = await mkdtemp(join(tmpdir(), 'gio-int-modecache-'));
    const env = {
      ...process.env,
      GIO_APP_DIR: join(fixtureDir, 'app'),
      GIO_CACHE_DIR: cacheDir,
      RUST_LOG: 'info',
    };
    delete env.NODE_ENV;
    if (inherited !== undefined) env.NODE_ENV = inherited;

    let log = '';
    const server = spawn(binary, [], { cwd: repoRoot, env });
    server.stdout.on('data', (d) => { log += d.toString(); });
    server.stderr.on('data', (d) => { log += d.toString(); });
    let serverGone = false;
    const serverExited = new Promise((r) =>
      server.on('exit', () => { serverGone = true; r(); }),
    );

    try {
      await waitFor('server health', async () => {
        const res = await fetch(`${BASE}/_gio/health`);
        return res.ok;
      }, 30_000);

      await test(`NODE_ENV ${label}: the spawned worker runs as production`, async () => {
        const html = await (await fetch(`${BASE}/node-env`)).text();
        assert.match(html, /WORKER_NODE_ENV=production/);
        const boom = await (await fetch(`${BASE}/boom`)).text();
        assert.doesNotMatch(boom, /FIXTURE_SECRET_FAILURE/);
        assert.match(boom, /Error reference: <code>[0-9a-f]{12}<\/code>/);
      });
    } catch (err) {
      console.error(`\nintegration (NODE_ENV ${label}): FAILED`);
      console.error(err);
      console.error('\n── server log tail ──');
      console.error(significantLogTail(log));
      process.exitCode = 1;
    } finally {
      if (!serverGone) server.kill();
      await serverExited;
      await rm(cacheDir, { recursive: true, force: true });
    }
    if (process.exitCode === 1) return;
  }
}

/** Phase 2 (dev mode): file watching restarts the worker and reloads pages. */
async function devWatchPhase() {
  const binary = findServerBinary();
  const devDir = await copyFixtureForDev();
  // A page that always throws, for the error-detail checks. Written before
  // the server starts so the dev watcher never sees it change.
  await mkdir(join(devDir, 'app', 'dev-boom'), { recursive: true });
  await writeFile(
    join(devDir, 'app', 'dev-boom', 'page.tsx'),
    "export default function Boom() {\n  throw new Error('DEV_BOOM_DETAIL');\n}\n",
  );
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
      // open-in-editor runs this instead of a real editor.
      GIO_EDITOR: 'node -e 0',
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

    await test('dev: NODE_ENV=development loads .env.development, not .env.production', async () => {
      const body = await (await fetch(`${BASE}/api/env`)).json();
      assert.equal(body.precedence, 'from-env-development');
    });

    await test('dev: a rejected client bundle is handed to the error overlay', async () => {
      const html = await (await fetch(`${BASE}/server-only-leak`)).text();
      assert.match(html, /SERVER_ONLY_LEAK_FIXTURE/);
      assert.match(
        html,
        /window\.__GIO_SSR_ERROR__=\{"message":"client bundle for route \\"\/server-only-leak\\" imports server-only code/,
      );
      assert.match(html, /__gio_dev_overlay_script/);
    });

    const trustedHost = new URL(BASE).host;
    const codeframePath = '/_gio/devtools/codeframe?file=app%2Fpage.tsx&line=1';
    const editorPath = '/_gio/devtools/open-in-editor?file=app%2Fpage.tsx&line=1';

    await test('dev endpoints: a foreign Host (DNS rebinding) is refused with a fix hint', async () => {
      for (const path of ['/_gio/devtools', '/_gio/devtools/state', '/_gio/devtools/stream', codeframePath]) {
        const res = await rawRequest('GET', path, { host: 'evil.example' });
        assert.equal(res.status, 403, `${path} must refuse Host: evil.example`);
        assert.match(res.body, /allowed_hosts/);
      }
      const post = await rawRequest('POST', editorPath, { host: 'evil.example' });
      assert.equal(post.status, 403);
      // /_gio/* is not rate limited: a page looping these requests must not
      // flood the terminal, so the same rejection is warned about once.
      const blocked = () => log.match(/dev endpoint request blocked.*evil\.example/g) ?? [];
      await waitFor('blocked-request warning', () => Promise.resolve(blocked().length > 0), 5_000);
      await sleep(250);
      assert.equal(blocked().length, 1, 'five identical rejections, one warning');
    });

    await test('dev endpoints: localhost hosts are served, including the reload stream', async () => {
      const page = await rawRequest('GET', '/_gio/devtools', { host: trustedHost });
      assert.equal(page.status, 200);
      const frame = await rawRequest('GET', codeframePath, { host: trustedHost });
      assert.equal(frame.status, 200);
      assert.match(frame.body, /INTEGRATION_FIXTURE_HOME|import React/);
      const stream = await rawRequest('GET', '/_gio/devtools/stream', {
        host: trustedHost,
        'sec-fetch-site': 'same-origin',
      });
      assert.equal(stream.status, 200);
      const localhostName = await rawRequest('GET', '/_gio/devtools/state', {
        host: `localhost:${new URL(BASE).port}`,
      });
      assert.equal(localhostName.status, 200);
    });

    await test('dev endpoints: cross-site reads of source are refused', async () => {
      const crossSite = await rawRequest('GET', codeframePath, {
        host: trustedHost,
        'sec-fetch-site': 'cross-site',
      });
      assert.equal(crossSite.status, 403);
      const foreignOrigin = await rawRequest('GET', codeframePath, {
        host: trustedHost,
        origin: 'https://evil.example',
      });
      assert.equal(foreignOrigin.status, 403);
    });

    await test('dev endpoints: open-in-editor is same-origin POST only', async () => {
      const viaGet = await rawRequest('GET', editorPath, { host: trustedHost });
      assert.equal(viaGet.status, 405, 'a GET is triggerable by <img src> and must not open anything');
      const crossSite = await rawRequest('POST', editorPath, {
        host: trustedHost,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      });
      assert.equal(crossSite.status, 403);
      const sameSite = await rawRequest('POST', editorPath, {
        host: trustedHost,
        'sec-fetch-site': 'same-site',
      });
      assert.equal(sameSite.status, 403);
      const sameOrigin = await rawRequest('POST', editorPath, {
        host: trustedHost,
        origin: BASE,
        'sec-fetch-site': 'same-origin',
      });
      assert.equal(sameOrigin.status, 200, sameOrigin.body);
    });

    await test('dev endpoints: a symlink named like source cannot expose other files', async () => {
      // Outside app/ so the dev watcher does not restart the worker under
      // the watch tests below.
      await writeFile(join(devDir, 'secret.env'), 'TOKEN=integration-secret\n');
      // Symlinks need Developer Mode / admin rights on Windows.
      if (process.platform !== 'win32') {
        await symlink(join(devDir, 'secret.env'), join(devDir, 'leak.ts'));
        const res = await rawRequest('GET', '/_gio/devtools/codeframe?file=leak.ts&line=1', {
          host: trustedHost,
        });
        assert.equal(res.status, 400);
        assert.doesNotMatch(res.body, /integration-secret/);
      }
      const direct = await rawRequest('GET', '/_gio/devtools/codeframe?file=secret.env&line=1', {
        host: trustedHost,
      });
      assert.equal(direct.status, 400);
    });

    await test('dev error pages: message and stack only reach localhost hosts', async () => {
      const local = await rawRequest('GET', '/dev-boom', { host: trustedHost });
      assert.equal(local.status, 500);
      assert.match(local.body, /"stack":"[^"]*DEV_BOOM_DETAIL/, 'localhost gets the overlay payload');
      // DNS rebinding: the attacker's page reads this same-origin under its own Host.
      const rebound = await rawRequest('GET', '/dev-boom', { host: 'evil.example' });
      assert.equal(rebound.status, 500);
      assert.doesNotMatch(rebound.body, /DEV_BOOM_DETAIL/);
      assert.match(rebound.body, /"stack":null/);
      assert.match(rebound.body, /allowed_hosts/);
    });

    await test('dev mode: the worker is development and errors keep the full overlay', async () => {
      assert.match(await (await fetch(`${BASE}/node-env`)).text(), /WORKER_NODE_ENV=development/);
      const res = await fetch(`${BASE}/boom`);
      assert.equal(res.status, 500);
      const html = await res.text();
      assert.match(html, /FIXTURE_SECRET_FAILURE/);
      assert.match(html, /__GIO_SSR_ERROR__/);
      assert.match(html, /"stack":"Error: FIXTURE_SECRET_FAILURE/);
      assert.match(html, /__gio_dev_overlay_script/);
    });

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

      // CI Windows runners are 2-core and cold: worker respawn (tsx boot +
      // esbuild bundling) can far exceed local timings, and the OS watcher
      // occasionally drops the very first change event under load - re-touch
      // the file if nothing happened after 30s (a dead respawn still fails:
      // re-touching cannot revive a supervisor that cannot reconnect).
      const editDeadline = Date.now() + 90_000;
      let retouches = 0;
      await waitFor('watch-triggered restart to serve the edit', async () => {
        const html = await (await fetch(`${BASE}/`)).text();
        if (html.includes('WATCH_UPDATED_HOME')) return true;
        const elapsed = 90_000 - (editDeadline - Date.now());
        if (elapsed > 30_000 * (retouches + 1) && retouches < 2) {
          retouches++;
          console.log(`  (re-touching edited file - watch event likely dropped, attempt ${retouches})`);
          await writeFile(homeFile, await readFile(homeFile, 'utf8'));
        }
        return false;
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
    console.error(significantLogTail(log));
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
      "import React from 'react';\n\nexport default function Home() {\n" +
        '  return <h1>STANDALONE_FIXTURE_HOME {process.env.GIO_PUBLIC_STANDALONE_GREETING}</h1>;\n}\n',
    );
    await writeFile(
      join(workDir, 'app', 'api', 'hello', 'route.ts'),
      'export function GET() {\n' +
        '  const { GIO_PUBLIC_STANDALONE_GREETING } = process.env;\n' +
        "  return { ok: true, source: 'standalone', dotenv: process.env.GIO_STANDALONE_DOTENV ?? null,\n" +
        '    buildOnly: process.env.GIO_STANDALONE_BUILD_ONLY ?? null,\n' +
        '    publicDestructured: GIO_PUBLIC_STANDALONE_GREETING ?? null };\n}\n',
    );
    // Build-time env: the public value is frozen into the bundles; the
    // server-only one must not travel into the deploy dir.
    await writeFile(
      join(workDir, '.env.production'),
      'GIO_PUBLIC_STANDALONE_GREETING=STANDALONE_PUBLIC_VALUE\nGIO_STANDALONE_BUILD_ONLY=build-machine\n',
    );
    // A group layout above a dynamic page: the prebuilt registry must carry
    // each page's folder so layouts still apply by ancestry.
    await mkdir(join(workDir, 'app', '(blog)', 'posts', '[id]'), { recursive: true });
    await writeFile(
      join(workDir, 'app', '(blog)', 'layout.tsx'),
      "import React from 'react';\n\nexport default function BlogLayout({ children }) {\n  return <section data-layout=\"STANDALONE_BLOG_LAYOUT\">{children}</section>;\n}\n",
    );
    await writeFile(
      join(workDir, 'app', '(blog)', 'posts', '[id]', 'page.tsx'),
      "import React from 'react';\n\nexport default function Post({ params }) {\n  return <p>{`STANDALONE_POST id=[${params.id}]`}</p>;\n}\n",
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
      assert.match(build.stdout, /env: {4}\.env\.production/);
      assert.ok(!existsSync(join(outDir, '.env.production')), 'build-time .env files are not copied');
    });

    // Runtime env lives in the deploy dir: run.mjs starts the server there.
    await writeFile(join(outDir, '.env'), 'GIO_STANDALONE_DOTENV=from-deploy-dir\n');

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
      // GIO_PUBLIC_* frozen at build time into both the chunk and the SSR
      // render, so hydration sees the same value the server rendered.
      assert.match(await chunkRes.text(), /STANDALONE_PUBLIC_VALUE/);
      assert.match(html, /STANDALONE_FIXTURE_HOME (<!-- -->)?STANDALONE_PUBLIC_VALUE/);
    });

    await test('standalone: route.ts API handler responds from the bundle', async () => {
      const res = await fetch(`${STANDALONE_BASE}/api/hello`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await res.json(), {
        ok: true,
        source: 'standalone',
        // Loaded by the server from the deploy dir at startup...
        dotenv: 'from-deploy-dir',
        // ...while the build machine's server variables stay behind.
        buildOnly: null,
        // Frozen GIO_PUBLIC_* values hold for destructured reads too, as
        // they do in the client chunks.
        publicDestructured: 'STANDALONE_PUBLIC_VALUE',
      });
    });

    await test('standalone: group layouts apply to dynamic pages from the prebuilt registry', async () => {
      const res = await fetch(`${STANDALONE_BASE}/posts/7`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /STANDALONE_POST id=\[7\]/);
      assert.ok(html.indexOf('STANDALONE_BLOG_LAYOUT') !== -1, 'the (blog) layout must apply');
      assert.ok(html.indexOf('STANDALONE_BLOG_LAYOUT') < html.indexOf('STANDALONE_POST'));
      assert.doesNotMatch(await (await fetch(`${STANDALONE_BASE}/`)).text(), /STANDALONE_BLOG_LAYOUT/);
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
    console.error(significantLogTail(log));
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
  await unsetNodeEnvPhase();
}
if (process.exitCode !== 1) {
  await inheritedModePhase();
}
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
