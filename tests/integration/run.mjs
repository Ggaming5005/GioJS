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
import { existsSync, readlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHmac, hkdfSync } from 'node:crypto';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtureDir = join(repoRoot, 'tests', 'integration', 'fixture');
const BASE = 'http://127.0.0.1:39517';
const EXT = process.platform === 'win32' ? '.exe' : '';
// Every server spawned here inherits process.env and must listen where its
// gio.toml (or its phase) says: an ambient PORT or GIO_PORT - exported by
// Replit, Codespaces-style containers, `heroku local` - would override that
// and leave the harness waiting on BASE. Phases that test them set them.
delete process.env.PORT;
delete process.env.GIO_PORT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with the request-target sent byte-for-byte. fetch() runs the URL
 * parser first, which resolves dot segments - exactly the spellings the
 * path-hygiene tests need to put on the wire.
 */
function rawGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: 39517, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

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
 * status, headers and body; event streams resolve on headers and are torn
 * down.
 */
function rawRequest(method, path, headers = {}, body = undefined) {
  const url = new URL(path, BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        if (String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
          resolve({ status: res.statusCode, headers: res.headers, body: '' });
          res.destroy();
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Send a WebSocket upgrade request and resolve with the status code of the
 * answer (101 when accepted), tearing the connection down right after.
 */
function upgradeStatus(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(39517, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1:39517',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      const line = data.split('\r\n')[0];
      if (data.includes('\r\n')) {
        socket.destroy();
        resolve(Number(line.split(' ')[1]));
      }
    });
    socket.on('error', reject);
  });
}

/** The nonce a CSP header value grants (`'nonce-…'`), or null. */
function cspNonceOf(csp) {
  return /'nonce-([^']+)'/.exec(csp ?? '')?.[1] ?? null;
}

/** Opening tags of every executable script (JSON data blocks excluded). */
function executableScriptTags(html) {
  return [...html.matchAll(/<script\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => !tag.includes('type="application/json"'));
}

/**
 * Assert the CSP header carries a nonce and every executable script in the
 * body carries exactly that nonce. Returns the nonce.
 */
function assertNoncedResponse(res, html, what) {
  const nonce = cspNonceOf(res.headers.get('content-security-policy'));
  assert.ok(nonce, `${what}: CSP header with a nonce`);
  assert.match(nonce, /^[A-Za-z0-9+/]{32}$/, `${what}: 192-bit base64 nonce`);
  const tags = executableScriptTags(html);
  assert.ok(tags.length > 0, `${what}: has inline/bootstrap scripts`);
  for (const tag of tags) {
    assert.ok(tag.includes(` nonce="${nonce}"`), `${what}: ${tag} must carry the header nonce`);
  }
  return nonce;
}

/** Enables POST /_gio/revalidate in the main phase (GIO_REVALIDATE_TOKEN). */
const REVALIDATE_TOKEN = 'integration-fixture-revalidate-token-0123456789';

/** POST /_gio/revalidate with a JSON body and (by default) the right token. */
function revalidateRequest(body, headers = {}) {
  return rawRequest('POST', '/_gio/revalidate', {
    authorization: `Bearer ${REVALIDATE_TOKEN}`,
    'content-type': 'application/json',
    ...headers,
  }, typeof body === 'string' ? body : JSON.stringify(body));
}

/** GET a fixture article; resolves with its version and X-Gio-Cache label. */
async function getArticle(path) {
  const res = await fetch(`${BASE}${path}`);
  assert.equal(res.status, 200, path);
  const html = await res.text();
  const version = Number(html.match(/FIXTURE_ARTICLE id=\[[^\]]*\] version=\[(\d+)\]/)?.[1]);
  return { version, cache: res.headers.get('x-gio-cache') ?? '' };
}

/** The fixture's .env.production session secret. */
const FIXTURE_SESSION_SECRET = 'integration-fixture-session-secret-0123456789';

/**
 * Re-sign a session token's MAC with a new expiry, independently of
 * session.ts (format: v1.<exp>.<payload>.<mac>, MAC over
 * "<cookie>\nv1.<exp>.<payload>" with an HKDF-derived key). The payload's
 * AES-GCM AAD still names the old expiry, so only the MAC is valid.
 */
function resignSession(token, exp, secret = FIXTURE_SESSION_SECRET, cookie = 'gio_session') {
  const [version, , payload] = token.split('.');
  const signed = `${version}.${exp}.${payload}`;
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'gio-session-mac', 32));
  return `${signed}.${createHmac('sha256', key).update(`${cookie}\n${signed}`).digest('base64url')}`;
}

/** Log in through the fixture's /api/login; resolves to the response. */
function loginAs(user, password = 'fixture-password') {
  return fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });
}

/** The `gio_session=<token>` pair from a login response. */
function sessionCookieOf(res) {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('gio_session='));
  assert.ok(cookie, 'login sets gio_session');
  return cookie.split(';')[0];
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
 * Every process below `rootPid` (Unix: `ps`), so a test can watch a whole
 * tree - the server, the tsx wrapper and the worker runtime under it.
 */
function descendantPids(rootPid) {
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout;
  const children = new Map();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Unix: true while `pid` runs (a zombie awaiting its reaper counts as gone). */
function processRunning(pid) {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
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
 * Dev-watch (and the gio.toml-change and CSP phases) need a fixture they can
 * mutate, each in its own `name`d copy. The copy lives at the same directory
 * depth as the original so the fixture's relative `../../../packages/`
 * imports keep resolving.
 */
async function copyFixtureForDev(name = '.dev-fixture') {
  const devDir = join(repoRoot, 'tests', 'integration', name);
  await rm(devDir, { recursive: true, force: true });
  const items = [
    'app', 'lib', 'components', 'public', 'gio.toml', 'gio.config.ts', 'middleware.ts', 'package.json',
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
      GIO_REVALIDATE_TOKEN: REVALIDATE_TOKEN,
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

    await test('the worker types the discovered routes into the global registry (.gio/routes.d.ts)', async () => {
      // @gio.js/react (href, useParams) and @gio.js/core (PageProps,
      // GsspContext, GioRequest) both read GioJS.RegisteredRoutes.
      const types = await readFile(join(fixtureDir, '.gio', 'routes.d.ts'), 'utf8');
      assert.match(types, /declare global \{\n {2}namespace GioJS \{\n {4}interface RegisteredRoutes \{/);
      assert.match(types, /'\/posts\/:id': \{ id: string \};/);
      assert.match(types, /'\/docs\/\*slug': \{ slug: string \};/);
      assert.match(types, /'\/shop\/\*path\?': \{ path\?: string \};/);
      assert.doesNotMatch(types, /declare module/);
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

    await test('GioImage renders only the gio.toml [images] widths, and every candidate serves', async () => {
      const res = await fetch(`${BASE}/image`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /IMAGE_FIXTURE/);
      const decode = (s) => s.replace(/&amp;/g, '&');
      const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
      const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
      const [fixed, responsive, plain] = imgs;
      assert.ok(fixed && responsive && plain, 'three images rendered');
      const urls = new Set();
      for (const tag of [fixed, responsive]) {
        urls.add(decode(attr(tag, 'src')));
        for (const candidate of decode(attr(tag, 'srcSet') ?? '').split(', ')) {
          urls.add(candidate.split(' ')[0]);
        }
      }
      const widths = [...urls].map((u) => Number(new URL(u, BASE).searchParams.get('w')));
      assert.deepEqual([...new Set(widths)].sort((a, b) => a - b), [48, 96, 640]);
      assert.match(attr(fixed, 'srcSet'), /w=48&amp;q=70 1x, .*w=96&amp;q=70 2x/);
      assert.equal(attr(responsive, 'sizes'), '50vw');
      assert.equal(attr(plain, 'src'), '/gio-test.png');
      // priority: preloaded (React hoists it ahead of the content).
      assert.match(html, /<link rel="preload" as="image"[^>]*imageSrcSet="[^"]*w=48[^"]*"[^>]*fetchPriority="high"/);
      // The browser renders the same srcsets when it hydrates.
      const envelope = JSON.parse(html.match(/<script id="__gio_props" type="application\/json">([^<]*)</)[1]);
      assert.deepEqual(envelope.images, { widths: [48, 96, 640], quality: 70, unoptimized: false });
      for (const url of urls) {
        const image = await fetch(`${BASE}${url}`, { headers: { accept: 'image/webp' } });
        assert.equal(image.status, 200, `${url} must be servable`);
        assert.match(image.headers.get('content-type') ?? '', /^image\//);
        await image.arrayBuffer();
      }
      // A src names the file by the URL it is served at: /public/x is public/x too.
      const aliased = await fetch(`${BASE}/_gio/image?src=${encodeURIComponent('/public/gio-test.png')}&w=48`);
      assert.equal(aliased.status, 200);
      await aliased.arrayBuffer();
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

    await test('route.ts Response cookies arrive as separate Set-Cookie headers', async () => {
      const res = await fetch(`${BASE}/api/session`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.headers.getSetCookie(), [
        'session=s1; Path=/; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        'csrf=c1; Path=/; SameSite=Strict',
      ]);
    });

    await test('getServerSideProps cookies arrive separately and keep the page uncached', async () => {
      const expected = [
        'session=s2; Path=/; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        'csrf=c2; Path=/; SameSite=Strict',
      ];
      // GET streams (uncacheable render); HEAD takes the buffered path.
      const first = await fetch(`${BASE}/account`);
      assert.match(await first.text(), /INTEGRATION_FIXTURE_ACCOUNT/);
      assert.deepEqual(first.headers.getSetCookie(), expected);
      const second = await fetch(`${BASE}/account`);
      await second.text();
      assert.deepEqual(second.headers.getSetCookie(), expected);
      assert.equal(second.headers.get('x-gio-cache'), 'bypass', 'cookie pages must never be cached');
      const head = await fetch(`${BASE}/account`, { method: 'HEAD' });
      assert.deepEqual(head.headers.getSetCookie(), expected);
    });

    await test('getServerSideProps redirects carry their cookies', async () => {
      const res = await fetch(`${BASE}/logout`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      assert.deepEqual(res.headers.getSetCookie(), [
        'session=; Path=/; Max-Age=0',
        'csrf=; Path=/; Max-Age=0',
      ]);
    });

    await test('a cookie in both the headers map and setCookies is sent once', async () => {
      const res = await fetch(`${BASE}/plugin-cookies`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
    });

    await test('a set-cookie header rule adds to the response cookies instead of replacing them', async () => {
      const res = await fetch(`${BASE}/rule-cookies`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.headers.getSetCookie(), [
        'session=r1; Path=/; HttpOnly',
        'csrf=r2; Path=/',
        'consent=1; Path=/',
      ]);
    });

    await test('a plugin setCookies of null answers at once with no cookies', async () => {
      // A frame that fails to parse leaves the request waiting for the 30s
      // IPC timeout; the short signal turns that hang into a failure.
      const res = await fetch(`${BASE}/plugin-cookies-null`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'no cookies');
      assert.deepEqual(res.headers.getSetCookie(), []);
    });

    await test('event-stream Response cookies arrive as separate Set-Cookie headers', async () => {
      const res = await fetch(`${BASE}/api/events`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.deepEqual(res.headers.getSetCookie(), [
        'sse_a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        'sse_b=2; Path=/; HttpOnly',
      ]);
      // The body used to hang forever (it took the sse_chunk path); it now
      // streams and the response ends.
      assert.equal(await res.text(), 'data: hello\n\n');
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

    await test('router hooks render the request route in SSR, and the envelope carries the same info', async () => {
      const res = await fetch(`${BASE}/router-hooks/first-post?q=a%20b&x=1`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /ROUTER_HOOKS_PAGE pathname=\[\/router-hooks\/first-post\] slug=\[first-post\] q=\[a b\]/);
      assert.match(
        html,
        /ROUTER_HOOKS_LAYOUT pathname=\[\/router-hooks\/first-post\] params=\[\{&quot;slug&quot;:&quot;first-post&quot;\}\]/,
      );
      const envelope = JSON.parse(html.match(/<script id="__gio_props" type="application\/json">([^<]*)</)[1]);
      assert.equal(envelope.path, '/router-hooks/first-post');
      assert.equal(envelope.pattern, '/router-hooks/:slug');
      assert.deepEqual(envelope.params, { slug: 'first-post' });
      assert.equal(typeof envelope.locale, 'string');
      // The client provides what the server rendered with: same query values.
      const search = new URLSearchParams(envelope.search);
      assert.equal(search.get('q'), 'a b');
      assert.equal(search.get('x'), '1');
      assert.ok(entryChunkOf(html), 'the hooks page hydrates');
    });

    await test('a not-found page keeps the #__gio boundary soft navigation renders in place', async () => {
      const res = await fetch(`${BASE}/router-hooks-nowhere/deep`);
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      assert.match(await res.text(), /<div id="__gio">/);
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

    await test('route.ts event-stream Responses stream incrementally and terminate', async () => {
      // Accept-Encoding asks for compression: an event stream must never be
      // compressed (an encoder buffers) or the first event would wait.
      const res = await fetch(`${BASE}/api/stream-events`, {
        headers: { 'accept-encoding': 'gzip, br' },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.equal(res.headers.get('content-encoding'), null);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.deepEqual(res.headers.getSetCookie(), [
        'stream_a=1; Path=/',
        'stream_b=2; Path=/; HttpOnly',
      ]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      assert.match(first, /data: first/);
      assert.doesNotMatch(first, /second/, 'the first event arrives while the stream is still open');
      let rest = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
      }
      assert.match(rest, /data: second/, 'the stream ends after its last event');
    });

    await test('a streamed route.ts HTML body without a head arrives chunk by chunk', async () => {
      // No </head> to find: a head-injecting scan would hold the first token
      // back until the stream ended (1.5s later).
      const started = Date.now();
      const res = await fetch(`${BASE}/api/html-report?stream=tokens`, {
        headers: { 'accept-encoding': 'identity' },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      while (!html.includes('TOKEN_0')) {
        const { done, value } = await reader.read();
        assert.ok(!done, 'the stream ended before its first token');
        html += decoder.decode(value, { stream: true });
      }
      const firstMs = Date.now() - started;
      assert.doesNotMatch(html, /TOKEN_1/, 'the first token arrives while the stream is still open');
      assert.ok(firstMs < 1200, `first token took ${firstMs}ms`);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
      }
      // The handler owns its body: nothing is spliced into it.
      assert.equal(html, '<p>INTEGRATION_FIXTURE_TOKEN_0</p><p>INTEGRATION_FIXTURE_TOKEN_1</p>');
    });

    await test('a client disconnect cancels a streamed route.ts body in the worker', async () => {
      const cancelled = async () =>
        (await (await fetch(`${BASE}/api/stream-endless?state=1`)).json()).cancelled;
      const before = await cancelled();
      const controller = new AbortController();
      const res = await fetch(`${BASE}/api/stream-endless`, { signal: controller.signal });
      const reader = res.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /data: 0/);
      controller.abort();
      await waitFor('the worker to cancel the body', async () => (await cancelled()) > before, 5000);
    });

    await test('a large streamed binary body arrives intact', async () => {
      // Default fetch negotiates compression: streaming and compression compose.
      const res = await fetch(`${BASE}/api/download`);
      assert.equal(res.status, 200);
      const total = Number(res.headers.get('x-download-bytes'));
      const body = Buffer.from(await res.arrayBuffer());
      const expected = Buffer.alloc(total);
      for (let i = 0; i < total; i++) expected[i] = (i * 31 + (i >> 8)) & 0xff;
      assert.equal(body.length, total);
      assert.ok(body.equals(expected), 'every byte must survive the chunked, base64 crossing');
    });

    await test('a client that stops reading stops a streamed body\'s producer', async () => {
      const produced = async () =>
        (await (await fetch(`${BASE}/api/download?state=1`)).json()).produced;
      // identity: compression would shrink the pattern enough that socket
      // buffers take far longer to fill.
      const res = await new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: 39517, path: '/api/download?endless=1', headers: { 'accept-encoding': 'identity' } },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
      try {
        await new Promise((resolve) => res.once('data', resolve));
        res.pause();
        // Without backpressure the worker produces until memory runs out;
        // with it, the producer stalls once Rust and the socket buffers hold
        // a bounded amount.
        let last = -1;
        const stalledAt = await waitFor('the producer to stall', async () => {
          const now = await produced();
          const stalled = now === last;
          last = now;
          return stalled ? now : undefined;
        }, 10000);
        assert.ok(stalledAt < 64 * 1024 * 1024, `stalled after ${stalledAt} bytes`);
        res.resume();
        await waitFor('the producer to resume', async () => (await produced()) > stalledAt, 5000);
      } finally {
        res.destroy();
      }
    });

    /**
     * A WebSocket client on the fixture: `next()` resolves the next message,
     * `closed` the close code and reason.
     */
    function wsClient(path, headers = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:39517${path}`, { headers });
      const inbox = [];
      const listeners = new Set();
      ws.addEventListener('message', (event) => {
        inbox.push(String(event.data));
        for (const listener of listeners) listener();
      });
      const opened = new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error(`WebSocket ${path} failed to open`)), { once: true });
      });
      const closed = new Promise((resolve) =>
        ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }), { once: true }),
      );
      let cursor = 0;
      const next = (timeoutMs = 3000) => new Promise((resolve, reject) => {
        const check = () => {
          if (cursor >= inbox.length) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve(inbox[cursor++]);
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`no WebSocket message on ${path} within ${timeoutMs}ms (got ${JSON.stringify(inbox)})`));
        }, timeoutMs);
        listeners.add(check);
        check();
      });
      return { ws, inbox, opened, closed, next };
    }

    await test('WebSocket routes match [param] patterns and see the connection context', async () => {
      const client = wsClient('/ws/rooms/lobby?token=t1', {
        cookie: 'theme=dark; sid=abc',
        'user-agent': 'gio-int-ws',
        'x-forwarded-for': '198.51.100.23',
        'x-request-id': 'ws-req-1',
      });
      await client.opened;
      const hello = JSON.parse(await client.next());
      assert.equal(hello.type, 'hello');
      assert.equal(hello.path, '/ws/rooms/lobby');
      assert.deepEqual(hello.params, { room: 'lobby' });
      assert.deepEqual(hello.query, { token: 't1' });
      assert.deepEqual(hello.cookies, { theme: 'dark', sid: 'abc' });
      assert.equal(hello.userAgent, 'gio-int-ws');
      assert.equal(hello.forwardedFor, null, 'only the allowlisted headers reach the worker');
      assert.equal(hello.ip, '198.51.100.23', 'the trusted proxy names the client');
      assert.equal(hello.requestId, 'ws-req-1');
      assert.deepEqual(hello.rooms, ['lobby']);
      client.ws.close();
      assert.equal((await client.closed).code, 1005);
    });

    await test('room broadcasts stay in their room, and route handlers can publish to a room', async () => {
      const a1 = wsClient('/ws/rooms/a');
      const a2 = wsClient('/ws/rooms/a');
      const b = wsClient('/ws/rooms/b');
      await Promise.all([a1.opened, a2.opened, b.opened]);
      await Promise.all([a1.next(), a2.next(), b.next()]); // greetings
      a1.ws.send('ping');
      assert.equal(await a1.next(), 'a:ping', 'the sender is a member too');
      assert.equal(await a2.next(), 'a:ping');

      const published = await fetch(`${BASE}/api/rooms/b`, { method: 'POST', body: 'news' });
      assert.deepEqual(await published.json(), { delivered: true });
      // Frames are dispatched in order: had b been in room a, a:ping would
      // have reached it first.
      assert.equal(await b.next(), 'server:news');
      await fetch(`${BASE}/api/rooms/a`, { method: 'POST', body: 'marker' });
      assert.equal(await a1.next(), 'server:marker', 'room a never sees room b traffic');
      assert.equal(await a2.next(), 'server:marker');
      for (const client of [a1, a2, b]) client.ws.close();
      await Promise.all([a1.closed, a2.closed, b.closed]);
    });

    await test('a wsHandler authenticates with the session cookie and rejects with 4401', async () => {
      const anonymous = wsClient('/ws/private');
      await anonymous.opened;
      anonymous.ws.send('before the verdict');
      assert.deepEqual(await anonymous.closed, { code: 4401, reason: 'unauthorized' });
      assert.deepEqual(anonymous.inbox, [], 'a rejected socket never sees a message');

      const cookie = sessionCookieOf(await loginAs('ws-user'));
      const member = wsClient('/ws/private', { cookie });
      await member.opened;
      member.ws.send('early'); // lands while the async handler is still deciding
      assert.equal(await member.next(), 'welcome ws-user');
      assert.equal(await member.next(), 'echo:early', 'messages before acceptance are held, not lost');
      member.ws.close();
      await member.closed;
    });

    await test('a socket its handler has not accepted yet sees no route or room broadcast', async () => {
      const pub = wsClient('/ws/members?role=pub');
      await pub.opened;
      assert.equal(await pub.next(), 'ready');
      const anon = wsClient('/ws/members');
      await anon.opened;
      await new Promise((resolve) => setTimeout(resolve, 100)); // its handler is deciding (500ms)
      pub.ws.send('members-only secret');
      assert.equal(await pub.next(), 'members-only secret', 'the route broadcast went out');
      const published = await fetch(`${BASE}/api/rooms/members-feed`, { method: 'POST', body: 'room secret' });
      assert.deepEqual(await published.json(), { delivered: true });
      assert.equal(await pub.next(), 'server:room secret', 'the room broadcast went out');
      assert.deepEqual(await anon.closed, { code: 4401, reason: 'unauthorized' });
      assert.deepEqual(anon.inbox, [], 'the rejected socket never saw a broadcast');
      pub.ws.close();
      await pub.closed;
    });

    await test('an async wsHandler can authenticate with the first message', async () => {
      const member = wsClient('/ws/token');
      await member.opened;
      member.ws.send('let-me-in');
      assert.equal(await member.next(), 'welcome');
      member.ws.close();
      await member.closed;

      const forger = wsClient('/ws/token');
      await forger.opened;
      forger.ws.send('forged');
      assert.deepEqual(await forger.closed, { code: 4401, reason: 'unauthorized' });
    });

    await test('rejected and unrouted WebSocket connections close with 4401 / 4404', async () => {
      const denied = wsClient('/ws/rooms/x?deny=1');
      await denied.opened;
      assert.deepEqual(await denied.closed, { code: 4401, reason: 'unauthorized' });
      const nowhere = wsClient('/ws/nowhere');
      await nowhere.opened;
      assert.deepEqual(await nowhere.closed, { code: 4404, reason: 'no websocket handler' });
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

    await test('cached pages: CDN Cache-Control, a weak ETag, and 304 for If-None-Match', async () => {
      const hit = await fetch(`${BASE}/cached`);
      const body = await hit.text();
      assert.match(hit.headers.get('x-gio-cache') ?? '', /^hit; ttl=\d+$/);
      assert.match(
        hit.headers.get('cache-control') ?? '',
        /^public, max-age=0, s-maxage=\d+, stale-while-revalidate=\d+$/,
      );
      const etag = hit.headers.get('etag');
      // Weak: the compression layer serves gzip, br and identity bytes
      // under it, and a strong tag must differ per content coding.
      assert.match(etag ?? '', /^W\/"[0-9a-f]{32}"$/, 'weak ETag');

      const revalidated = await rawGet('/cached', { 'if-none-match': etag });
      assert.equal(revalidated.status, 304);
      assert.equal(revalidated.body, '');
      assert.equal(revalidated.headers.etag, etag);
      assert.equal(revalidated.headers['cache-control'], hit.headers.get('cache-control'));
      // A 304 is still a response of this server: request id, security
      // defaults and header rules all apply.
      assert.match(revalidated.headers['x-request-id'] ?? '', /^[0-9a-f-]{36}$/);
      assert.equal(revalidated.headers['x-content-type-options'], 'nosniff');
      assert.equal(revalidated.headers['x-frame-options'], 'DENY');
      // ...and the Vary its 200 got from the compression layer (RFC 9110
      // 15.4.5) - whatever that is for this page's size...
      assert.equal(revalidated.headers.vary ?? null, hit.headers.get('vary'));
      // ...accept-encoding for one large enough, whatever the client accepts.
      const large = await fetch(`${BASE}/cached-large`);
      assert.match(await large.text(), /INTEGRATION_FIXTURE_CACHED_LARGE/);
      assert.equal(large.headers.get('vary'), 'accept-encoding');
      const largeRevalidated = await rawGet('/cached-large', { 'if-none-match': large.headers.get('etag') });
      assert.equal(largeRevalidated.status, 304);
      assert.equal(largeRevalidated.headers.vary, 'accept-encoding');
      for (const coding of ['gzip', 'br', 'identity']) {
        const variant = await rawGet('/cached-large', { 'accept-encoding': coding });
        assert.equal(variant.status, 200, coding);
        assert.equal(variant.headers['content-encoding'], coding === 'identity' ? undefined : coding);
        assert.match(variant.headers.etag ?? '', /^W\//, `${coding} bytes carry a weak ETag`);
      }

      const changed = await rawGet('/cached', { 'if-none-match': '"0123456789abcdef0123456789abcdef"' });
      assert.equal(changed.status, 200);
      assert.equal(changed.body, body);
    });

    await test('guarded or authorized cached pages never go public: a CDN would skip the guard', async () => {
      const blocked = await fetch(`${BASE}/guarded-cached`, { redirect: 'manual' });
      assert.equal(blocked.status, 302);
      assert.equal(blocked.headers.get('location'), '/login');
      const member = { cookie: 'session=member' };
      const miss = await fetch(`${BASE}/guarded-cached`, { headers: member });
      assert.match(await miss.text(), /INTEGRATION_FIXTURE_GUARDED_CACHED/);
      const hit = await fetch(`${BASE}/guarded-cached`, { headers: member });
      await hit.text();
      // GioJS itself still caches the page: its guard runs before the cache.
      assert.equal(miss.headers.get('x-gio-cache'), 'miss; stored');
      assert.match(hit.headers.get('x-gio-cache') ?? '', /^hit; ttl=\d+$/);
      for (const res of [miss, hit]) {
        assert.equal(res.headers.get('cache-control'), 'private, no-cache');
        assert.equal(res.headers.get('etag'), null);
      }

      // An open cached page asked for with credentials: private, no ETag, no 304.
      const open = await fetch(`${BASE}/cached`);
      await open.text();
      const etag = open.headers.get('etag');
      assert.match(etag ?? '', /^W\/"[0-9a-f]{32}"$/);
      const authorized = await rawGet('/cached', {
        authorization: 'Basic YWxpY2U6c2VjcmV0',
        'if-none-match': etag,
      });
      assert.equal(authorized.status, 200);
      assert.match(authorized.body, /INTEGRATION_FIXTURE_CACHED/);
      assert.equal(authorized.headers['cache-control'], 'private, no-cache');
      assert.equal(authorized.headers.etag, undefined);
    });

    await test('personal, streamed and app-controlled pages keep browsers and CDNs honest', async () => {
      // Personal (reads cookies): never public, never no-store (bfcache).
      const personal = await fetch(`${BASE}/personal`, { headers: { cookie: 'who=alice' } });
      assert.match(await personal.text(), /who=alice/);
      assert.equal(personal.headers.get('cache-control'), 'private, no-cache');
      assert.equal(personal.headers.get('etag'), null);
      // getServerSideProps set its own Cache-Control: it wins.
      const own = await fetch(`${BASE}/cache-headers`);
      assert.match(await own.text(), /INTEGRATION_FIXTURE_CACHE_HEADERS/);
      assert.equal(own.headers.get('cache-control'), 'public, max-age=30');
      // Route handlers are the app's business: no default added, even to HTML.
      const api = await fetch(`${BASE}/api/whoami`);
      assert.equal(api.headers.get('cache-control'), null);
      const htmlHandler = await fetch(`${BASE}/api/html-report`);
      assert.match(await htmlHandler.text(), /INTEGRATION_FIXTURE_HTML_ROUTE/);
      assert.match(htmlHandler.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(htmlHandler.headers.get('cache-control'), null);
      // Also when the handler's body streams (respond_stream, not the
      // buffered path).
      const streamedHandler = await fetch(`${BASE}/api/html-report?stream=1`);
      assert.match(await streamedHandler.text(), /INTEGRATION_FIXTURE_HTML_ROUTE_STREAMED/);
      assert.equal(streamedHandler.headers.get('cache-control'), null);
    });

    await test('a malformed worker response frame fails its request at once, with its request id logged', async () => {
      const started = Date.now();
      const res = await fetch(`${BASE}/plugin-malformed-frame`);
      assert.equal(res.status, 500);
      assert.ok(Date.now() - started < 5_000, 'answered long before the 30s IPC timeout');
      const id = res.headers.get('x-request-id');
      await waitFor('parse error logged with its request id', () =>
        Promise.resolve(log.replace(/\x1b\[[0-9;]*m/g, '').split('\n').some((line) =>
          line.includes('worker response frame failed to parse') &&
          line.includes(`request_id=${id}`))), 5_000);
      // The connection survived: the next request renders normally.
      assert.equal((await fetch(`${BASE}/cached`)).status, 200);
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

    await test('notFound() answers 404 with the nearest not-found.* inside its folder layout', async () => {
      for (const sku of ['gone', 'missing']) {
        const first = await fetch(`${BASE}/catalog/${sku}`);
        assert.equal(first.status, 404, sku);
        const html = await first.text();
        assert.match(html, /FIXTURE_CATALOG_NOT_FOUND/, sku);
        assert.doesNotMatch(html, /FIXTURE_CUSTOM_404/, `${sku}: the nearest file wins over app/not-found`);
        assert.ok(html.indexOf('FIXTURE_CATALOG_LAYOUT') !== -1, `${sku}: rendered inside the catalog layout`);
        assert.ok(html.indexOf('FIXTURE_CATALOG_LAYOUT') < html.indexOf('FIXTURE_CATALOG_NOT_FOUND'));
        // The page exports revalidate, but its 404 is never cached.
        const second = await fetch(`${BASE}/catalog/${sku}`);
        assert.equal(second.status, 404, sku);
        await second.text();
        assert.doesNotMatch(second.headers.get('x-gio-cache') ?? '', /hit/, `${sku}: a 404 must not be cached`);
      }
      const found = await fetch(`${BASE}/catalog/widget`);
      assert.equal(found.status, 200);
      assert.match(await found.text(), /FIXTURE_CATALOG_ITEM sku=\[widget\]/);
      // Unmatched URLs below the folder still get app/not-found.
      const unmatched = await fetch(`${BASE}/catalog/widget/reviews`);
      assert.equal(unmatched.status, 404);
      assert.match(await unmatched.text(), /FIXTURE_CUSTOM_404/);
    });

    await test('a cached page that starts answering notFound() is evicted by its revalidation', async () => {
      const first = await fetch(`${BASE}/retired`);
      assert.equal(first.status, 200);
      assert.match(await first.text(), /FIXTURE_RETIRED_PAGE/);
      const cached = await fetch(`${BASE}/retired`);
      await cached.text();
      assert.match(cached.headers.get('x-gio-cache') ?? '', /^hit/);
      const retire = await fetch(`${BASE}/retired`, { method: 'POST' });
      assert.equal(retire.status, 200);
      await retire.text();
      // Past max_age (1s) the stale copy goes out once more while the
      // background refresh renders...
      await sleep(1_100);
      const stale = await fetch(`${BASE}/retired`);
      assert.equal(stale.status, 200);
      await stale.text();
      assert.match(stale.headers.get('x-gio-cache') ?? '', /^stale; .*revalidating$/);
      // ...and that refresh's 404 evicts it, well inside the 10s SWR window.
      const gone = await waitFor('the retired page to answer 404', async () => {
        const res = await fetch(`${BASE}/retired`);
        const html = await res.text();
        return res.status === 404 ? html : undefined;
      }, 4_000);
      assert.match(gone, /FIXTURE_CUSTOM_404/);
    });

    await test('revalidateTag from a route handler purges the tagged page: the next request renders fresh', async () => {
      assert.deepEqual(await getArticle('/articles/1'), { version: 0, cache: 'miss; stored' });
      assert.match((await getArticle('/articles/1')).cache, /^hit/);
      await getArticle('/articles/2');
      assert.match((await getArticle('/articles/2')).cache, /^hit/);

      // getServerSideProps tagged the page article:1; the handler awaits the purge.
      const publish = await fetch(`${BASE}/api/articles/1`, { method: 'POST' });
      assert.equal(publish.status, 200);
      assert.deepEqual(await publish.json(), { ok: true, purged: 1 });
      assert.deepEqual(
        await getArticle('/articles/1'),
        { version: 1, cache: 'miss; stored' },
        'a purge, not a stale serve: the very next request is a miss with the new version',
      );
      assert.match((await getArticle('/articles/2')).cache, /^hit/, 'other tags are untouched');
    });

    await test('a burst of parallel revalidateTag calls is confirmed in full, none refused', async () => {
      // revalidateTag takes one tag, so a batch is N parallel calls; Rust
      // queues 64 purges per worker, and the worker must pace the rest.
      await getArticle('/articles/burst');
      for (let round = 0; round < 3; round++) {
        assert.match((await getArticle('/articles/burst')).cache, /^hit/);
        const res = await fetch(`${BASE}/api/revalidate-burst?n=300&id=burst`, { method: 'POST' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: 300, failed: 0, errors: [], purged: 1 }, `round ${round}`);
        assert.equal((await getArticle('/articles/burst')).cache, 'miss; stored', 'the real purge among them happened');
      }
    });

    await test('revalidatePath purges every query string of the page; the static tag purges the route', async () => {
      await getArticle('/articles/1?ref=feed');
      assert.match((await getArticle('/articles/1?ref=feed')).cache, /^hit/);
      assert.match((await getArticle('/articles/1')).cache, /^hit/);
      const byPath = await fetch(`${BASE}/api/articles/1?by=path`, { method: 'POST' });
      assert.deepEqual(await byPath.json(), { ok: true, purged: 2 });
      assert.deepEqual(await getArticle('/articles/1?ref=feed'), { version: 2, cache: 'miss; stored' });
      assert.equal((await getArticle('/articles/1')).cache, 'miss; stored');

      // export const tags = ['articles'] is on every article page.
      const all = await fetch(`${BASE}/api/articles/2?by=all`, { method: 'POST' });
      const result = await all.json();
      assert.equal(result.ok, true);
      assert.ok(result.purged >= 3, `every cached article purged (${result.purged})`);
      assert.deepEqual(await getArticle('/articles/2'), { version: 1, cache: 'miss; stored' });
    });

    await test('path purges reach pages with non-ASCII or space in their URL, given decoded or encoded', async () => {
      // A browser requests /articles/café as /articles/caf%C3%A9 - the
      // path the page is cached under - while a CMS knows the slug decoded.
      assert.equal((await getArticle('/articles/caf%C3%A9')).cache, 'miss; stored');
      assert.match((await getArticle('/articles/caf%C3%A9')).cache, /^hit/);
      const viaHandler = await fetch(`${BASE}/api/articles/caf%C3%A9?by=decoded`, { method: 'POST' });
      assert.deepEqual(await viaHandler.json(), { ok: true, purged: 1 }, "revalidatePath('/articles/café')");
      assert.deepEqual(await getArticle('/articles/caf%C3%A9'), { version: 1, cache: 'miss; stored' });

      await getArticle('/articles/a%20b');
      assert.match((await getArticle('/articles/a%20b')).cache, /^hit/);
      const viaEndpoint = await revalidateRequest({ paths: ['/articles/a b', '/articles/café'] });
      assert.equal(viaEndpoint.status, 200, viaEndpoint.body);
      assert.deepEqual(JSON.parse(viaEndpoint.body), { ok: true, purged: 2 });
      assert.equal((await getArticle('/articles/a%20b')).cache, 'miss; stored');
      assert.equal((await getArticle('/articles/caf%C3%A9')).cache, 'miss; stored');
    });

    await test('POST /_gio/revalidate: bearer token required, wrong ones are 401', async () => {
      const none = await rawRequest('POST', '/_gio/revalidate', { 'content-type': 'application/json' }, '{"tags":["articles"]}');
      assert.equal(none.status, 401);
      assert.equal(none.headers['www-authenticate'], 'Bearer');
      assert.equal(none.headers['cache-control'], 'no-store');
      const wrong = await revalidateRequest({ tags: ['articles'] }, { authorization: `Bearer ${REVALIDATE_TOKEN}x` });
      assert.equal(wrong.status, 401);
      const scheme = await revalidateRequest({ tags: ['articles'] }, { authorization: REVALIDATE_TOKEN });
      assert.equal(scheme.status, 401, 'the Bearer scheme is required');
      const lowercase = await revalidateRequest({ tags: ['nothing-carries-this'] }, { authorization: `bearer ${REVALIDATE_TOKEN}` });
      assert.equal(lowercase.status, 200, 'the scheme is case-insensitive');
      const get = await rawRequest('GET', '/_gio/revalidate', { authorization: `Bearer ${REVALIDATE_TOKEN}` });
      assert.equal(get.status, 405);
    });

    await test('POST /_gio/revalidate purges by tag and by path prefix, and validates its body', async () => {
      await getArticle('/articles/3');
      assert.match((await getArticle('/articles/3')).cache, /^hit/);
      // Bearer-authenticated, not cookie-authenticated: a cross-site
      // Origin (a CMS calling from its own site) is not a CSRF rejection.
      const byTag = await revalidateRequest({ tags: ['article:3'] }, {
        origin: 'https://cms.example',
        'sec-fetch-site': 'cross-site',
      });
      assert.equal(byTag.status, 200, byTag.body);
      assert.deepEqual(JSON.parse(byTag.body), { ok: true, purged: 1 });
      assert.equal((await getArticle('/articles/3')).cache, 'miss; stored');

      await getArticle('/articles/4');
      const byPrefix = await revalidateRequest({ paths: ['/articles/'], prefix: true });
      assert.equal(byPrefix.status, 200);
      assert.ok(JSON.parse(byPrefix.body).purged >= 2, byPrefix.body);
      assert.equal((await getArticle('/articles/4')).cache, 'miss; stored');
      assert.match((await getArticle('/cached')).cache, /^hit/, 'pages outside the prefix stay cached');

      for (const body of ['{"tag":"articles"}', '{}', 'not json', '{"paths":["/a/../b"]}', '{"tags":["_gio:path:/"]}']) {
        const bad = await revalidateRequest(body);
        assert.equal(bad.status, 400, body);
        assert.ok(JSON.parse(bad.body).error, body);
      }
    });

    await test('POST /_gio/revalidate refuses a client after repeated bad tokens, even with the right one', async () => {
      // A forwarded client of its own, so 127.0.0.1 is not the one blocked.
      const attacker = { 'x-forwarded-for': '198.51.100.99' };
      for (let i = 0; i < 10; i++) {
        const res = await revalidateRequest({ tags: ['x'] }, { ...attacker, authorization: `Bearer guess-${i}` });
        assert.equal(res.status, 401, `attempt ${i}`);
      }
      const blocked = await revalidateRequest({ tags: ['x'] }, attacker);
      assert.equal(blocked.status, 429, 'blocked before the token is even compared');
      assert.ok(Number(blocked.headers['retry-after']) > 0);
      const other = await revalidateRequest({ tags: ['x'] }, { 'x-forwarded-for': '198.51.100.100' });
      assert.equal(other.status, 200, 'other clients are unaffected');
    });

    await test('a nested error.* answers a failed render with 500 and only a digest', async () => {
      const res = await fetch(`${BASE}/dashboard/broken`);
      assert.equal(res.status, 500);
      const html = await res.text();
      assert.match(html, /FIXTURE_DASHBOARD_ERROR/);
      assert.match(html, /message=Internal Server Error/);
      assert.doesNotMatch(html, /FIXTURE_DASHBOARD_SECRET|swordfish/, 'error message must not leak');
      assert.ok(html.indexOf('FIXTURE_DASHBOARD_LAYOUT') !== -1, 'rendered inside the dashboard layout');
      const digest = html.match(/ref=([0-9a-f]{12})/)?.[1];
      assert.ok(digest, `error page must carry a digest:\n${html}`);
      await waitFor('nested error digest in the server log', () => Promise.resolve(
        log.split('\n').some((line) =>
          line.includes(digest) && line.includes('FIXTURE_DASHBOARD_SECRET') && line.includes('"stack"')),
      ), 5_000);
    });

    await test('error.* files are client error boundaries in the hydration bundles', async () => {
      const html = await (await fetch(`${BASE}/dashboard`)).text();
      assert.match(html, /FIXTURE_DASHBOARD_HOME/);
      const chunk = entryChunkOf(html);
      assert.ok(chunk, 'dashboard page has a hydration chunk');
      // Shared by both dashboard routes, the error component lands in a
      // shared chunk the entry imports.
      const entry = await (await fetch(`${BASE}${chunk}`)).text();
      const imported = await Promise.all(
        [...entry.matchAll(/"\.\/(shared-[A-Z0-9]+\.js)"/g)].map(async ([, name]) =>
          (await fetch(`${BASE}/_next/static/chunks/${name}`)).text()),
      );
      assert.match([entry, ...imported].join('\n'), /FIXTURE_DASHBOARD_ERROR/);
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

    await test('a revalidate page that reads ctx.host is never cached for another Host', async () => {
      // Cache poisoning: the attacker's Host must not reach the next visitor.
      const evil = await rawGet('/hostpage', { host: 'evil.example' });
      assert.match(evil.body, /href="http:\/\/evil\.example\/reset"/);
      assert.equal(evil.headers['x-gio-cache'], 'bypass');
      const visitor = await fetch(`${BASE}/hostpage`);
      const html = await visitor.text();
      assert.doesNotMatch(html, /evil\.example/, 'a later visitor must get their own host');
      assert.match(html, /href="http:\/\/127\.0\.0\.1:39517\/reset"/);
      assert.equal(visitor.headers.get('x-gio-cache'), 'bypass');
      // The same through the trusted proxy's X-Forwarded-Host.
      await rawGet('/hostpage', { 'x-forwarded-host': 'evil.example' });
      assert.doesNotMatch(await (await fetch(`${BASE}/hostpage`)).text(), /evil\.example/);
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

    await test('loading.*: the first bytes carry the loading UI while the page suspends', async () => {
      const started = Date.now();
      const res = await fetch(`${BASE}/feed`, { headers: { 'accept-encoding': 'identity' } });
      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      let firstBytes = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        // Everything that arrived before the 800ms suspension resolved.
        if (Date.now() - started < 500) firstBytes = html;
      }
      html += decoder.decode();
      assert.ok(firstBytes !== null, `no bytes before the suspension resolved (took ${Date.now() - started}ms)`);
      assert.match(firstBytes, /FIXTURE_FEED_LOADING/);
      assert.doesNotMatch(firstBytes, /FIXTURE_FEED_CONTENT/);
      assert.match(html, /FIXTURE_FEED_CONTENT/, 'the page streams in behind its loading UI');
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

    await test('PPR: a per-visitor redirect() or notFound() on a shell hit still reaches the visitor', async () => {
      const get = (cookie) =>
        fetch(`${BASE}/ppr-gate`, {
          redirect: 'manual',
          headers: { 'accept-encoding': 'identity', ...(cookie ? { cookie } : {}) },
        });
      // Before any shell is stored: the plain redirect, nothing cached.
      const anonMiss = await get();
      assert.equal(anonMiss.status, 303);
      assert.equal(anonMiss.headers.get('location'), '/login?next=/ppr-gate');
      assert.equal(anonMiss.headers.get('x-gio-cache'), 'bypass');
      const stored = await get('who=alice');
      assert.equal(stored.headers.get('x-gio-cache'), 'ppr; shell=stored');
      assert.match(await stored.text(), /PPR_GATE_HOLE who=alice/);
      await sleep(250);

      // The shell's 200 is out before gSSP redirects this visitor: the page
      // finishes itself with a redirect to the real Location.
      const anonHit = await get();
      assert.equal(anonHit.status, 200);
      assert.equal(anonHit.headers.get('x-gio-cache'), 'ppr; shell=hit');
      const redirected = await anonHit.text();
      assert.match(redirected, /PPR_GATE_SHELL/);
      assert.doesNotMatch(redirected, /PPR_GATE_HOLE/);
      assert.match(redirected, /<script>location\.replace\("\/login\?next=\/ppr-gate"\)<\/script>/);
      assert.match(redirected, /<noscript><meta http-equiv="refresh" content="0;url=\/login\?next=\/ppr-gate"><\/noscript>/);
      assert.ok(redirected.endsWith('</body></html>'), 'the document is closed');

      // notFound() for this visitor: reload past the shell to the real 404.
      const ghostHit = await get('who=ghost');
      assert.equal(ghostHit.headers.get('x-gio-cache'), 'ppr; shell=hit');
      const reloading = await ghostHit.text();
      assert.doesNotMatch(reloading, /location\.replace/);
      assert.match(reloading, /__gio_ppr_bypass=1/);
      assert.match(reloading, /location\.reload\(\)/);
      assert.ok(reloading.endsWith('</body></html>'), 'the document is closed');
      // The reload carries the bypass cookie: the whole page renders, with
      // its real status - never the shell again, so it cannot loop.
      const ghostReload = await get('who=ghost; __gio_ppr_bypass=1');
      assert.equal(ghostReload.status, 404);
      assert.doesNotMatch(ghostReload.headers.get('x-gio-cache') ?? '', /^ppr/);
      const anonReload = await get('__gio_ppr_bypass=1');
      assert.equal(anonReload.status, 303);
      assert.equal(anonReload.headers.get('location'), '/login?next=/ppr-gate');
      // Visitors the page renders for still get the shell and their holes.
      const bob = await get('who=bob');
      assert.equal(bob.headers.get('x-gio-cache'), 'ppr; shell=hit');
      assert.match(await bob.text(), /PPR_GATE_HOLE who=bob/);
    });

    await test('X-Gio-Cache labels bypass and static tiers', async () => {
      const personalized = await fetch(`${BASE}/whoami`, { headers: { cookie: 'session=x' } });
      assert.equal(personalized.headers.get('x-gio-cache'), 'bypass');
      const asset = await fetch(`${BASE}/_next/static/chunks/nonexistent.js`);
      assert.equal(asset.headers.get('x-gio-cache'), 'static');
    });

    await test('page metadata lands in the document head (layout template, metadataBase, JSON-LD)', async () => {
      const res = await fetch(`${BASE}/seo`);
      assert.equal(res.status, 200);
      const html = await res.text();
      const head = html.slice(0, html.indexOf('</head>'));
      assert.match(head, /<title>Metadata Page \| Gio Fixture<\/title>/);
      assert.equal(html.match(/<title>/g)?.length, 1, 'exactly one <title>');
      assert.match(head, /<meta name="description" content="SEO_FIXTURE_SECTION_DESCRIPTION"\/>/);
      assert.match(head, /<link rel="canonical" href="https:\/\/fixture\.example\/seo"\/>/);
      assert.match(head, /<meta property="og:title" content="SEO_FIXTURE_OG_TITLE"\/>/);
      assert.match(head, /<meta property="og:image" content="https:\/\/fixture\.example\/og\.png"\/>/);
      assert.match(head, /<meta property="og:image:width" content="1200"\/>/);
      assert.match(head, /<meta name="twitter:card" content="summary_large_image"\/>/);
      // The client renders the same tags from the envelope.
      const envelope = JSON.parse(html.match(/<script id="__gio_props" type="application\/json">([^<]*)</)[1]);
      assert.deepEqual(envelope.metadata[0], { tag: 'title', text: 'Metadata Page | Gio Fixture' });
      // JSON-LD: a data block whose JSON cannot close the element.
      const ld = html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/);
      assert.ok(ld, 'JSON-LD script present');
      assert.equal(JSON.parse(ld[1]).name, '</script><b>SEO_LD</b>');
      assert.doesNotMatch(html, /<b>SEO_LD<\/b>/);
    });

    await test('generateMetadata reuses the gSSP props; reading ctx.host keeps the page out of the cache', async () => {
      const first = await fetch(`${BASE}/seo/posts/hello`);
      const html = await first.text();
      assert.match(html, /<title>Post hello \| Gio Fixture<\/title>/);
      assert.match(html, /<link rel="canonical" href="https:\/\/fixture\.example\/seo\/posts\/hello"\/>/);
      assert.equal(first.headers.get('x-gio-cache'), 'miss; stored');
      const second = await fetch(`${BASE}/seo/posts/hello`);
      assert.match(second.headers.get('x-gio-cache') ?? '', /^hit/);
      assert.match(await second.text(), /<title>Post hello \| Gio Fixture<\/title>/);

      for (let i = 0; i < 2; i++) {
        const personal = await fetch(`${BASE}/seo/posts/hello?who=host`);
        assert.equal(personal.headers.get('x-gio-cache'), 'bypass', `request ${i + 1} must not be cached`);
        assert.match(await personal.text(), /<title>Served for 127\.0\.0\.1:39517 \| Gio Fixture<\/title>/);
      }
      assert.match(log, /generateMetadata read request credentials/);
    });

    await test('a streamed page carries its metadata in the shell head', async () => {
      const res = await fetch(`${BASE}/seo/streamed`, { headers: { 'accept-encoding': 'identity' } });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      while (!html.includes('</head>')) {
        const { done, value } = await reader.read();
        assert.ok(!done, 'stream ended before </head>');
        html += decoder.decode(value, { stream: true });
      }
      const head = html.slice(0, html.indexOf('</head>'));
      assert.match(head, /<title>Streamed \| Gio Fixture<\/title>/);
      assert.match(head, /<meta name="robots" content="noindex"\/>/);
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        html += decoder.decode(chunk.value, { stream: true });
      }
      assert.match(html, /SEO_STREAMED_LATE/);
    });

    await test('/sitemap.xml is generated from app/sitemap.ts and cached', async () => {
      const first = await fetch(`${BASE}/sitemap.xml`);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('content-type'), 'application/xml; charset=utf-8');
      assert.equal(first.headers.get('x-gio-cache'), 'miss; stored');
      const xml = await first.text();
      assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
      assert.match(xml, /<loc>https:\/\/fixture\.example\/<\/loc>\n<changefreq>daily<\/changefreq>\n<priority>1<\/priority>/);
      assert.match(xml, /<loc>https:\/\/fixture\.example\/seo\?a=1&amp;b=2<\/loc>/);
      const second = await fetch(`${BASE}/sitemap.xml`);
      assert.match(second.headers.get('x-gio-cache') ?? '', /^hit/);
      assert.equal(second.headers.get('content-type'), 'application/xml; charset=utf-8');
      assert.equal(await second.text(), xml);
    });

    await test('public/robots.txt shadows app/robots.ts, with a startup warning', async () => {
      assert.match(log, /public\/ file shadows the app's metadata route/);
      assert.match(log, /robots\.ts/);
      const res = await fetch(`${BASE}/robots.txt`);
      assert.match(await res.text(), /FIXTURE_ROBOTS/);
    });

    await test('public/ files are served at the site root with revalidating caching', async () => {
      const expected = await readFile(join(fixtureDir, 'public', 'robots.txt'), 'utf8');
      const res = await fetch(`${BASE}/robots.txt`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
      const cacheControl = res.headers.get('cache-control') ?? '';
      assert.match(cacheControl, /must-revalidate/);
      assert.doesNotMatch(cacheControl, /immutable/);
      assert.ok(res.headers.get('last-modified'), 'Last-Modified enables revalidation');
      assert.equal(res.headers.get('x-gio-cache'), 'static');
      assert.equal(await res.text(), expected);

      const conditional = await fetch(`${BASE}/robots.txt`, {
        headers: { 'if-modified-since': res.headers.get('last-modified') },
      });
      assert.equal(conditional.status, 304);

      const head = await fetch(`${BASE}/robots.txt`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    });

    await test('public/ files keep working under /public/*', async () => {
      const res = await fetch(`${BASE}/public/robots.txt`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /FIXTURE_ROBOTS/);
    });

    await test('root-served public/ files: .well-known yes, dotfiles and traversal no', async () => {
      const wellKnown = await fetch(`${BASE}/.well-known/security.txt`);
      assert.equal(wellKnown.status, 200);
      assert.match(await wellKnown.text(), /^Contact:/);

      const dotfile = await fetch(`${BASE}/.secret-config`);
      assert.equal(dotfile.status, 404);
      assert.doesNotMatch(await dotfile.text(), /FIXTURE_DOTFILE_SECRET/);

      for (const path of ['/.well-known/../.secret-config', '/%2e%2e/fixture/gio.toml', '/%2Esecret-config']) {
        const res = await fetch(`${BASE}${path}`);
        assert.notEqual(res.status, 200, `${path} must not be served`);
        assert.doesNotMatch(await res.text(), /FIXTURE_DOTFILE_SECRET|integration-fixture/);
      }
    });

    await test('a public/ file shadows a page at the same path', async () => {
      const res = await fetch(`${BASE}/shadowed`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-gio-cache'), 'static');
      assert.equal(await res.text(), 'FIXTURE_PUBLIC_SHADOWS_PAGE\n');
    });

    await test('rules middleware runs for root-served public/ files', async () => {
      const res = await fetch(`${BASE}/robots.txt`);
      assert.equal(res.headers.get('x-fixture-header'), 'public-root');
    });

    await test('guards and header rules for /public/* also cover the root alias', async () => {
      // Unguarded before: /members/report.txt served the file the
      // /public/members/* guard protects.
      for (const path of ['/public/members/report.txt', '/members/report.txt', '/%6Dembers/report%2Etxt']) {
        const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
        assert.equal(res.status, 302, `${path} must be guarded`);
        assert.equal(res.headers.get('location'), '/login');
        assert.doesNotMatch(await res.text(), /FIXTURE_MEMBERS_ONLY/);
      }
      const member = await fetch(`${BASE}/members/report.txt`, { headers: { cookie: 'session=abc' } });
      assert.equal(member.status, 200);
      assert.equal(await member.text(), 'FIXTURE_MEMBERS_ONLY\n');
      assert.equal(member.headers.get('x-robots-tag'), 'noindex', '/public/* header rule stamped on the alias');
    });

    await test('an escaped slash cannot reach a guarded public/ file', async () => {
      // ServeDir decodes %2F into a separator, while every rule sees one
      // segment: this used to serve the file with neither guard nor header.
      for (const path of ['/public/members%2Freport.txt', '/public/members%2freport.txt', '/public/members%5Creport.txt']) {
        const res = await rawGet(path);
        assert.equal(res.status, 400, path);
        assert.doesNotMatch(res.body, /FIXTURE_MEMBERS_ONLY/, path);
      }
      // At the root the spelling is an app path, never the file.
      const root = await rawGet('/members%2Freport.txt');
      assert.doesNotMatch(root.body, /FIXTURE_MEMBERS_ONLY/);
    });

    await test('/_gio/image honors the guards of the public/ file it reads', async () => {
      for (const src of ['/members/report.txt', '/public/members/report.txt', 'members//report.txt']) {
        const res = await fetch(`${BASE}/_gio/image?src=${encodeURIComponent(src)}&w=48`);
        assert.equal(res.status, 403, src);
        assert.doesNotMatch(await res.text(), /FIXTURE_MEMBERS_ONLY/, src);
      }
    });

    await test('a raw backslash in the path is refused, so no redirect can point off-site', async () => {
      for (const path of ['/\\evil.example', '/moved/\\evil.example', '/public/members/\\report.txt']) {
        const res = await rawGet(path);
        assert.equal(res.status, 400, path);
        assert.equal(res.headers.location, undefined, path);
      }
    });

    await test('split Cookie fields reach guards and the worker as one header', async () => {
      // HTTP/2 browsers send one cookie field per cookie; several Cookie
      // lines take the same path through the server.
      const exchange = (path, crumbs) => rawExchange(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:39517\r\nConnection: close\r\n` +
          crumbs.map((crumb) => `Cookie: ${crumb}\r\n`).join('') + '\r\n',
      );
      for (const crumbs of [['a=1', 'session=1'], ['session=1', 'a=1']]) {
        const { data } = await exchange('/public/members/report.txt', crumbs);
        assert.match(data, /^HTTP\/1\.1 200/, crumbs.join(' | '));
        assert.match(data, /FIXTURE_MEMBERS_ONLY/, crumbs.join(' | '));
      }
      for (const crumbs of [['who=alice', 'z=1'], ['z=1', 'who=alice']]) {
        const { data } = await exchange('/personal', crumbs);
        assert.match(data, /PERSONAL_FIXTURE who=alice/, crumbs.join(' | '));
      }
    });

    await test('[[rate_limits]] for /public/* also hold for the root alias, one shared budget', async () => {
      const statuses = [];
      for (const path of ['/limited/file.txt', '/public/limited/file.txt', '/limited/file.txt']) {
        statuses.push((await fetch(`${BASE}${path}`)).status);
      }
      assert.deepEqual(statuses, [200, 200, 429]);
    });

    await test('redirects for /public/* URLs do not apply to the root alias', async () => {
      // A /public/*rest -> /*rest canonicalizing redirect must not loop.
      const legacy = await fetch(`${BASE}/public/moved-root/file.txt`, { redirect: 'manual' });
      assert.equal(legacy.status, 301);
      assert.equal(legacy.headers.get('location'), '/moved-root/file.txt');
      const root = await fetch(`${BASE}/moved-root/file.txt`, { redirect: 'manual' });
      assert.equal(root.status, 200);
      assert.equal(await root.text(), 'FIXTURE_MOVED_ROOT\n');
    });

    await test('unhashed app CSS revalidates with a strong ETag and 304s', async () => {
      const res = await fetch(`${BASE}/globals.css`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/css/);
      const cacheControl = res.headers.get('cache-control') ?? '';
      assert.match(cacheControl, /must-revalidate/);
      assert.doesNotMatch(cacheControl, /immutable/, 'an unhashed URL must not be cached for a year');
      const etag = res.headers.get('etag') ?? '';
      assert.match(etag, /^"[0-9a-f]+"$/, 'strong, quoted ETag');
      assert.match(await res.text(), /fixture-css-marker/);

      const revalidated = await fetch(`${BASE}/globals.css`, { headers: { 'if-none-match': etag } });
      assert.equal(revalidated.status, 304);
      assert.equal(revalidated.headers.get('etag'), etag);
      assert.equal(await revalidated.text(), '');

      const stale = await fetch(`${BASE}/globals.css`, { headers: { 'if-none-match': '"stale"' } });
      assert.equal(stale.status, 200);
      assert.match(await stale.text(), /fixture-css-marker/);
    });

    await test('a CSS Module import renders its hashed class and links an immutable stylesheet holding it', async () => {
      // Twice: the second response is the composed cache hit.
      for (const expected of ['miss', 'hit']) {
        const res = await fetch(`${BASE}/styled`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('x-gio-cache') ?? '', new RegExp(`^${expected}`));
        const html = await res.text();
        const className = html.match(/<div class="(card_[0-9a-f]{6}_card)">FIXTURE_STYLED_PAGE/)?.[1];
        assert.ok(className, 'SSR rendered the CSS Module class');
        const head = html.slice(0, html.indexOf('</head>'));
        const sheets = [...head.matchAll(/<link rel="stylesheet" href="(\/_next\/static\/css\/[^"]+\.css)" data-precedence="default"\/>/g)]
          .map((m) => m[1]);
        // The root layout's stylesheet first, then the route's.
        assert.equal(sheets.length, 2, head);
        assert.match(sheets[0], /\/root-[A-Z0-9]+\.css$/);
        assert.match(sheets[1], /\/route-styled-[A-Z0-9]+\.css$/);
        // The legacy critical-CSS snippet stays out of pages that import CSS.
        assert.ok(!html.includes('href="/globals.css"'), 'no second copy of globals.css');

        const routeCss = await fetch(`${BASE}${sheets[1]}`);
        assert.equal(routeCss.status, 200);
        assert.match(routeCss.headers.get('content-type') ?? '', /^text\/css/);
        assert.match(routeCss.headers.get('cache-control') ?? '', /immutable/);
        assert.ok((await routeCss.text()).includes(`.${className}{color:`), 'the stylesheet styles that class');
        const rootCss = await fetch(`${BASE}${sheets[0]}`);
        assert.match(await rootCss.text(), /\.fixture-root-css-marker\{color:/);
        // The hydrating bundle carries the same class name.
        const chunk = html.match(/\/_next\/static\/chunks\/route-styled-[A-Z0-9]+\.js/)?.[0];
        assert.ok(chunk, 'the page hydrates');
        assert.ok((await (await fetch(`${BASE}${chunk}`)).text()).includes(`"${className}"`));
      }
    });

    await test('the root layout links its imported CSS on every page, 404s included', async () => {
      for (const [path, status] of [['/cached', 200], ['/definitely-missing-page', 404]]) {
        const res = await fetch(`${BASE}${path}`);
        assert.equal(res.status, status);
        const html = await res.text();
        assert.match(
          html.slice(0, html.indexOf('</head>')),
          /<link rel="stylesheet" href="\/_next\/static\/css\/root-[A-Z0-9]+\.css" data-precedence="default"\/>/,
          path,
        );
      }
    });

    await test('CSS Modules are never served by path in a second, differently hashed form', async () => {
      const res = await fetch(`${BASE}/styled/card.module.css`);
      assert.equal(res.status, 404);
      assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/css/);
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

    await test('session login sets the encrypted session cookie next to another cookie', async () => {
      const denied = await loginAs('alice', 'wrong');
      assert.equal(denied.status, 401);
      assert.deepEqual(denied.headers.getSetCookie(), []);

      const res = await loginAs('alice');
      assert.equal(res.status, 200);
      const cookies = res.headers.getSetCookie();
      assert.equal(cookies.length, 2, `both cookies arrive: ${cookies.join(' | ')}`);
      assert.match(
        cookies[0],
        /^gio_session=v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
      );
      assert.doesNotMatch(cookies[0], /alice/, 'session data is encrypted');
      assert.equal(cookies[1], 'theme=dark; Path=/; Secure; SameSite=Lax');
    });

    await test('require_session guards verify the session in Rust', async () => {
      const cookie = sessionCookieOf(await loginAs('alice'));
      const token = cookie.slice('gio_session='.length);
      const future = Math.floor(Date.now() / 1000) + 3600;
      const rejected = {
        none: undefined,
        'presence only': 'gio_session=valid',
        empty: 'gio_session=',
        expired: `gio_session=${resignSession(token, Math.floor(Date.now() / 1000) - 60)}`,
        'wrong secret': `gio_session=${resignSession(token, future, 'not-the-fixture-secret-0123456789abcdef')}`,
        'other cookie name': `gio_session=${resignSession(token, future, FIXTURE_SESSION_SECRET, 'other')}`,
        'tampered mac': `${cookie.slice(0, -2)}${cookie.at(-2) === 'A' ? 'B' : 'A'}${cookie.at(-1)}`,
        'right token, wrong cookie': `session=${token}`,
      };
      for (const [label, header] of Object.entries(rejected)) {
        for (const path of ['/session-dashboard', '/session-dashboard/', '/api/me']) {
          const res = await rawGet(path, header === undefined ? {} : { cookie: header });
          assert.equal(res.status, 302, `${label}: ${path} must be guarded`);
          assert.equal(res.headers.location, '/login', `${label}: ${path}`);
          assert.doesNotMatch(res.body, /INTEGRATION_FIXTURE_DASHBOARD|userId/, label);
        }
      }

      const page = await fetch(`${BASE}/session-dashboard`, { headers: { cookie: `theme=dark; ${cookie}` } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /INTEGRATION_FIXTURE_DASHBOARD user=(<!-- -->)?alice/);
      // The session module is server-only (*.server.ts) and used only by
      // getServerSideProps: it is shaken out, so the page still hydrates.
      assert.match(html, /\/_next\/static\/chunks\/route-session-dashboard-[A-Z0-9]+\.js/);
      const me = await fetch(`${BASE}/api/me`, { headers: { cookie } });
      assert.equal(me.status, 200);
      assert.deepEqual(await me.json(), { userId: 'alice' });

      // A token whose MAC is re-signed (so Rust lets it through) but whose
      // ciphertext was sealed for another expiry still fails in Node: the
      // AES-GCM AAD binds the expiry too.
      const resigned = await fetch(`${BASE}/session-dashboard`, {
        headers: { cookie: `gio_session=${resignSession(token, future)}` },
      });
      assert.equal(resigned.status, 200);
      assert.match(await resigned.text(), /user=(<!-- -->)?anonymous/);
    });

    await test('a malformed middleware.ts guard denies every request instead of vanishing', async () => {
      const session = sessionCookieOf(await loginAs('alice'));
      for (const cookie of [undefined, session, 'session=int-test']) {
        for (const path of ['/broken-guard', '/broken-guard/x']) {
          const res = await rawGet(path, cookie === undefined ? {} : { cookie });
          assert.equal(res.status, 302, `${path} with ${cookie ?? 'no cookie'} must stay closed`);
          assert.equal(res.headers.location, '/login', path);
        }
      }
      assert.match(log, /guard for \/broken-guard\/\*rest is malformed \(requireSession must be true or false\)/);
    });

    await test('session pages are personal: never cached across users', async () => {
      const alice = sessionCookieOf(await loginAs('alice'));
      const bob = sessionCookieOf(await loginAs('bob'));
      for (const [user, cookie] of [['alice', alice], ['bob', bob], ['alice', alice]]) {
        const res = await fetch(`${BASE}/session-dashboard`, { headers: { cookie } });
        assert.match(await res.text(), new RegExp(`user=(<!-- -->)?${user}`));
        assert.equal(res.headers.get('x-gio-cache'), 'bypass', `${user}'s render must not be shared`);
      }
    });

    await test('logout destroys the session cookie', async () => {
      const res = await fetch(`${BASE}/api/logout`, { method: 'POST' });
      assert.equal(res.status, 204);
      assert.deepEqual(res.headers.getSetCookie(), [
        'gio_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax',
      ]);
      const after = await fetch(`${BASE}/session-dashboard`, {
        headers: { cookie: res.headers.getSetCookie()[0].split(';')[0] },
        redirect: 'manual',
      });
      assert.equal(after.status, 302);
    });

    await test('guards hold for every path spelling the router treats alike', async () => {
      for (const path of ['/admin/', '//admin', '/admin//', '/%61dmin', '/%61dmin/']) {
        const res = await rawGet(path);
        assert.equal(res.status, 302, `${path} must hit the /admin guard`);
        assert.equal(res.headers.location, '/', path);
      }
      // The escape is decoded before Node routes, so the authorized request
      // reaches the very page the guard protected.
      const allowed = await rawGet('/%61dmin', { cookie: 'session=int-test' });
      assert.equal(allowed.status, 200);
      assert.match(allowed.body, /INTEGRATION_FIXTURE_ADMIN/);
    });

    await test('dot segments are rejected before any rule or route', async () => {
      for (const path of ['/x/../admin', '/./admin', '/%2e%2e/admin']) {
        const res = await rawGet(path);
        assert.equal(res.status, 400, path);
        assert.doesNotMatch(res.body, /INTEGRATION_FIXTURE_ADMIN/, path);
      }
    });

    await test('malformed percent-escapes are rejected before any rule or route', async () => {
      // A stray '%' ahead of an escape would be forwarded as a new escape
      // ("/%61dmin", "/api/%6Cimited") that a later matcher decodes again,
      // matching a path Node never routes.
      for (const path of ['/%%361dmin', '/api/%%36Cimited', '/%%32e%%32e/admin', '/%zz', '/trailing%']) {
        for (const headers of [{}, { cookie: 'session=int-test' }]) {
          const res = await rawGet(path, headers);
          assert.equal(res.status, 400, path);
          assert.doesNotMatch(res.body, /INTEGRATION_FIXTURE_ADMIN|FIXTURE_CUSTOM_404/, path);
          assert.equal(res.headers['x-ratelimit-limit'], undefined, `${path} must not touch a bucket`);
        }
      }
    });

    await test('/_gio paths never reach a top-level dynamic segment', async () => {
      const blocked = await fetch(`${BASE}/acme/settings`, { redirect: 'manual' });
      assert.equal(blocked.status, 302, 'the /:org/settings guard is live');
      const allowed = await fetch(`${BASE}/acme/settings`, {
        headers: { cookie: 'session=int-test' },
      });
      assert.equal(allowed.status, 200);
      assert.match(await allowed.text(), /INTEGRATION_FIXTURE_ORG_SETTINGS org=acme/);

      for (const path of ['/_gio/settings', '//_gio/settings', '/%5Fgio/settings', '/_gio']) {
        for (const headers of [{}, { cookie: 'session=int-test' }]) {
          const res = await rawGet(path, headers);
          assert.equal(res.status, 404, `${path} must 404 in Rust`);
          assert.doesNotMatch(res.body, /INTEGRATION_FIXTURE_ORG_SETTINGS/, path);
          // Rust's bare 404, not the app's not-found page: Node never saw it.
          assert.doesNotMatch(res.body, /FIXTURE_CUSTOM_404/, path);
        }
      }
      // Dev-only internals do not exist in production.
      const devtools = await rawGet('/_gio/devtools');
      assert.equal(devtools.status, 404);
      assert.doesNotMatch(devtools.body, /FIXTURE_CUSTOM_404/);
      assert.equal((await fetch(`${BASE}/_gio/health`)).status, 200);
    });

    await test('rate limits hold for every path spelling the router treats alike', async () => {
      const first = await rawGet('/api/limited');
      assert.equal(first.status, 200);
      assert.equal(first.headers['x-ratelimit-limit'], '2');
      // Same handler, same bucket: the trailing slash spends the last token.
      const second = await rawGet('/api/limited/');
      assert.equal(second.status, 200);
      assert.match(second.body, /"limited":true/);
      for (const path of ['/api/limited', '//api//limited', '/api/limited/', '/api/%6Cimited']) {
        const res = await rawGet(path);
        assert.equal(res.status, 429, `${path} must draw from the exhausted bucket`);
        assert.ok(res.headers['retry-after'], path);
      }
    });

    await test('trusted proxy: X-Forwarded-* name the client the worker sees', async () => {
      const whoami = async (headers) => (await rawGet('/api/whoami', headers)).body;
      assert.deepEqual(JSON.parse(await whoami({})).ip, '127.0.0.1', 'no header: the peer');
      const proxied = JSON.parse(await whoami({
        'x-forwarded-for': '203.0.113.50',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'app.example',
      }));
      assert.equal(proxied.ip, '203.0.113.50');
      assert.equal(proxied.scheme, 'https');
      assert.equal(proxied.host, 'app.example');
      // The rightmost untrusted hop wins; what the client prepended is ignored.
      const chained = JSON.parse(await whoami({ 'x-forwarded-for': '6.6.6.6, 203.0.113.51, 127.0.0.1' }));
      assert.equal(chained.ip, '203.0.113.51');
      assert.equal(JSON.parse(await whoami({ 'x-forwarded-for': '2001:db8::7' })).ip, '2001:db8::7');
      const malformed = JSON.parse(await whoami({ 'x-forwarded-for': 'not-an-ip', 'x-forwarded-proto': 'gopher' }));
      assert.equal(malformed.ip, '127.0.0.1');
      assert.equal(malformed.scheme, 'http');
      // A proxy that appends instead of replacing: the client's own line
      // comes first and is never read.
      const appended = JSON.parse(await whoami({
        'x-forwarded-proto': ['http', 'https'],
        'x-forwarded-host': ['evil.example', 'app.example'],
      }));
      assert.equal(appended.scheme, 'https');
      assert.equal(appended.host, 'app.example');
    });

    await test('trusted proxy: nothing a client puts left of its address is read', async () => {
      // What nginx's $proxy_add_x_forwarded_for forwards: the client's own
      // header (any bytes it likes), then the address it connected from.
      const viaProxy = async (path, prefix, clientIp) => {
        const head = Buffer.concat([
          Buffer.from(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:39517\r\nConnection: close\r\nX-Forwarded-For: `),
          prefix,
          Buffer.from(`, ${clientIp}\r\n\r\n`),
        ]);
        const { data } = await rawExchange(head);
        return { status: Number(data.slice(9, 12)), ip: data.match(/"ip":"([^"]*)"/)?.[1] };
      };
      for (const prefix of [Buffer.from([0xff]), Buffer.from('"unterminated'), Buffer.alloc(9000, 'a')]) {
        const what = `${prefix.length}-byte prefix`;
        assert.equal((await viaProxy('/api/whoami', prefix, '203.0.113.50')).ip, '203.0.113.50', what);
        assert.equal((await viaProxy('/api/whoami', prefix, '2001:db8::7')).ip, '2001:db8::7', what);
        // Never the proxy itself: the metrics allowlist sees the real client.
        assert.equal((await viaProxy('/_gio/metrics', prefix, '203.0.113.50')).status, 403, what);
        assert.equal((await viaProxy('/_gio/metrics', prefix, '198.51.100.7')).status, 200, what);
      }
      // A hop the proxy itself wrote is unreadable: the client is unknown,
      // and the allowlist fails closed.
      assert.equal((await rawGet('/_gio/metrics', { 'x-forwarded-for': '198.51.100.7, unknown' })).status, 403);
    });

    await test('trusted proxy: every forwarded client gets its own rate-limit bucket', async () => {
      const hit = async (xff) =>
        (await rawGet('/api/proxied-limit', { 'x-forwarded-for': xff })).status;
      assert.equal(await hit('198.51.100.10'), 200);
      assert.equal(await hit('198.51.100.10'), 429, 'same client, same bucket');
      assert.equal(await hit('198.51.100.11'), 200, 'another client behind the same proxy');
      // IPv6 clients are still bucketed by /64.
      assert.equal(await hit('2001:db8:1:2::1'), 200);
      assert.equal(await hit('2001:db8:1:2::99'), 429);
      assert.equal(await hit('2001:db8:1:3::1'), 200);
    });

    await test('trusted proxy: the metrics allowlist checks the forwarded client', async () => {
      // 127.0.0.1 is the proxy, not an allowlisted client.
      assert.equal((await rawGet('/_gio/metrics')).status, 403);
      assert.equal((await rawGet('/_gio/metrics', { 'x-forwarded-for': '203.0.113.9' })).status, 403);
      const allowed = await rawGet('/_gio/metrics', { 'x-forwarded-for': '198.51.100.7' });
      assert.equal(allowed.status, 200);
      assert.match(allowed.body, /gio_requests_total/);
    });

    await test('metrics label requests by route pattern, never by raw path', async () => {
      assert.equal((await fetch(`${BASE}/posts/7`)).status, 200);
      assert.equal((await fetch(`${BASE}/cached`)).status, 200);
      assert.equal((await fetch(`${BASE}/robots.txt`)).status, 200);
      // app/sitemap.ts: a metadata route, labelled by its fixed path.
      assert.equal((await fetch(`${BASE}/sitemap.xml`)).status, 200);
      assert.equal((await fetch(`${BASE}/no-such-page-for-metrics`)).status, 404);
      // A streamed route.ts body: its head carries the route label too.
      assert.match(await (await fetch(`${BASE}/api/stream-events`)).text(), /data: second/);
      const metrics = (await rawGet('/_gio/metrics', { 'x-forwarded-for': '198.51.100.7' })).body;
      const has = (pattern) => assert.match(metrics, pattern);
      has(/gio_requests_total\{method="GET",status="200",cache="hit",route="\/cached"\} \d+/);
      has(/gio_requests_total\{method="GET",status="200",cache="[a-z]+",route="\/posts\/:id"\} \d+/);
      has(/gio_requests_total\{method="GET",status="200",cache="static",route="static"\} \d+/);
      has(/gio_requests_total\{method="GET",status="200",cache="bypass",route="internal"\} \d+/);
      has(/gio_requests_total\{method="GET",status="404",cache="[a-z]+",route="unmatched"\} \d+/);
      has(/gio_requests_total\{method="GET",status="200",cache="[a-z]+",route="\/sitemap\.xml"\} \d+/);
      has(/gio_requests_total\{method="GET",status="200",cache="stream",route="\/api\/stream-events"\} \d+/);
      has(/gio_request_duration_seconds_count\{route="\/cached"\} \d+/);
      has(/gio_request_duration_seconds_bucket\{route="\/posts\/:id",le="\+Inf"\} \d+/);
      has(/gio_node_ipc_latency_seconds_count\{route="\/posts\/:id"\} \d+/);
      assert.doesNotMatch(metrics, /route="\/posts\/7"/);
      assert.doesNotMatch(metrics, /route="\/no-such-page-for-metrics"/);
    });

    await test('X-Request-Id: a trusted proxy\'s valid id is kept, anything else replaced', async () => {
      const kept = await rawGet('/api/whoami', { 'x-request-id': 'lb-trace.123:a_b' });
      assert.equal(kept.headers['x-request-id'], 'lb-trace.123:a_b');
      assert.equal(JSON.parse(kept.body).requestId, 'lb-trace.123:a_b');
      for (const bad of ['has space', 'x'.repeat(129), 'semi;colon']) {
        const res = await rawGet('/api/whoami', { 'x-request-id': bad });
        const id = res.headers['x-request-id'];
        assert.match(id, /^[0-9a-f-]{36}$/, `${bad} must be replaced by a generated id`);
        const body = JSON.parse(res.body);
        assert.equal(body.requestId, id);
        assert.equal(body.requestIdHeader, id, 'the worker never sees the rejected header');
      }
      const a = (await rawGet('/api/whoami')).headers['x-request-id'];
      const b = (await rawGet('/api/whoami')).headers['x-request-id'];
      assert.match(a, /^[0-9a-f-]{36}$/);
      assert.notEqual(a, b);
    });

    await test('X-Request-Id is on every response: cached, static, redirects, errors', async () => {
      await fetch(`${BASE}/cached`);
      const hit = await fetch(`${BASE}/cached`);
      assert.match(hit.headers.get('x-gio-cache') ?? '', /^hit/);
      const html = await (await fetch(`${BASE}/`)).text();
      const chunk = html.match(/\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js/)?.[0];
      assert.ok(chunk);
      const responses = {
        'cache hit': hit,
        'static chunk': await fetch(`${BASE}${chunk}`),
        'public file': await fetch(`${BASE}/robots.txt`),
        redirect: await fetch(`${BASE}/moved`, { redirect: 'manual' }),
        'unknown /_gio path': await fetch(`${BASE}/_gio/nope`),
        'bad path': (await rawGet('/a/../b')),
        'rate limited': await fetch(`${BASE}/api/limited`),
        health: await fetch(`${BASE}/_gio/health`),
      };
      const seen = new Set();
      for (const [what, res] of Object.entries(responses)) {
        const id = typeof res.headers.get === 'function'
          ? res.headers.get('x-request-id')
          : res.headers['x-request-id'];
        assert.match(id ?? '', /^[0-9a-f-]{36}$/, `${what} must carry an X-Request-Id`);
        assert.ok(!seen.has(id), `${what} must have its own id`);
        seen.add(id);
      }
      assert.equal(responses['bad path'].status, 400);
      assert.equal(responses['rate limited'].status, 429);
    });

    await test('one request id ties the server and worker log lines of a failing request', async () => {
      const id = 'int-boom-1';
      const res = await fetch(`${BASE}/boom`, { headers: { 'x-request-id': id } });
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('x-request-id'), id);
      const digest = (await res.text()).match(/Error reference: <code>([0-9a-f]{12})<\/code>/)?.[1];
      assert.ok(digest);
      await waitFor('request id in the server and worker logs', () => {
        const lines = log.split('\n').filter((line) => line.includes(id));
        const worker = lines.some((line) =>
          line.includes('"requestId":"int-boom-1"') && line.includes(digest) && line.includes('FIXTURE_SECRET_FAILURE'));
        const completed = lines.some((line) => line.includes('request completed') && line.includes('500'));
        const renderError = lines.some((line) => line.includes('Node render error') && line.includes(digest));
        return Promise.resolve(worker && completed && renderError);
      }, 5_000);
    });

    await test('site-wide header rules cover the root and rule redirects', async () => {
      const root = await fetch(`${BASE}/`);
      assert.equal(root.headers.get('x-fixture-sitewide'), 'on', '/*rest matches zero segments');
      const redirect = await fetch(`${BASE}/old-home`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('x-fixture-sitewide'), 'on');
      const guarded = await fetch(`${BASE}/admin`, { redirect: 'manual' });
      assert.equal(guarded.status, 302);
      assert.equal(guarded.headers.get('x-fixture-sitewide'), 'on');
      const configured = await fetch(`${BASE}/moved`, { redirect: 'manual' });
      assert.equal(configured.status, 301);
      assert.equal(configured.headers.get('x-fixture-sitewide'), 'on');
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

    await test('default security headers on pages, static files, redirects, errors and /_gio', async () => {
      const responses = {
        page: await fetch(`${BASE}/`),
        static: await fetch(`${BASE}/robots.txt`),
        chunk: await fetch(`${BASE}/_next/static/chunks/nonexistent.js`),
        redirect: await fetch(`${BASE}/moved`, { redirect: 'manual' }),
        notFound: await fetch(`${BASE}/definitely-missing`),
        routeHandler: await fetch(`${BASE}/api/notes`),
        health: await fetch(`${BASE}/_gio/health`),
      };
      assert.equal(responses.redirect.status, 301);
      assert.equal(responses.notFound.status, 404);
      const rejected = await rawGet('/%zz');
      assert.equal(rejected.status, 400);
      const all = [
        ...Object.entries(responses).map(([what, res]) => [what, (name) => res.headers.get(name)]),
        ['path rejection', (name) => rejected.headers[name] ?? null],
      ];
      for (const [what, get] of all) {
        assert.equal(get('x-content-type-options'), 'nosniff', what);
        assert.equal(get('x-frame-options'), 'SAMEORIGIN', what);
        assert.equal(get('referrer-policy'), 'strict-origin-when-cross-origin', what);
        assert.equal(get('strict-transport-security'), null, `${what}: no HSTS over plain HTTP`);
        assert.equal(get('content-security-policy'), null, `${what}: CSP is opt-in`);
        assert.equal(get('x-powered-by'), null, what);
      }
    });

    await test('a header rule overrides or removes a security default, cache hits included', async () => {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${BASE}/cached`);
        assert.match(res.headers.get('x-gio-cache') ?? '', /^hit/);
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.equal(res.headers.get('referrer-policy'), null, 'an empty rule value removes it');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      }
    });

    const selfOrigin = new URL(BASE).origin;
    const postNote = (headers, text = 'csrf-probe') =>
      rawRequest('POST', '/api/notes', { 'content-type': 'application/json', ...headers }, JSON.stringify({ text }));

    await test('CSRF: cross-site POSTs are refused before reaching the route handler', async () => {
      const refused = [
        { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'cross-site' },
        { origin: 'http://sibling.127.0.0.1.nip.io', 'sec-fetch-site': 'same-site' },
        { origin: 'https://evil.example' },
        { origin: 'null' },
      ];
      for (const headers of refused) {
        const res = await postNote(headers);
        assert.equal(res.status, 403, JSON.stringify(headers));
        assert.match(res.body, /\[security\.csrf\] trusted_origins/);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
      }
      const { notes } = await (await fetch(`${BASE}/api/notes`)).json();
      assert.ok(!notes.includes('csrf-probe'), 'no refused request may reach the handler');
      // A hostile page can loop forged requests: one warning per origin.
      const warned = () => log.match(/cross-site request blocked.*evil\.example/g) ?? [];
      await waitFor('CSRF warning', () => Promise.resolve(warned().length > 0), 5_000);
      assert.equal(warned().length, 1, 'two refusals from one origin, one warning');
    });

    await test('CSRF: same-origin, header-less, trusted-origin and exempt POSTs pass', async () => {
      const allowed = [
        { origin: selfOrigin, 'sec-fetch-site': 'same-origin' },
        { origin: selfOrigin },
        { 'sec-fetch-site': 'none' },
        {},
        { origin: 'https://admin.fixture.test', 'sec-fetch-site': 'cross-site' },
      ];
      for (const headers of allowed) {
        const res = await postNote(headers, 'csrf-allowed');
        assert.equal(res.status, 200, JSON.stringify(headers));
      }
      const webhook = await rawRequest('POST', '/api/webhooks/ping', {
        origin: 'https://hooks.example',
        'sec-fetch-site': 'cross-site',
      });
      assert.equal(webhook.status, 200, '[security.csrf] exempt path');
      assert.deepEqual(JSON.parse(webhook.body), { received: true });
      // Safe methods are never checked: cross-site links and images work.
      const get = await rawRequest('GET', '/cached', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
      assert.equal(get.status, 200);
    });

    await test('CSRF: behind a trusted proxy, Origin is compared with X-Forwarded-Host', async () => {
      // A Host-rewriting proxy (nginx's default proxy_pass) and a browser
      // that sends no Sec-Fetch-Site: the forwarded host is the origin's.
      const proxied = { host: '127.0.0.1:39871', 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' };
      const same = await postNote({ ...proxied, origin: 'https://app.example' }, 'csrf-proxied');
      assert.equal(same.status, 200);
      const forged = await postNote({ ...proxied, origin: 'https://evil.example' });
      assert.equal(forged.status, 403);
    });

    // Page actions, the way a browser without JavaScript uses them: plain
    // form posts from the page's own origin (fixture app/guestbook).
    const formPost = (body, headers = {}) =>
      rawRequest('POST', '/guestbook', {
        'content-type': 'application/x-www-form-urlencoded',
        origin: selfOrigin,
        'sec-fetch-site': 'same-origin',
        ...headers,
      }, body);

    await test('page action: a form POST answers 303 and the GET shows the new state', async () => {
      const res = await formPost('name=Ada+Lovelace');
      assert.equal(res.status, 303);
      assert.equal(res.headers.location, '/guestbook?signed=Ada%20Lovelace');
      assert.equal(res.headers['x-gio-cache'], 'bypass');
      const page = await fetch(`${BASE}${res.headers.location}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /GUESTBOOK_ENTRY Ada Lovelace/);
    });

    await test('page action: a GioForm submission gets its redirect in x-gio-redirect, cookies kept', async () => {
      // fetch would follow a 3xx itself - off-site into a CORS failure after
      // the action ran - so the client router is told where to go instead.
      const offsite = await formPost('intent=donate', { 'x-gio-form': '1' });
      assert.equal(offsite.status, 204);
      assert.equal(offsite.headers['x-gio-redirect'], 'https://pay.example/checkout/42');
      assert.equal(offsite.headers.location, undefined);
      assert.match(String(offsite.headers['set-cookie']), /donation=42; Path=\//);
      assert.equal(offsite.headers['x-gio-cache'], 'bypass');
      // A plain form post (no JavaScript) still gets the real 303.
      const plain = await formPost('intent=donate');
      assert.equal(plain.status, 303);
      assert.equal(plain.headers.location, 'https://pay.example/checkout/42');

      const signed = await formPost('name=Grace+Hopper', { 'x-gio-form': '1' });
      assert.equal(signed.status, 204);
      assert.equal(signed.headers['x-gio-redirect'], '/guestbook?signed=Grace%20Hopper');
      const page = await fetch(`${BASE}${signed.headers['x-gio-redirect']}`);
      assert.match(await page.text(), /GUESTBOOK_ENTRY Grace Hopper/);
    });

    await test('page action: a 422 re-render shows field errors and is never cached', async () => {
      // The page exports revalidate: its GET is cached...
      await (await fetch(`${BASE}/guestbook`)).text();
      const cached = await fetch(`${BASE}/guestbook`);
      assert.match(cached.headers.get('x-gio-cache') ?? '', /^hit/);
      await cached.text();

      const res = await formPost('name=+');
      assert.equal(res.status, 422);
      assert.match(res.headers['content-type'] ?? '', /^text\/html/);
      assert.match(res.body, /GUESTBOOK_ERROR Name is required/);
      assert.match(res.body, /aria-invalid="true"/);
      assert.match(res.body, /"actionData":\{"error":"Name is required"\}/, 'the envelope carries actionData');
      assert.equal(res.headers['x-gio-cache'], 'bypass');
      assert.equal(res.headers['cache-control'], 'private, no-cache');
      // ...and the re-render never replaces it.
      const after = await fetch(`${BASE}/guestbook`);
      assert.match(after.headers.get('x-gio-cache') ?? '', /^hit/);
      assert.doesNotMatch(await after.text(), /GUESTBOOK_ERROR/);
    });

    await test('page action: a multipart upload reaches the action byte for byte', async () => {
      const form = new FormData();
      form.append('attachment', new Blob([Buffer.from([0xff, 0x00, 0xfe, 0x80])]), 'photo.bin');
      const res = await fetch(`${BASE}/guestbook`, { method: 'POST', body: form });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /GUESTBOOK_UPLOAD name=photo\.bin size=4 hex=ff00fe80/);
    });

    await test('page action: an upload over max_body_bytes is a 413 before the action runs', async () => {
      // A raw socket that stops writing one byte past the 2 MiB default limit
      // and then reads: the server answers 413 without reading the rest, so
      // a client still writing (fetch) would race it into EPIPE, and bytes
      // left unread in the server's socket would turn its close into a reset.
      const boundary = 'gio-big-upload';
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="big.bin"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      );
      const sent = Buffer.concat([head, Buffer.alloc(2 * 1024 * 1024 + 1 - head.length, 0xab)]);
      const status = await new Promise((resolve, reject) => {
        const socket = connect(39517, '127.0.0.1', () => {
          socket.write(
            'POST /guestbook HTTP/1.1\r\nHost: 127.0.0.1:39517\r\n' +
              `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
              `Content-Length: ${3 * 1024 * 1024}\r\n\r\n`,
          );
          socket.write(sent);
        });
        let data = '';
        socket.setEncoding('latin1');
        socket.on('data', (chunk) => {
          data += chunk;
          if (data.includes('\r\n\r\n')) {
            socket.destroy();
            resolve(data);
          }
        });
        socket.on('error', reject);
      });
      assert.equal(Number(status.split(' ')[1]), 413);
      // Marked as refused unread: <GioForm> may send it again natively.
      assert.match(status, /\r\nx-gio-refused: unread\r\n/i);
      // The worker connection is untouched: the next post goes through.
      const ok = await formPost('name=+');
      assert.equal(ok.status, 422);
    });

    await test('page action: cross-site form posts are refused by CSRF, other methods get 405', async () => {
      const forged = await formPost('name=Mallory', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
      assert.equal(forged.status, 403);
      const page = await fetch(`${BASE}/guestbook?signed=check`);
      assert.doesNotMatch(await page.text(), /GUESTBOOK_ENTRY Mallory/, 'the action never ran');
      const put = await rawRequest('PUT', '/guestbook', { origin: selfOrigin });
      assert.equal(put.status, 405);
      assert.equal(put.headers.allow, 'GET, HEAD, POST');
      // A page without an action still refuses every mutation.
      const noAction = await rawRequest('POST', '/cached', { origin: selfOrigin });
      assert.equal(noAction.status, 405);
      assert.equal(noAction.headers.allow, 'GET, HEAD');
    });

    await test('WebSocket upgrades from a foreign origin are refused with 403', async () => {
      assert.equal(await upgradeStatus('/live', { Origin: 'https://evil.example' }), 403);
      assert.equal(
        await upgradeStatus('/live', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }),
        403,
      );
      assert.equal(await upgradeStatus('/live', { Origin: selfOrigin }), 101);
      assert.equal(await upgradeStatus('/live', { Origin: 'https://admin.fixture.test' }), 101);
      assert.equal(await upgradeStatus('/live'), 101, 'non-browser clients send no Origin');
    });

    await test('route.ts json() answers 415 for bodies not declared as JSON', async () => {
      const res = await fetch(`${BASE}/api/notes`, { method: 'POST', body: JSON.stringify({ text: 'plain' }) });
      assert.equal(res.status, 415);
      assert.equal((await res.json()).error, 'Unsupported Media Type');
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

    await test('stopping the server ends open event streams at once, finishes in-flight renders and downloads, and leaves no orphaned worker', async () => {
      const worker = workerPids().at(-1);
      // Streams that never end on their own: a GioEventStream and an
      // endless route.ts event stream. Without ending them the drain would
      // wait out its 8s timeout and then reset both connections.
      const readToEnd = async (res) => {
        const reader = res.body.getReader();
        await reader.read();
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      };
      const sseEnded = readToEnd(await fetch(`${BASE}/stream`));
      const routeEnded = readToEnd(await fetch(`${BASE}/api/stream-endless`));
      // A page render in flight when the signal lands (its hole resolves
      // ~800ms later): it still completes.
      const slow = await fetch(`${BASE}/slow`, { headers: { 'accept-encoding': 'identity' } });
      const slowHtml = slow.text();
      // A finite route.ts download in flight (~1.5s of 30ms pieces): it is a
      // byte stream, not an event stream, so it must either arrive whole or
      // fail visibly - never end cleanly short, which curl, wget and fetch
      // all accept as a complete file. http.request reports both: `complete`
      // is false and 'aborted'/'error' fire when the body is cut.
      const download = new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: 39517, path: '/api/download?slow=1', headers: { 'accept-encoding': 'identity' } },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('download aborted')));
            res.on('end', () =>
              resolve({
                complete: res.complete,
                total: Number(res.headers['x-download-bytes']),
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
      // Headers out and the body under way before the signal lands.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const stoppedAt = Date.now();
      server.kill();
      await Promise.all([sseEnded, routeEnded]);
      const streamsEndedMs = Date.now() - stoppedAt;
      assert.ok(streamsEndedMs < 2000, `open streams ended ${streamsEndedMs}ms after SIGTERM`);
      const html = await slowHtml;
      assert.match(html, /SLOW_FIXTURE_LATE_CONTENT/);
      assert.match(html, /<\/html>/);
      const downloaded = await download;
      assert.ok(downloaded.complete, 'the download ended with its final chunk');
      assert.equal(downloaded.body.length, downloaded.total, 'the download drained in full');
      const expected = Buffer.alloc(downloaded.total);
      for (let i = 0; i < downloaded.total; i++) expected[i] = (i * 31 + (i >> 8)) & 0xff;
      assert.ok(downloaded.body.equals(expected), 'every byte of the download arrived');
      assert.match(log, /shutdown: ended open event streams/);
      await waitFor('server exit', () => Promise.resolve(serverGone), 10_000);
      const exitMs = Date.now() - stoppedAt;
      assert.ok(exitMs < 5000, `server exited ${exitMs}ms after SIGTERM`);
      assert.doesNotMatch(log, /shutdown drain timed out/);
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

    await test('without a revalidation token, /_gio/revalidate does not exist', async () => {
      const res = await rawRequest('POST', '/_gio/revalidate', {
        authorization: `Bearer ${REVALIDATE_TOKEN}`,
        'content-type': 'application/json',
      }, '{"tags":["articles"]}');
      assert.equal(res.status, 404);
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

/**
 * Phase 1c (no trusted_proxies - the default): forwarding headers and
 * incoming request ids are a client's word and are ignored entirely. A
 * throwaway app with one route keeps the boot fast.
 */
async function untrustedProxyPhase() {
  const binary = findServerBinary();
  const workDir = await mkdtemp(join(tmpdir(), 'gio-int-untrusted-'));
  await mkdir(join(workDir, 'app', 'api', 'whoami'), { recursive: true });
  await mkdir(join(workDir, 'app', 'api', 'limited'), { recursive: true });
  await cp(
    join(fixtureDir, 'app', 'api', 'whoami', 'route.ts'),
    join(workDir, 'app', 'api', 'whoami', 'route.ts'),
  );
  await writeFile(
    join(workDir, 'app', 'api', 'limited', 'route.ts'),
    'export function GET(): unknown {\n  return { limited: true };\n}\n',
  );
  await writeFile(join(workDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(
    join(workDir, 'gio.toml'),
    [
      '[server]',
      'host = "127.0.0.1"',
      'port = 39517',
      'http2 = false',
      '',
      '[[rate_limits]]',
      'path = "/api/limited"',
      'per_ip = 1',
      'window_seconds = 3600',
      'burst = 0',
      '',
    ].join('\n'),
  );

  let log = '';
  const server = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIO_APP_DIR: join(workDir, 'app'),
      GIO_CACHE_DIR: join(workDir, 'cache'),
      // Production log level: the request span must survive it.
      RUST_LOG: 'warn',
      NODE_ENV: 'production',
    },
  });
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  let serverGone = false;
  const serverExited = new Promise((r) =>
    server.on('exit', () => { serverGone = true; r(); }),
  );

  try {
    await waitFor('server health (no trusted proxies)', async () => {
      const res = await fetch(`${BASE}/_gio/health`);
      return res.ok && (await res.json()).nodeReady === true;
    }, 30_000);

    await test('untrusted peer: X-Forwarded-* and X-Request-Id are ignored', async () => {
      const res = await rawGet('/api/whoami', {
        'x-forwarded-for': '203.0.113.50',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example',
        'x-request-id': 'spoofed-id',
      });
      const body = JSON.parse(res.body);
      assert.equal(body.ip, '127.0.0.1');
      assert.equal(body.scheme, 'http');
      assert.equal(body.host, '127.0.0.1:39517');
      assert.notEqual(res.headers['x-request-id'], 'spoofed-id');
      assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
      assert.equal(body.requestId, res.headers['x-request-id']);
      assert.equal(body.requestIdHeader, res.headers['x-request-id']);
    });

    await test('untrusted peer: a spoofed X-Forwarded-For buys no fresh rate-limit bucket', async () => {
      assert.equal((await rawGet('/api/limited', { 'x-forwarded-for': '198.51.100.1' })).status, 200);
      const limited = await rawGet('/api/limited', { 'x-forwarded-for': '198.51.100.2' });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers['x-gio-refused'], 'unread', 'refused before the handler ran');
      // At RUST_LOG=warn the warning still carries the request's id.
      const id = limited.headers['x-request-id'];
      assert.match(id, /^[0-9a-f-]{36}$/);
      await waitFor('rate-limit warning with its request id', () =>
        Promise.resolve(log.replace(/\x1b\[[0-9;]*m/g, '').split('\n').some((line) =>
          line.includes('rate limit exceeded') && line.includes(`request{request_id=${id}}`))), 5_000);
    });
  } catch (err) {
    console.error('\nintegration (no trusted proxies): FAILED');
    console.error(err);
    console.error('\n── server log tail ──');
    console.error(significantLogTail(log));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Phase 1d (operations): `[logging] format = "json"` makes every server line
 * one JSON object carrying the request span's request_id, and a server that
 * dies without any chance to clean up (SIGKILL, OOM kill) still takes its
 * worker tree down - the worker reads EOF on the stdin pipe the server held.
 */
async function opsPhase() {
  const binary = findServerBinary();
  const workDir = await mkdtemp(join(tmpdir(), 'gio-int-ops-'));
  await mkdir(join(workDir, 'app', 'api', 'ping'), { recursive: true });
  await writeFile(
    join(workDir, 'app', 'api', 'ping', 'route.ts'),
    `import { logger } from ${JSON.stringify(
      pathToFileURL(join(repoRoot, 'packages', 'giojs-core', 'src', 'logger.ts')).href,
    )};\n` +
      "export function GET(): unknown {\n  logger.info('ping handled');\n  return { pong: true };\n}\n",
  );
  // A cached page under [i18n]: one URL per locale may be shared, a locale
  // negotiated from request headers may not.
  await mkdir(join(workDir, 'app', 'hello'), { recursive: true });
  await writeFile(
    join(workDir, 'app', 'hello', 'page.tsx'),
    "import React from 'react';\nexport const revalidate = 300;\n" +
      'export default function Hello() {\n  return <p>OPS_HELLO rendered_at={Date.now()}</p>;\n}\n',
  );
  await linkFixtureDeps(workDir);
  await writeFile(join(workDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(
    join(workDir, 'gio.toml'),
    '[server]\nhost = "127.0.0.1"\nport = 39517\nhttp2 = false\n\n[logging]\nformat = "json"\n\n' +
      '[i18n]\nlocales = ["en", "de"]\ndefault_locale = "en"\ndetect_from = ["path", "accept-language"]\n',
  );

  let log = '';
  const server = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIO_APP_DIR: join(workDir, 'app'),
      GIO_CACHE_DIR: join(workDir, 'cache'),
      RUST_LOG: 'info',
      NODE_ENV: 'production',
    },
  });
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  let serverGone = false;
  const serverExited = new Promise((r) =>
    server.on('exit', () => { serverGone = true; r(); }),
  );
  /** Complete log lines parsed as JSON (null for a line that is not). */
  const jsonLines = () =>
    log.split('\n').slice(0, -1).filter((line) => line.trim() !== '').map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { unparseable: line };
      }
    });

  try {
    await waitFor('server health (ops)', async () => {
      const res = await fetch(`${BASE}/_gio/health`);
      return res.ok && (await res.json()).nodeReady === true;
    }, 30_000);

    await test('JSON logs: every line is one JSON object; both processes name the request', async () => {
      const res = await fetch(`${BASE}/api/ping`);
      assert.deepEqual(await res.json(), { pong: true });
      const id = res.headers.get('x-request-id');
      assert.match(id ?? '', /^[0-9a-f-]{36}$/);
      const serverLine = await waitFor('the server\'s request line', () =>
        Promise.resolve(jsonLines().find((line) =>
          line.request_id === id && line.msg === 'request completed')), 5_000);
      assert.equal(serverLine.level, 'info');
      assert.equal(serverLine.path, '/api/ping');
      assert.match(serverLine.target, /^giojs_server/);
      // RFC 3339, UTC.
      assert.match(serverLine.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      // The worker's line for the same request (logger.ts keys).
      await waitFor('the worker\'s request line', () =>
        Promise.resolve(jsonLines().some((line) =>
          line.requestId === id && line.msg === 'ping handled')), 5_000);
      const unparseable = jsonLines().filter((line) => line.unparseable !== undefined);
      assert.deepEqual(unparseable, [], 'no plain-text line in JSON mode');
      assert.ok(jsonLines().some((line) => line.msg?.startsWith('GioJS listening')));
    });

    await test('i18n: locale-prefixed pages are public with ETags; negotiated locales stay private', async () => {
      await fetch(`${BASE}/de/hello`);
      const hit = await fetch(`${BASE}/de/hello`);
      const body = await hit.text();
      assert.match(body, /OPS_HELLO/);
      assert.match(body, /<html[^>]* lang="de"/);
      assert.match(hit.headers.get('x-gio-cache') ?? '', /^hit/);
      assert.match(hit.headers.get('cache-control') ?? '', /^public, max-age=0, s-maxage=\d+/);
      const etag = hit.headers.get('etag');
      assert.match(etag ?? '', /^W\/"[0-9a-f]{32}"$/);
      const revalidated = await rawGet('/de/hello', { 'if-none-match': etag });
      assert.equal(revalidated.status, 304);
      assert.equal(revalidated.body, '', 'a 304 carries no body');

      // Same URL, locale from Accept-Language: one URL, different pages.
      for (const language of ['de', 'en']) {
        await fetch(`${BASE}/hello`, { headers: { 'accept-language': language } });
        const negotiated = await fetch(`${BASE}/hello`, { headers: { 'accept-language': language } });
        await negotiated.text();
        assert.match(negotiated.headers.get('x-gio-cache') ?? '', /^hit/, language);
        assert.equal(negotiated.headers.get('cache-control'), 'private, no-cache', language);
        assert.equal(negotiated.headers.get('etag'), null, language);
      }
    });

    if (process.platform !== 'win32') {
      await test('a SIGKILLed server takes its worker tree down within seconds', async () => {
        const tree = descendantPids(server.pid);
        assert.ok(tree.length > 0, 'the worker runs under the server');
        server.kill('SIGKILL');
        await waitFor('server exit', () => Promise.resolve(serverGone), 5_000);
        // No signal reaches the worker: it notices the closed stdin pipe.
        await waitFor('worker tree gone', () => Promise.resolve(!tree.some(processRunning)), 5_000);
        await waitFor('the worker said why it left', () =>
          Promise.resolve(jsonLines().some((line) =>
            line.msg === 'server process gone - worker shutting down' &&
            line.reason === 'stdin-closed')), 2_000);
      });
    }
  } catch (err) {
    console.error('\nintegration (ops): FAILED');
    console.error(err);
    console.error('\n── server log tail ──');
    console.error(significantLogTail(log));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Phase 1e (worker pool): `[server] workers = 2` renders on two Node
 * processes. Requests spread across both and so do WebSockets, while a room
 * broadcast from either worker reaches sockets on both; only the first
 * worker bundles the client code (the other loads its manifest); killing
 * either worker - the builder, then the other - takes down only that one,
 * which comes back without a rebuild (and a respawn that cannot load the
 * build fails its boot and is retried, never rebuilding under the other
 * worker); purges and middleware rules work from
 * either worker; plugin startup hooks run once per worker process (each
 * knows its GIO_WORKER_INDEX); shutdown reaps them all.
 */
async function workersPhase() {
  const binary = findServerBinary();
  const workDir = await mkdtemp(join(tmpdir(), 'gio-int-workers-'));
  const publicApi = JSON.stringify(
    pathToFileURL(join(repoRoot, 'packages', 'giojs-core', 'src', 'public.ts')).href,
  );
  const files = {
    'app/page.tsx':
      "import React from 'react';\n" +
      'export function getServerSideProps() {\n  return { props: { pid: process.pid } };\n}\n' +
      'export default function Home({ pid }: { pid: number }) {\n' +
      '  return <main><p>WORKERS_HOME pid={pid}</p></main>;\n}\n',
    'app/cached/page.tsx':
      "import React from 'react';\nexport const revalidate = 300;\n" +
      'export function getServerSideProps() {\n  return { props: { pid: process.pid } };\n}\n' +
      'export default function Cached({ pid }: { pid: number }) {\n' +
      '  return <p>WORKERS_CACHED pid={pid}</p>;\n}\n',
    'app/api/pid/route.ts':
      `import type { GioRequest } from ${publicApi};\n` +
      'export async function GET(req: GioRequest): Promise<unknown> {\n' +
      "  await new Promise((resolve) => setTimeout(resolve, Number(req.query['ms'] ?? 0)));\n" +
      '  return { pid: process.pid, worker: Number(process.env.GIO_WORKER_INDEX) };\n}\n',
    'app/api/purge/route.ts':
      `import { revalidatePath } from ${publicApi};\n` +
      'export async function POST(): Promise<unknown> {\n' +
      "  return { pid: process.pid, ...(await revalidatePath('/cached')) };\n}\n",
    'app/api/broadcast/route.ts':
      `import { broadcast, type GioRequest } from ${publicApi};\n` +
      'export function POST(req: GioRequest): unknown {\n' +
      "  return { pid: process.pid, delivered: broadcast('everyone', `${process.pid}:${req.body ?? ''}`) };\n}\n",
    'app/ws/room/route.ts':
      `import type { GioSocket } from ${publicApi};\n` +
      'export function wsHandler(socket: GioSocket): void {\n' +
      "  socket.join('everyone');\n" +
      '  socket.send(JSON.stringify({ pid: process.pid }));\n}\n',
    'middleware.ts':
      `import { defineMiddleware } from ${publicApi};\n` +
      "export default defineMiddleware({ redirects: [{ from: '/old-home', to: '/' }] });\n",
    // Logs each startup hook run with its worker, and holds a respawned
    // worker back for a while: the kill tests then see the outage for sure.
    'gio.config.ts':
      "import { existsSync, writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      'export default {\n  plugins: [{\n' +
      "    name: 'workers-probe',\n    version: '0.0.0',\n" +
      '    async onStartup(): Promise<void> {\n' +
      "      const worker = process.env.GIO_WORKER_INDEX ?? 'unset';\n" +
      '      console.log(`WORKERS_PLUGIN_STARTUP worker=${worker}`);\n' +
      "      const marker = join(process.env.GIO_APP_DIR ?? '.', '..', `.started-${worker}`);\n" +
      '      if (existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 2500));\n' +
      "      else writeFileSync(marker, '');\n" +
      '    },\n  }],\n};\n',
    'gio.toml':
      '[server]\nhost = "127.0.0.1"\nport = 39517\nhttp2 = false\nworkers = 2\n\n[metrics]\nenabled = true\n',
    'package.json': JSON.stringify({ private: true, type: 'module' }),
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(workDir, file)), { recursive: true });
    await writeFile(join(workDir, file), content);
  }
  await linkFixtureDeps(workDir);

  let log = '';
  const server = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIO_APP_DIR: join(workDir, 'app'),
      GIO_CACHE_DIR: join(workDir, 'cache'),
      RUST_LOG: 'info',
      NODE_ENV: 'production',
    },
  });
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  let serverGone = false;
  const serverExited = new Promise((r) =>
    server.on('exit', () => { serverGone = true; r(); }),
  );
  const health = async () => (await fetch(`${BASE}/_gio/health`)).json();
  /** `{ pid, worker }` of the process that answered `path`. */
  const whoAnswered = async (path) => {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
    return res.json();
  };
  const pidOf = async (path) => (await whoAnswered(path)).pid;
  /**
   * Pool index -> pid of the workers that answer concurrent slow requests
   * (distinct URLs: never coalesced).
   */
  const workerPids = async () => {
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, n) => whoAnswered(`/api/pid?ms=150&n=${n}`)),
    );
    const byWorker = new Map();
    for (const { worker, pid } of answers) {
      assert.ok(!byWorker.has(worker) || byWorker.get(worker) === pid, `one process per worker index: ${JSON.stringify(answers)}`);
      byWorker.set(worker, pid);
    }
    return byWorker;
  };
  const workerMetric = async (name, worker) => {
    const text = await (await fetch(`${BASE}/_gio/metrics`)).text();
    const line = text.split('\n').find((l) => l.startsWith(`${name}{worker="${worker}"} `));
    return line === undefined ? undefined : Number(line.split(' ')[1]);
  };
  const countLines = (needle) => log.split('\n').filter((line) => line.includes(needle)).length;

  try {
    await waitFor('both workers ready', async () => {
      const body = await health();
      return body.nodeReady === true && body.workers.ready === 2;
    }, 60_000);

    /** Pool index -> pid, kept current across the kill tests. */
    let workers = new Map();
    await test('workers: health reports the pool, concurrent requests reach both workers', async () => {
      assert.deepEqual((await health()).workers, { configured: 2, ready: 2 });
      workers = await workerPids();
      assert.deepEqual([...workers.keys()].sort(), [0, 1], 'requests spread over both workers');
      assert.notEqual(workers.get(0), workers.get(1), 'two processes');
    });

    await test('workers: plugin startup hooks run once in every worker', async () => {
      assert.equal(countLines('WORKERS_PLUGIN_STARTUP worker=0'), 1);
      assert.equal(countLines('WORKERS_PLUGIN_STARTUP worker=1'), 1);
      assert.equal(countLines('WORKERS_PLUGIN_STARTUP worker=unset'), 0);
    });

    await test('workers: metrics show each worker\'s load', async () => {
      const slow = Promise.all([pidOf('/api/pid?ms=1500&n=a'), pidOf('/api/pid?ms=1500&n=b')]);
      await waitFor('one request in flight on each worker', async () =>
        (await workerMetric('gio_worker_in_flight', 0)) === 1 &&
        (await workerMetric('gio_worker_in_flight', 1)) === 1, 1_400);
      assert.equal(new Set(await slow).size, 2);
      assert.equal(await workerMetric('gio_worker_in_flight', 0), 0);
      assert.equal(await workerMetric('gio_worker_ready', 1), 1);
      assert.equal(await workerMetric('gio_worker_restarts_total', 0), 0);
    });

    await test('workers: only the first worker bundles; pages from both hydrate from its build', async () => {
      assert.equal(countLines('client bundles built'), 1, 'one esbuild run for the pool');
      assert.equal(countLines('client build reused'), 1, 'the second worker loads the manifest');
      assert.equal(countLines('route types written'), 1, 'generated types are the builder\'s job too');
      const pages = new Map();
      for (let i = 0; i < 8 && pages.size < 2; i++) {
        const html = await (await fetch(`${BASE}/`)).text();
        const pid = Number(html.match(/WORKERS_HOME pid=(?:<!-- -->)?(\d+)/)?.[1]);
        pages.set(pid, html);
      }
      assert.equal(pages.size, 2, 'both workers rendered the page');
      const chunks = [...pages.values()].map(
        (html) => html.match(/\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js/)?.[0],
      );
      assert.ok(chunks[0], 'the page links its hydration entry');
      assert.equal(chunks[0], chunks[1], 'both workers link the same build');
      const chunk = await fetch(`${BASE}${chunks[0]}`);
      assert.equal(chunk.status, 200);
    });

    await test('workers: middleware.ts rules apply', async () => {
      const res = await fetch(`${BASE}/old-home`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
    });

    await test('workers: a purge from either worker clears the shared cache', async () => {
      const purgedBy = new Set();
      for (let i = 0; i < 8 && purgedBy.size < 2; i++) {
        await (await fetch(`${BASE}/cached`)).text();
        const hit = await fetch(`${BASE}/cached`);
        await hit.text();
        assert.match(hit.headers.get('x-gio-cache') ?? '', /^hit/);
        // Idle workers take turns: an odd number of renders per round hands
        // the next round's purge to the other worker.
        await pidOf(`/api/pid?round=${i}`);
        const purge = await (await fetch(`${BASE}/api/purge`, { method: 'POST' })).json();
        assert.equal(purge.ok, true, JSON.stringify(purge));
        assert.ok(purge.purged >= 1, JSON.stringify(purge));
        purgedBy.add(purge.pid);
        const after = await fetch(`${BASE}/cached`);
        await after.text();
        assert.match(after.headers.get('x-gio-cache') ?? '', /^miss/, 'purged');
      }
      assert.equal(purgedBy.size, 2, 'each worker purged at least once');
    });

    await test('workers: sockets spread across workers and a broadcast from either reaches all', async () => {
      const clients = [];
      for (let i = 0; i < 4; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:39517/ws/room`);
        const inbox = [];
        ws.addEventListener('message', (event) => inbox.push(String(event.data)));
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', () => reject(new Error('socket failed to open')), { once: true });
        });
        await waitFor('greeting', () => Promise.resolve(inbox.length > 0), 5_000);
        clients.push({ ws, inbox, pid: JSON.parse(inbox[0]).pid });
      }
      assert.equal(new Set(clients.map((c) => c.pid)).size, 2, 'pinned to both workers');
      const sentBy = new Set();
      for (let i = 0; i < 8 && sentBy.size < 2; i++) {
        const sent = await (await fetch(`${BASE}/api/broadcast`, { method: 'POST', body: `m${i}` })).json();
        assert.equal(sent.delivered, true);
        sentBy.add(sent.pid);
        const expected = `${sent.pid}:m${i}`;
        await waitFor(`broadcast ${expected} on every socket`, () =>
          Promise.resolve(clients.every((c) => c.inbox.includes(expected))), 5_000);
      }
      assert.equal(sentBy.size, 2, 'both workers broadcast');
      for (const { ws } of clients) ws.close();
    });

    // The builder first: its production respawn must switch to reusing the
    // build, and while it is down the middleware rules (read from the first
    // ready worker) must come from the other one. Then the other worker.
    for (const [victimIndex, role] of [[0, 'the builder'], [1, 'the other worker']]) {
      await test(`workers: killing ${role} takes only it down; it respawns from the build`, async () => {
        const survivorIndex = 1 - victimIndex;
        const victim = workers.get(victimIndex);
        const survivor = workers.get(survivorIndex);
        const restartsBefore = await workerMetric('gio_worker_restarts_total', victimIndex);
        const survivorRestarts = await workerMetric('gio_worker_restarts_total', survivorIndex);
        const reusedBefore = countLines('client build reused');
        process.kill(victim, 'SIGKILL');
        // Counted when the supervisor respawns it; the fixture plugin holds
        // the respawn back for 2.5s, so the outage below is certain.
        await waitFor(`the supervisor respawning worker ${victimIndex}`, async () =>
          (await workerMetric('gio_worker_restarts_total', victimIndex)) === restartsBefore + 1, 10_000);
        const during = await health();
        assert.equal(during.workers.ready, 1, 'the victim is out of the pool while it reboots');
        assert.equal(during.nodeReady, true, 'one ready worker keeps the server ready');
        assert.equal(await workerMetric('gio_worker_ready', victimIndex), 0);
        // The site stays up on the surviving worker alone.
        for (let i = 0; i < 6; i++) {
          assert.deepEqual(await whoAnswered('/api/pid'), { pid: survivor, worker: survivorIndex });
        }
        const redirect = await fetch(`${BASE}/old-home`, { redirect: 'manual' });
        assert.equal(redirect.status, 302, 'rules survive the worker they came from');
        assert.equal(redirect.headers.get('location'), '/');
        await waitFor('the pool back at two', async () => (await health()).workers.ready === 2, 30_000);
        const respawned = await waitFor('the respawned worker answering', async () => {
          const now = await workerPids();
          return now.size === 2 && now.get(victimIndex) !== victim ? now : undefined;
        }, 15_000);
        assert.equal(respawned.get(survivorIndex), survivor, 'the survivor kept serving throughout');
        assert.equal(await workerMetric('gio_worker_restarts_total', survivorIndex), survivorRestarts);
        assert.equal(countLines('client bundles built'), 1, 'the respawn reused the build');
        assert.equal(countLines('client build reused'), reusedBefore + 1);
        assert.equal(countLines(`WORKERS_PLUGIN_STARTUP worker=${victimIndex}`), 2, 'startup hooks run again on a respawn');
        workers = respawned;
      });
    }

    await test('workers: a respawn without a usable build fails its boot instead of rebuilding under the other worker', async () => {
      const manifestPath = join(workDir, '.gio', 'build', 'manifest.json');
      const manifest = await readFile(manifestPath, 'utf8');
      const victim = workers.get(1);
      const survivor = workers.get(0);
      const html = await (await fetch(`${BASE}/`)).text();
      const chunkUrl = html.match(/\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js/)?.[0];
      assert.ok(chunkUrl, 'the page links its hydration entry');
      await rm(manifestPath);
      process.kill(victim, 'SIGKILL');
      await waitFor('the respawned worker refusing to rebuild', () =>
        Promise.resolve(countLines('client build manifest unusable') > 0), 20_000);
      assert.equal(countLines('client bundles built'), 1, 'nothing bundled into the shared directory');
      assert.equal((await health()).workers.ready, 1);
      // The survivor's pages still find their chunks.
      assert.deepEqual(await whoAnswered('/api/pid'), { pid: survivor, worker: 0 });
      assert.equal((await fetch(`${BASE}${chunkUrl}`)).status, 200);
      // The supervisor keeps retrying; with the build back, the worker joins.
      await writeFile(manifestPath, manifest);
      await waitFor('the retried worker back in the pool', async () => (await health()).workers.ready === 2, 45_000);
      workers = await waitFor('the retried worker answering', async () => {
        const now = await workerPids();
        return now.size === 2 && now.get(1) !== victim ? now : undefined;
      }, 15_000);
      assert.equal(countLines('client bundles built'), 1, 'it came back from the build, not a rebuild');
    });

    if (process.platform !== 'win32') {
      await test('workers: shutdown leaves no worker process behind', async () => {
        const tree = descendantPids(server.pid);
        for (const pid of workers.values()) assert.ok(tree.includes(pid), `worker ${pid} runs under the server`);
        server.kill('SIGTERM');
        await waitFor('server exit', () => Promise.resolve(serverGone), 15_000);
        await waitFor('every worker gone', () => Promise.resolve(!tree.some(processRunning)), 5_000);
      });
    }
  } catch (err) {
    console.error('\nintegration (workers): FAILED');
    console.error(err);
    console.error('\n── server log tail ──');
    console.error(significantLogTail(log));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Phase 1c (persisted page cache vs gio.toml): cached HTML bakes in the
 * [images] widths, and the disk cache outlives restarts. A restart with
 * different allowed_widths must not serve pages whose srcsets the optimizer
 * now rejects - the deployment ID covers the settings the worker renders with.
 */
async function imageConfigCachePhase() {
  const binary = findServerBinary();
  const appRoot = await copyFixtureForDev('.image-cache-fixture');
  await mkdir(join(appRoot, 'app', 'image-cached'), { recursive: true });
  await writeFile(
    join(appRoot, 'app', 'image-cached', 'page.tsx'),
    [
      "import React from 'react';",
      "import { GioImage } from '../../../../../packages/giojs-react/src/Image.tsx';",
      '',
      'export const revalidate = 3600;',
      '',
      'export default function CachedImage() {',
      '  return (',
      '    <main>',
      '      <h1>CACHED_IMAGE_FIXTURE</h1>',
      '      <GioImage src="/gio-test.png" width={120} height={60} alt="cached" sizes="50vw" />',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  const tomlPath = join(appRoot, 'gio.toml');
  const toml = await readFile(tomlPath, 'utf8');
  assert.match(toml, /^allowed_widths\s*=/m, 'fixture gio.toml sets allowed_widths');
  const cacheDir = await mkdtemp(join(tmpdir(), 'gio-int-imgcache-'));
  const srcsetUrls = (html) =>
    (html.match(/<img [^>]*\ssrcSet="([^"]*)"/)?.[1] ?? '')
      .replace(/&amp;/g, '&')
      .split(', ')
      .map((candidate) => candidate.split(' ')[0])
      .filter(Boolean);
  const hasWidth = (urls, w) => urls.some((u) => new URL(u, BASE).searchParams.get('w') === String(w));

  try {
    for (const [run, widths] of [[1, '[96, 48, 640]'], [2, '[96, 48, 828]']]) {
      await writeFile(tomlPath, toml.replace(/^allowed_widths\s*=.*$/m, `allowed_widths = ${widths}`));

      let log = '';
      const server = spawn(binary, [], {
        cwd: repoRoot,
        env: {
          ...process.env,
          GIO_APP_DIR: join(appRoot, 'app'),
          // Shared by both runs: entries persist across the restart.
          GIO_CACHE_DIR: cacheDir,
          RUST_LOG: 'info',
          NODE_ENV: 'production',
        },
      });
      server.stdout.on('data', (d) => { log += d.toString(); });
      server.stderr.on('data', (d) => { log += d.toString(); });
      let serverGone = false;
      const serverExited = new Promise((r) =>
        server.on('exit', () => { serverGone = true; r(); }),
      );
      try {
        await waitFor(`server health (gio.toml run ${run})`, async () => {
          const res = await fetch(`${BASE}/_gio/health`);
          return res.ok && (await res.json()).nodeReady === true;
        }, 30_000);

        if (run === 1) {
          const res = await fetch(`${BASE}/image-cached`);
          assert.equal(res.status, 200);
          assert.match(res.headers.get('x-gio-cache') ?? '', /^miss; stored$/);
          const urls = srcsetUrls(await res.text());
          assert.ok(hasWidth(urls, 640), `run 1 renders w=640: ${urls}`);
          // The disk write is a background task: wait until it has landed.
          await waitFor('page persisted to the disk cache', async () => {
            const files = await readdir(cacheDir, { recursive: true });
            return files.some((f) => f.endsWith('.json'));
          }, 10_000);
          continue;
        }

        await test('a gio.toml [images] change invalidates pages persisted with the old widths', async () => {
          const res = await fetch(`${BASE}/image-cached`);
          assert.equal(res.status, 200);
          assert.match(
            res.headers.get('x-gio-cache') ?? '',
            /^miss; stored$/,
            'a page rendered with the old allowed_widths must not be served after the restart',
          );
          const html = await res.text();
          const urls = srcsetUrls(html);
          assert.ok(!hasWidth(urls, 640), `stale width in srcset: ${urls}`);
          assert.ok(hasWidth(urls, 828), `new width missing from srcset: ${urls}`);
          const envelope = JSON.parse(html.match(/<script id="__gio_props" type="application\/json">([^<]*)</)[1]);
          assert.deepEqual(envelope.images.widths, [48, 96, 828]);
          for (const url of urls) {
            const image = await fetch(`${BASE}${url}`, { headers: { accept: 'image/webp' } });
            assert.equal(image.status, 200, `${url} must be servable`);
            await image.arrayBuffer();
          }
        });
      } catch (err) {
        console.error(`\nintegration (gio.toml change, run ${run}): FAILED`);
        console.error(err);
        console.error('\n── server log tail ──');
        console.error(significantLogTail(log));
        process.exitCode = 1;
      } finally {
        if (!serverGone) server.kill();
        await serverExited;
      }
      if (process.exitCode === 1) return;
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(appRoot, { recursive: true, force: true });
  }
}

/**
 * Phase 1c' (persisted page cache vs app code): every start rebuilds
 * `.gio/build` with new content-hashed chunks and stylesheets, and a cached
 * page links the ones it was rendered with. A restart after a code change
 * must get a new deployment ID - so pages persisted by the old build stop
 * matching and clients on it get the skew reload - while a restart of the
 * same code keeps the ID and the warm disk cache. Server-only code counts
 * too: the root layout and a page's `metadata` export never reach the
 * client chunks or stylesheets, yet they shape every cached page.
 */
async function buildChangeCachePhase() {
  const binary = findServerBinary();
  const appRoot = await copyFixtureForDev('.build-cache-fixture');
  const cssPath = join(appRoot, 'app', 'root.css');
  const layoutPath = join(appRoot, 'app', 'layout.tsx');
  const cachedPagePath = join(appRoot, 'app', 'cached', 'page.tsx');
  const cacheDir = await mkdtemp(join(tmpdir(), 'gio-int-buildcache-'));
  const stylesheets = (html) => [...html.matchAll(/\/_next\/static\/css\/[^"]+\.css/g)].map((m) => m[0]);
  const scripts = (html) => [...html.matchAll(/\/_next\/static\/chunks\/[^"]+\.js/g)].map((m) => m[0]);
  const persistedBy = (deploymentId) => async () => {
    const files = await readdir(cacheDir, { recursive: true });
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const body = await readFile(join(cacheDir, file), 'utf8').catch(() => '');
      if (body.includes(`"deployment_id":"${deploymentId}`)) return true;
    }
    return false;
  };
  const runs = [];
  // The page's metadata export: run 5 edits only that.
  await writeFile(
    cachedPagePath,
    `${await readFile(cachedPagePath, 'utf8')}\nexport const metadata = { title: 'BUILD_CHANGE_TITLE_V1' };\n`,
  );

  try {
    for (const run of [1, 2, 3, 4, 5]) {
      if (run === 2) {
        await writeFile(cssPath, `${await readFile(cssPath, 'utf8')}\n.build-change-marker { color: teal; }\n`);
      }
      if (run === 4) {
        const layout = await readFile(layoutPath, 'utf8');
        const edited = layout.replace(
          '<meta name="theme-color"',
          '<meta name="build-change" content="ROOT_LAYOUT_V2" />\n        <meta name="theme-color"',
        );
        assert.notEqual(edited, layout, 'the root layout edit applies');
        await writeFile(layoutPath, edited);
      }
      if (run === 5) {
        const page = await readFile(cachedPagePath, 'utf8');
        await writeFile(cachedPagePath, page.replace('BUILD_CHANGE_TITLE_V1', 'BUILD_CHANGE_TITLE_V2'));
      }
      let log = '';
      const server = spawn(binary, [], {
        cwd: repoRoot,
        env: {
          ...process.env,
          GIO_APP_DIR: join(appRoot, 'app'),
          // Shared by every run: entries persist across the restarts.
          GIO_CACHE_DIR: cacheDir,
          GIO_DEPLOYMENT_ID: '',
          RUST_LOG: 'info',
          NODE_ENV: 'production',
        },
      });
      server.stdout.on('data', (d) => { log += d.toString(); });
      server.stderr.on('data', (d) => { log += d.toString(); });
      let serverGone = false;
      const serverExited = new Promise((r) =>
        server.on('exit', () => { serverGone = true; r(); }),
      );
      try {
        await waitFor(`server health (build run ${run})`, async () => {
          const res = await fetch(`${BASE}/_gio/health`);
          return res.ok && (await res.json()).nodeReady === true;
        }, 30_000);
        const deploymentId = (await (await fetch(`${BASE}/_gio/health`)).json()).deploymentId;
        const res = await fetch(`${BASE}/cached`);
        const html = await res.text();
        runs.push({
          deploymentId,
          cache: res.headers.get('x-gio-cache') ?? '',
          css: stylesheets(html),
          scripts: scripts(html),
          html,
        });
        const current = runs[run - 1];
        assert.equal(res.status, 200);
        assert.ok(current.css.length > 0, `/cached links a stylesheet: ${html.slice(0, 400)}`);

        if (run === 1) {
          assert.match(current.cache, /^miss; stored$/);
          await waitFor('page persisted to the disk cache', async () => {
            const files = await readdir(cacheDir, { recursive: true });
            return files.some((f) => f.endsWith('.json'));
          }, 10_000);
          continue;
        }

        if (run === 2) {
          const before = runs[0];
          await test('a code change gives the restarted server a new deployment ID', () => {
            assert.notEqual(current.deploymentId, before.deploymentId);
          });
          await test('pages persisted by the old build are not served after a code change', async () => {
            assert.match(
              current.cache,
              /^miss; stored$/,
              `a page linking the old build's stylesheets was served: ${before.css} -> ${current.css}`,
            );
            assert.notDeepEqual(current.css, before.css, 'the CSS edit renamed the stylesheet');
            for (const href of current.css) {
              const css = await fetch(`${BASE}${href}`);
              assert.equal(css.status, 200, `${href} must be servable`);
              await css.arrayBuffer();
            }
          });
          await test('a client still on the old build gets the version-skew reload', async () => {
            const skewed = await fetch(`${BASE}/cached`, { headers: { 'x-deployment-id': before.deploymentId } });
            assert.equal(skewed.status, 409);
            assert.equal(skewed.headers.get('x-gio-action'), 'hard-reload');
            await skewed.arrayBuffer();
          });
          // The entry file is rewritten in place, stamped with the new ID.
          await waitFor('page re-persisted by the new build', persistedBy(current.deploymentId), 10_000);
          continue;
        }

        if (run === 3) {
          await test('a restart of the same code keeps the deployment ID and the disk cache', () => {
            assert.equal(current.deploymentId, runs[1].deploymentId);
            assert.match(current.cache, /^hit\b/, 'the page persisted by this build must be served');
            assert.deepEqual(current.css, runs[1].css);
          });
          continue;
        }

        const before = runs[run - 2];
        const [what, fresh, stale] = run === 4
          ? ['the root layout', /content="ROOT_LAYOUT_V2"/, null]
          : ["a page's metadata export", /<title>BUILD_CHANGE_TITLE_V2<\/title>/, /BUILD_CHANGE_TITLE_V1/];
        await test(`a change to ${what} alone gives the restarted server a new deployment ID`, () => {
          // The client build is untouched: only the server sources moved.
          assert.deepEqual(current.css, before.css, `${what} edit must not change the stylesheets`);
          assert.deepEqual(current.scripts, before.scripts, `${what} edit must not change the client chunks`);
          assert.notEqual(current.deploymentId, before.deploymentId);
        });
        await test(`pages persisted before a change to ${what} are not served after it`, () => {
          assert.match(current.cache, /^miss; stored$/, `the page rendered by the old ${what} was served`);
          assert.match(current.html, fresh);
          if (stale !== null) assert.doesNotMatch(current.html, stale);
        });
        if (run === 4) {
          assert.match(before.html, /<title>BUILD_CHANGE_TITLE_V1<\/title>/, 'the metadata export renders');
          assert.doesNotMatch(before.html, /ROOT_LAYOUT_V2/);
          await waitFor('page re-persisted after the layout change', persistedBy(current.deploymentId), 10_000);
        }
      } catch (err) {
        console.error(`\nintegration (build change, run ${run}): FAILED`);
        console.error(err);
        console.error('\n── server log tail ──');
        console.error(significantLogTail(log));
        process.exitCode = 1;
      } finally {
        if (!serverGone) server.kill();
        await serverExited;
      }
      if (process.exitCode === 1) return;
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(appRoot, { recursive: true, force: true });
  }
}

/**
 * Phase 1d (testing kit): testing-kit.test.ts runs the `@gio.js/core/testing`
 * helpers under node:test + tsx - the setup the docs describe - including
 * createTestServer against this binary, on free ports. Then
 * testing-kit-forgotten-close.test.ts, under `node --test`, starts a server
 * it never closes: the run must still end on its own. Afterwards no server
 * or worker of the kit's fixture may be left running (Linux checks the
 * process table; Windows ties workers to the server with a job object).
 */
async function testingKitPhase() {
  const kitFixture = join(repoRoot, 'packages', 'giojs-core', 'test-fixtures', 'testing-app');
  // `--import tsx` resolves from the cwd: giojs-core has tsx installed.
  const nodeTest = (args, timeout) =>
    spawnSync(process.execPath, ['--import', 'tsx', ...args], {
      cwd: join(repoRoot, 'packages', 'giojs-core'),
      env: { ...process.env, GIO_SERVER_BIN: findServerBinary() },
      encoding: 'utf8',
      timeout,
    });
  const run = nodeTest([join(repoRoot, 'tests', 'integration', 'testing-kit.test.ts')], 180_000);
  const forgotten = nodeTest(
    ['--test', join(repoRoot, 'tests', 'integration', 'testing-kit-forgotten-close.test.ts')],
    60_000,
  );
  try {
    await test('testing kit: the node:test suite passes against the real server', async () => {
      assert.equal(run.status, 0, `node:test run failed:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout, /^# fail 0$/m);
      assert.doesNotMatch(run.stdout, /^# pass 0$/m);
    });

    await test('testing kit: a node --test run that never calls close() still ends', async () => {
      assert.equal(forgotten.error?.code, undefined, `the run did not end on its own:\n${forgotten.stdout}`);
      assert.equal(forgotten.status, 0, `node --test run failed:\n${forgotten.stdout}\n${forgotten.stderr}`);
      assert.match(forgotten.stdout, /^# pass 1$/m);
    });

    await test('testing kit: no server or worker outlives the test process', async () => {
      if (process.platform !== 'linux') return;
      const survivors = [];
      for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          if (readlinkSync(`/proc/${name}/cwd`) === kitFixture) survivors.push(Number(name));
        } catch {
          // Gone, or not ours to inspect.
        }
      }
      assert.deepEqual(survivors, [], 'processes still running from the kit fixture');
    });
  } catch (err) {
    console.error('\nintegration (testing kit): FAILED');
    console.error(err);
    process.exitCode = 1;
  }
}

/**
 * Rewrite (or create) `file` and wait until `probe` sees the effect. CI runners sometimes
 * drop the very first watch event under load, so the file is re-touched
 * every 30s (at most twice) while nothing has happened yet.
 */
async function editAndWait(what, file, edit, probe, timeoutMs = 90_000) {
  const current = await readFile(file, 'utf8').catch(() => '');
  await writeFile(file, edit(current));
  const started = Date.now();
  let retouches = 0;
  await waitFor(what, async () => {
    if (await probe()) return true;
    if (Date.now() - started > 30_000 * (retouches + 1) && retouches < 2) {
      retouches++;
      console.log(`  (re-touching ${file} - watch event likely dropped, attempt ${retouches})`);
      await writeFile(file, await readFile(file, 'utf8'));
    }
    return false;
  }, timeoutMs);
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
  // Data the app writes into the project, which must never restart it.
  await writeFile(
    join(devDir, 'gio.toml'),
    (await readFile(join(devDir, 'gio.toml'), 'utf8')) +
      '\n[dev]\nwatch_ignore = ["data/**", "components/*.db.json"]\n',
  );

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

    await test('dev: cached pages send no ETag, so a CSS edit is never answered with a 304', async () => {
      // Dev inlines the current critical CSS into every response: a tag of
      // the stored markup would 304 the browser onto stale styles.
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`${BASE}/cached`);
        assert.match(await res.text(), /INTEGRATION_FIXTURE_CACHED/);
        assert.match(res.headers.get('x-gio-cache') ?? '', /^(miss; stored|hit)/);
        assert.equal(res.headers.get('etag'), null);
      }
      const conditional = await rawGet('/cached', { 'if-none-match': '*' });
      assert.equal(conditional.status, 200);
      assert.match(conditional.body, /INTEGRATION_FIXTURE_CACHED/);
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
      // In a hidden directory: the dev watcher covers the whole project and
      // restarts the worker for a `.ts` anywhere else, racing the watch
      // tests below. Hidden directories are ignored at every depth.
      const restarts = () => (log.match(/dev watch: change detected/g) ?? []).length;
      const restartsBefore = restarts();
      const scratch = join(devDir, '.scratch');
      await mkdir(scratch, { recursive: true });
      await writeFile(join(scratch, 'secret.env'), 'TOKEN=integration-secret\n');
      // Symlinks need Developer Mode / admin rights on Windows.
      if (process.platform !== 'win32') {
        await symlink(join(scratch, 'secret.env'), join(scratch, 'leak.ts'));
        const res = await rawRequest('GET', '/_gio/devtools/codeframe?file=.scratch%2Fleak.ts&line=1', {
          host: trustedHost,
        });
        assert.equal(res.status, 400);
        assert.doesNotMatch(res.body, /integration-secret/);
      }
      const direct = await rawRequest('GET', '/_gio/devtools/codeframe?file=.scratch%2Fsecret.env&line=1', {
        host: trustedHost,
      });
      assert.equal(direct.status, 400);
      // Past the watcher's 300ms batching window: still no restart.
      await sleep(1_000);
      assert.equal(restarts(), restartsBefore, 'the fixture files must not restart the worker');
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

    let devSessionCookie = '';
    await test('dev: without GIO_SESSION_SECRET the server and worker share an ephemeral one', async () => {
      assert.match(log, /GIO_SESSION_SECRET not set - using an ephemeral development session secret/);
      const res = await loginAs('dev-user');
      assert.equal(res.status, 200);
      // Plain-http development: no Secure attribute by default.
      assert.doesNotMatch(res.headers.getSetCookie()[0], /Secure/);
      devSessionCookie = sessionCookieOf(res);
      const page = await fetch(`${BASE}/session-dashboard`, { headers: { cookie: devSessionCookie }, redirect: 'manual' });
      assert.equal(page.status, 200, 'the Rust guard verifies what the worker signed');
      assert.match(await page.text(), /user=(<!-- -->)?dev-user/);
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

    await test('dev: sessions survive a worker restart (the secret lives in the server)', async () => {
      const page = await fetch(`${BASE}/session-dashboard`, { headers: { cookie: devSessionCookie }, redirect: 'manual' });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /user=(<!-- -->)?dev-user/);
    });

    await test('dev: dev-only /_gio endpoints still serve in development', async () => {
      const res = await fetch(`${BASE}/_gio/devtools`);
      assert.equal(res.status, 200);
      await res.text();
    });

    await test('dev watch: the page cache is cleared so cached routes update too', async () => {
      await waitFor('cached route to serve fresh content', async () => {
        const html = await (await fetch(`${BASE}/cached`)).text();
        return html.includes('WATCH_UPDATED_CACHED');
      }, 30_000);
    });

    const restartCount = () => (log.match(/dev watch: worker restarted/g) ?? []).length;
    const changeCount = () => (log.match(/dev watch: change detected/g) ?? []).length;

    await test('dev watch: editing a module outside app/ restarts the worker', async () => {
      assert.match(await (await fetch(`${BASE}/with-component`)).text(), /FIXTURE_COMPONENT_ORIGINAL/);
      const restartsBefore = restartCount();
      await editAndWait(
        'components/ edit to be served',
        join(devDir, 'components', 'Banner.tsx'),
        (src) => src.replace('FIXTURE_COMPONENT_ORIGINAL', 'WATCH_UPDATED_COMPONENT'),
        async () => (await (await fetch(`${BASE}/with-component`)).text()).includes('WATCH_UPDATED_COMPONENT'),
      );
      await waitFor('component-triggered restart completed', () =>
        Promise.resolve(restartCount() > restartsBefore), 90_000);
    });

    await test('dev watch: editing a CSS Module rebuilds the route stylesheet', async () => {
      const routeCss = async () => {
        const html = await (await fetch(`${BASE}/styled`)).text();
        const href = html.match(/href="(\/_next\/static\/css\/route-styled-[A-Z0-9]+\.css)"/)?.[1];
        return href === undefined ? '' : (await fetch(`${BASE}${href}`)).text();
      };
      assert.match(await routeCss(), /rebeccapurple/);
      await editAndWait(
        'CSS edit to be served',
        join(devDir, 'app', 'styled', 'card.module.css'),
        (src) => src.replace('rebeccapurple', 'darkorange'),
        async () => (await routeCss()).includes('darkorange'),
      );
    });

    await test('dev watch: public/ changes refresh root serving without a worker restart', async () => {
      const restartsBefore = restartCount();
      const added = join(devDir, 'public', 'added-in-dev.txt');
      assert.equal((await fetch(`${BASE}/added-in-dev.txt`)).status, 404);
      await editAndWait(
        'new public/ file to be served at the root',
        added,
        () => 'ADDED_IN_DEV\n',
        async () => {
          const res = await fetch(`${BASE}/added-in-dev.txt`);
          return res.status === 200 && (await res.text()) === 'ADDED_IN_DEV\n';
        },
      );
      assert.match(log, /dev watch: public\/ index refreshed/);
      assert.equal(restartCount(), restartsBefore, 'public/ edits must not restart the worker');
    });

    await test('dev watch: the worker writing .gio/ output does not retrigger the watcher', async () => {
      // The restarts above rebuilt .gio/build and .gio/routes.d.ts inside the
      // watched root; a feedback loop would show up as further restarts.
      const changesBefore = changeCount();
      await sleep(3_000);
      assert.equal(changeCount(), changesBefore, 'no change may be detected while idle');
    });

    await test('dev watch: [dev] watch_ignore files never restart the worker', async () => {
      // .json is a source extension: without watch_ignore both would restart.
      const changesBefore = changeCount();
      await mkdir(join(devDir, 'data'), { recursive: true });
      for (let i = 0; i < 2; i++) {
        await writeFile(join(devDir, 'data', 'db.json'), `{"todos":${i}}\n`);
        await writeFile(join(devDir, 'components', 'todos.db.json'), `{"todos":${i}}\n`);
      }
      // Past the watcher's 300ms batching window.
      await sleep(1_000);
      assert.equal(changeCount(), changesBefore, 'watch_ignore matches must not be changes');
      assert.doesNotMatch(log, /watching new directory.*[\\/]data\b/, 'an ignored top-level dir is never registered');
    });

    await test('dev watch: a new top-level directory during an event burst keeps the watcher alive', async () => {
      // New top-level directories used to be registered by the task that
      // drains the watcher's bounded channel. A burst arriving while that
      // task awaited a worker restart (a git checkout, say) filled the
      // channel, and both sides then waited on each other for good.
      const banner = join(devDir, 'components', 'Banner.tsx');
      const changesBefore = changeCount();
      await writeFile(banner, (await readFile(banner, 'utf8')) + '\n// burst\n');
      await waitFor('the restart to begin', () => Promise.resolve(changeCount() > changesBefore), 60_000);
      // A name the fixture copy never contains (it already has lib/).
      await mkdir(join(devDir, 'burst-new-dir'));
      for (let i = 0; i < 500; i++) {
        await writeFile(join(devDir, 'components', `burst-${i}.json`), '{}\n');
      }
      await waitFor('burst-new-dir/ to be watched', () => Promise.resolve(/watching new directory/.test(log)), 30_000);
      await editAndWait(
        'an edit after the burst to be served',
        banner,
        (src) => src.replace('WATCH_UPDATED_COMPONENT', 'AFTER_BURST_COMPONENT'),
        async () => (await (await fetch(`${BASE}/with-component`)).text()).includes('AFTER_BURST_COMPONENT'),
      );
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
 * Phase 2b (dev mode, a visible [cache] disk_path shared with app data):
 * the cache's own writes are not source changes - they used to restart the
 * worker and clear the cache after every miss, so the cache never hit - and
 * clearing the cache deletes only its own files, never the app's data.
 */
async function devCacheDirPhase() {
  const binary = findServerBinary();
  const devDir = await copyFixtureForDev('.dev-cache-fixture');
  const dataDir = join(devDir, 'data');
  const dbFile = join(dataDir, 'db.json');
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbFile, '{"todos":[]}\n');
  await writeFile(
    join(devDir, 'gio.toml'),
    (await readFile(join(devDir, 'gio.toml'), 'utf8')) + '\n[cache]\ndisk_path = "data"\n',
  );
  const env = {
    ...process.env,
    GIO_APP_DIR: join(devDir, 'app'),
    RUST_LOG: 'info',
    NODE_ENV: 'development',
  };
  delete env.GIO_CACHE_DIR;

  let log = '';
  const server = spawn(binary, [], { cwd: repoRoot, env });
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  let serverGone = false;
  const serverExited = new Promise((r) =>
    server.on('exit', () => { serverGone = true; r(); }),
  );
  const entryFiles = async () =>
    (await readdir(dataDir)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  const changeCount = () => (log.match(/dev watch: change detected/g) ?? []).length;

  try {
    await waitFor('dev server health (visible cache dir)', async () => {
      const res = await fetch(`${BASE}/_gio/health`);
      return res.ok && (await res.json()).nodeReady === true;
    }, 30_000);

    await test('dev: a visible [cache] disk_path hits without restarting the worker', async () => {
      const statuses = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${BASE}/cached`);
        assert.match(await res.text(), /INTEGRATION_FIXTURE_CACHED/);
        statuses.push((res.headers.get('x-gio-cache') ?? '').split(';')[0]);
        await waitFor('the entry file', async () => (await entryFiles()).length > 0, 10_000);
        // Past the watcher's 300 ms batching window: a restart would have begun.
        await sleep(1_000);
      }
      assert.deepEqual(statuses, ['miss', 'hit', 'hit']);
      assert.equal(changeCount(), 0, 'cache writes are no source change');
    });

    await test('dev: clearing a shared cache directory keeps the app data in it', async () => {
      // A source edit restarts the worker, which clears the cache.
      const banner = join(devDir, 'components', 'Banner.tsx');
      await editAndWait(
        'an edit to restart the worker',
        banner,
        (src) => src + '\n// restart\n',
        async () => /dev watch: worker restarted/.test(log),
      );
      await waitFor('the cache entries to be cleared', async () => (await entryFiles()).length === 0, 10_000);
      assert.equal(await readFile(dbFile, 'utf8'), '{"todos":[]}\n');
    });
  } catch (err) {
    console.error('\nintegration (dev, visible cache dir): FAILED');
    console.error(err);
    console.error('\n── dev server log tail ──');
    console.error(significantLogTail(log));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(devDir, { recursive: true, force: true });
  }
}

/**
 * Phase 3 (standalone): `gio build standalone` against a minimal generated
 * app, then boot the output dir with NO node_modules present and prove pages,
 * prebuilt hydration chunks, and API routes all serve - and that tearing the
 * launcher down leaves no orphaned worker. A generated app (not the fixture)
 * keeps the bundle graph free of the fixture's monorepo-relative imports.
 * The same app is also `gio export`ed: static pages must ship the chunks
 * they hydrate from.
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
    // An interactive control for hydrate-export.mjs: its text shows whether
    // React mounted (an effect ran) and whether a click reached the handler.
    const probe = (label) =>
      '  const [mounted, setMounted] = React.useState(false);\n' +
      '  const [clicks, setClicks] = React.useState(0);\n' +
      '  React.useEffect(() => setMounted(true), []);\n' +
      '  const probe = <button data-probe="" onClick={() => setClicks((n) => n + 1)}>' +
      `{\`${label} mounted=\${mounted} clicks=\${clicks}\`}</button>;\n`;
    // GioLink's and the router hooks' source, copied in: a path into the
    // repo would not be a relative import (another drive on Windows CI) or a
    // resolvable package.
    await mkdir(join(workDir, 'components', 'hooks'), { recursive: true });
    for (const file of [
      'Link.tsx',
      'navigation.ts',
      'navigation-context.ts',
      'typed-href.ts',
      join('hooks', 'useNavigation.ts'),
    ]) {
      await cp(join(repoRoot, 'packages', 'giojs-react', 'src', file), join(workDir, 'components', file));
    }
    // What the router hooks render: hydration must reproduce it exactly, and
    // a soft navigation must update it.
    const routerProbe =
      "  const routerText = `ROUTER pathname=[${usePathname()}] id=[${useParams().id ?? ''}]`;\n";
    await writeFile(
      join(workDir, 'app', 'page.tsx'),
      "import React from 'react';\nimport { GioLink } from '../components/Link.tsx';\n" +
        "import { useParams, usePathname } from '../components/hooks/useNavigation.ts';\n\nexport default function Home() {\n" +
        probe('HOME') +
        routerProbe +
        '  return (\n    <main>\n' +
        '      <h1>STANDALONE_FIXTURE_HOME {process.env.GIO_PUBLIC_STANDALONE_GREETING}</h1>\n' +
        '      <p>{routerText}</p>\n' +
        '      {probe}\n      <GioLink href="/posts/7">post 7</GioLink>\n    </main>\n  );\n}\n' +
        // Head metadata: soft navigation must swap it for the post's.
        "\nexport const metadata = { title: 'STANDALONE_HOME_TITLE', description: 'STANDALONE_HOME_DESC',\n" +
        "  openGraph: { title: 'STANDALONE_HOME_OG' } };\n",
    );
    // App-root metadata conventions travel in the registry (and gio export).
    await writeFile(
      join(workDir, 'app', 'robots.ts'),
      "export default { rules: { userAgent: '*', disallow: '/private' }, sitemap: 'https://standalone.example/sitemap.xml' };\n",
    );
    await writeFile(
      join(workDir, 'app', 'sitemap.ts'),
      "export const revalidate = 0;\nexport default () => [{ url: 'https://standalone.example/', priority: 0.5 }];\n",
    );
    await writeFile(
      join(workDir, 'app', 'api', 'hello', 'route.ts'),
      'export function GET() {\n' +
        '  const { GIO_PUBLIC_STANDALONE_GREETING } = process.env;\n' +
        "  return { ok: true, source: 'standalone', dotenv: process.env.GIO_STANDALONE_DOTENV ?? null,\n" +
        '    buildOnly: process.env.GIO_STANDALONE_BUILD_ONLY ?? null,\n' +
        '    publicDestructured: GIO_PUBLIC_STANDALONE_GREETING ?? null };\n}\n',
    );
    // A module that throws while it is imported (a missing secret, an
    // env.server.ts check), shared by a route.ts and a page: the bundle
    // evaluates them lazily, so the worker still starts and each URL
    // answers 500 with the module's own error in the log.
    await mkdir(join(workDir, 'lib'), { recursive: true });
    await mkdir(join(workDir, 'app', 'api', 'needs-env'), { recursive: true });
    await mkdir(join(workDir, 'app', 'needs-env'), { recursive: true });
    await writeFile(
      join(workDir, 'lib', 'required-env.server.ts'),
      "if (!process.env.STANDALONE_REQUIRED_VAR) throw new Error('STANDALONE_REQUIRED_VAR is not set');\n" +
        'export const required = process.env.STANDALONE_REQUIRED_VAR;\n',
    );
    await writeFile(
      join(workDir, 'app', 'api', 'needs-env', 'route.ts'),
      "import { required } from '../../../lib/required-env.server.ts';\n\nexport function POST() {\n  return { required };\n}\n",
    );
    await writeFile(
      join(workDir, 'app', 'needs-env', 'page.tsx'),
      "import React from 'react';\nimport { required } from '../../lib/required-env.server.ts';\n\n" +
        'export async function getServerSideProps() {\n  return { props: { required: required.toUpperCase() } };\n}\n\n' +
        'export default function NeedsEnv({ required }) {\n  return <p>{required}</p>;\n}\n',
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
    // CSS imports travel too: a layout's global stylesheet and a page's CSS
    // Module, whose class worker.js (SSR) and the chunk must agree on.
    await writeFile(
      join(workDir, 'app', '(blog)', 'layout.tsx'),
      "import React from 'react';\nimport './blog.css';\n\nexport const metadata = { title: { default: 'Blog', template: '%s | Blog' } };\n\n" +
        "export default function BlogLayout({ children }) {\n  return <section data-layout=\"STANDALONE_BLOG_LAYOUT\">{children}</section>;\n}\n",
    );
    await writeFile(join(workDir, 'app', '(blog)', 'blog.css'), '.standalone-blog-css { color: red; }\n');
    await writeFile(join(workDir, 'app', '(blog)', 'posts', '[id]', 'post.module.css'), '.title { color: blue; }\n');
    await writeFile(
      join(workDir, 'app', '(blog)', 'posts', '[id]', 'page.tsx'),
      "import React from 'react';\nimport styles from './post.module.css';\n" +
        "import { useParams, usePathname } from '../../../../components/hooks/useNavigation.ts';\n\n" +
        'export default function Post({ params }) {\n' +
        probe('POST') +
        routerProbe +
        '  return <><p className={styles.title}>{`STANDALONE_POST id=[${params.id}]`}</p><p>{routerText}</p>{probe}</>;\n}\n' +
        "\nexport async function getServerSideProps(ctx) {\n" +
        "  return ctx.params.id === 'missing' ? { notFound: true } : { props: { params: ctx.params } };\n}\n" +
        "\nexport async function generateMetadata(ctx) {\n  return { title: `STANDALONE_ARTICLE_TITLE ${ctx.params.id}` };\n}\n" +
        // For `gio export`; the server must ignore it (any id renders).
        "\nexport function getStaticPaths() {\n  return { paths: [{ params: { id: '7' } }] };\n}\n",
    );
    // Per-folder files travel in the registry (not-found) and the prebuilt
    // client entries (error boundary).
    await writeFile(
      join(workDir, 'app', '(blog)', 'not-found.tsx'),
      "import React from 'react';\n\nexport default function BlogNotFound() {\n  return <h1>STANDALONE_BLOG_NOT_FOUND</h1>;\n}\n",
    );
    await writeFile(
      join(workDir, 'app', '(blog)', 'error.tsx'),
      "import React from 'react';\n\nexport default function BlogError() {\n  return <h1>STANDALONE_BLOG_ERROR</h1>;\n}\n",
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

    // .gio/manifest.json is what Rust hashes into a standalone deployment ID:
    // it must change with server-only code (a metadata export never reaches
    // the client chunks) and stay put for a rebuild of the same code.
    await test('standalone: the manifest tracks server-only code, deterministically', async () => {
      const buildInto = (out) => {
        const build = spawnSync(
          process.execPath,
          [join(repoRoot, 'packages', 'giojs', 'bin', 'standalone.mjs'), '--out', out],
          { cwd: workDir, env: { ...process.env, GIO_STANDALONE_SERVER_BIN: binary }, encoding: 'utf8', timeout: 180_000 },
        );
        assert.equal(build.status, 0, `standalone build failed:\n${build.stdout ?? ''}\n${build.stderr ?? ''}`);
      };
      const manifestOf = async (out) => JSON.parse(await readFile(join(out, '.gio', 'manifest.json'), 'utf8'));
      const first = await manifestOf(outDir);
      assert.match(first.worker, /^[0-9a-f]{64}$/, 'manifest carries the worker.js hash');
      const again = join(workDir, 'dist-standalone-again');
      buildInto(again);
      assert.equal((await manifestOf(again)).worker, first.worker, 'same code, same worker hash');
      const page = join(workDir, 'app', 'page.tsx');
      const original = await readFile(page, 'utf8');
      await writeFile(page, original.replace('STANDALONE_HOME_TITLE', 'STANDALONE_HOME_TITLE_V2'));
      const changed = join(workDir, 'dist-standalone-changed');
      try {
        buildInto(changed);
      } finally {
        await writeFile(page, original);
      }
      const next = await manifestOf(changed);
      assert.deepEqual(next.clientScripts, first.clientScripts, 'a metadata edit leaves the client chunks alone');
      assert.notEqual(next.worker, first.worker, 'a server-only edit changes the manifest');
    });

    // The standalone worker serves the stylesheets the build baked and never
    // rebuilds them, so the build itself must follow `[css] minify`.
    await test('standalone: [css] minify = false bakes unminified route stylesheets', async () => {
      const cssOf = async (out) => {
        const dir = join(out, 'static', 'css');
        const files = (await readdir(dir)).filter((name) => name.endsWith('.css'));
        return (await Promise.all(files.map((name) => readFile(join(dir, name), 'utf8')))).join('\n');
      };
      assert.match(await cssOf(outDir), /\.standalone-blog-css\{color:red\}/, 'minified by default');
      const toml = join(workDir, 'gio.toml');
      const original = await readFile(toml, 'utf8');
      await writeFile(toml, `${original}\n[css]\nminify = false\n`);
      const unminified = join(workDir, 'dist-standalone-unminified');
      let build;
      try {
        build = spawnSync(
          process.execPath,
          [join(repoRoot, 'packages', 'giojs', 'bin', 'standalone.mjs'), '--out', unminified],
          { cwd: workDir, env: { ...process.env, GIO_STANDALONE_SERVER_BIN: binary }, encoding: 'utf8', timeout: 180_000 },
        );
      } finally {
        await writeFile(toml, original);
      }
      assert.equal(build.status, 0, `standalone build failed:\n${build.stdout ?? ''}\n${build.stderr ?? ''}`);
      assert.match(build.stdout, /css: {4}unminified \(\[css\] minify = false\)/);
      assert.match(await cssOf(unminified), /\.standalone-blog-css \{\n {2}color: red;\n\}/);
    });

    await test('static export: pages hydrate from chunks shipped in out/', async () => {
      const exportOut = join(workDir, 'out');
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'packages', 'giojs', 'bin', 'gio.js'), 'export'],
        { cwd: workDir, env: { ...process.env, GIO_OUT_DIR: exportOut }, encoding: 'utf8', timeout: 120_000 },
      );
      assert.equal(result.status, 0, `gio export failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
      assert.doesNotMatch(result.stdout, /no client JS/, 'every page hydrates');
      const envelopeOf = (html) =>
        JSON.parse(html.match(/<script id="__gio_props" type="application\/json">([^<]*)</)?.[1] ?? 'null');
      for (const [page, marker] of [['index.html', 'STANDALONE_FIXTURE_HOME'], ['posts/7/index.html', 'STANDALONE_POST']]) {
        const html = await readFile(join(exportOut, ...page.split('/')), 'utf8');
        assert.match(html, new RegExp(marker));
        const envelope = envelopeOf(html);
        assert.ok(envelope, `${page} carries the hydration envelope`);
        assert.equal(envelope.images.unoptimized, true, 'no image optimizer on a static host');
        assert.ok(html.includes(`<script type="module" src="${envelope.entry}"`), `${page} bootstraps its entry`);
        const entryFile = join(exportOut, ...envelope.entry.split('/').filter(Boolean));
        assert.ok(existsSync(entryFile), `${envelope.entry} exists in out/`);
        const entryJs = await readFile(entryFile, 'utf8');
        for (const [, shared] of entryJs.matchAll(/["'](\.\/shared-[A-Z0-9]+\.js)["']/g)) {
          assert.ok(existsSync(join(dirname(entryFile), shared)), `${shared} exists next to the entry`);
        }
        if (page === 'index.html') {
          assert.match(entryJs, /STANDALONE_PUBLIC_VALUE/, 'GIO_PUBLIC_* frozen at export time');
        }
      }
      // The post's stylesheet ships in out/ with the class its HTML renders.
      const post = await readFile(join(exportOut, 'posts', '7', 'index.html'), 'utf8');
      const postClass = post.match(/<p class="(post_[0-9a-f]{6}_title)">/)?.[1];
      assert.ok(postClass, 'the CSS Module class is rendered');
      const sheet = post.match(/<link rel="stylesheet" href="(\/_next\/static\/css\/route-[^"]+\.css)"/)?.[1];
      assert.ok(sheet, 'the post links its stylesheet');
      const css = await readFile(join(exportOut, ...sheet.split('/').filter(Boolean)), 'utf8');
      assert.ok(css.includes(`.${postClass}{color:`) && css.includes('.standalone-blog-css'), css);
      assert.ok(existsSync(join(exportOut, '404.html')));
    });

    await test('static export: the shipped bundle hydrates, and GioLink navigates the out/ file layout', async () => {
      const exportOut = join(workDir, 'out');
      const browser = spawnSync(
        process.execPath,
        [join(repoRoot, 'tests', 'integration', 'hydrate-export.mjs'), exportOut, '/', '/posts/7'],
        { encoding: 'utf8', timeout: 60_000 },
      );
      let report;
      try {
        report = JSON.parse((browser.stdout ?? '').trim().split('\n').at(-1));
      } catch {
        assert.fail(`hydrate-export printed no report (exit ${browser.status}):\n${browser.stdout}\n${browser.stderr}`);
      }
      assert.deepEqual(report.errors, [], 'no hydration or runtime errors');
      assert.equal(browser.status, 0);
      // The exported page hydrated from out/_next/static/chunks.
      assert.equal(report.start.mounted, 'HOME mounted=true clicks=0');
      assert.equal(report.start.afterClick, 'HOME mounted=true clicks=1');
      // The click fetched the static file, swapped it in, and mounted its route.
      assert.deepEqual(report.fetched, ['/posts/7']);
      assert.equal(report.nav.pathname, '/posts/7');
      assert.equal(report.nav.envelopePath, '/posts/7');
      assert.match(report.nav.content, /STANDALONE_POST id=\[7\]/);
      // The hooks hydrated from the envelope (no mismatch: report.errors is
      // empty) and follow the soft navigation.
      assert.match(report.start.content, /ROUTER pathname=\[\/\] id=\[\]/);
      assert.match(report.nav.content, /ROUTER pathname=\[\/posts\/7\] id=\[7\]/);
      assert.equal(report.nav.mounted, 'POST mounted=true clicks=0');
      assert.equal(report.nav.afterClick, 'POST mounted=true clicks=1');
      // Head metadata: hydration adopted the home page's tags, and the
      // navigation replaced them with exactly the post's (no leftovers).
      assert.deepEqual(report.start.head, [
        'title=STANDALONE_HOME_TITLE',
        'description=STANDALONE_HOME_DESC',
        'og:title=STANDALONE_HOME_OG',
      ]);
      assert.deepEqual(report.nav.head, ['title=STANDALONE_ARTICLE_TITLE 7 | Blog']);
      // The post's stylesheet was loaded for the navigation, exactly once.
      const postSheets = report.nav.stylesheets.filter((href) => /\/route-[^/]*posts[^/]*\.css$/.test(href));
      assert.equal(postSheets.length, 1, JSON.stringify(report.nav.stylesheets));
      assert.deepEqual(report.stylesheetsLoaded, postSheets);
    });

    await test('static export: sitemap.xml and robots.txt come from app/sitemap.ts and app/robots.ts', async () => {
      const exportOut = join(workDir, 'out');
      assert.equal(
        await readFile(join(exportOut, 'robots.txt'), 'utf8'),
        'User-Agent: *\nDisallow: /private\n\nSitemap: https://standalone.example/sitemap.xml\n',
      );
      assert.match(
        await readFile(join(exportOut, 'sitemap.xml'), 'utf8'),
        /<loc>https:\/\/standalone\.example\/<\/loc>\n<priority>0\.5<\/priority>/,
      );
    });

    // Runtime env lives in the deploy dir: run.mjs starts the server there.
    await writeFile(join(outDir, '.env'), 'GIO_STANDALONE_DOTENV=from-deploy-dir\n');

    // The output must be self-contained: delete the app sources and the
    // node_modules the build used before booting it.
    await rm(join(workDir, 'app'), { recursive: true, force: true });
    await rm(join(workDir, 'lib'), { recursive: true, force: true });
    await rm(join(workDir, 'node_modules'), { recursive: true, force: true });

    const startLauncher = async () => {
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
    };
    await startLauncher();

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

    await test('standalone: a module that throws while imported fails its URLs with 500, not the worker', async () => {
      const route = await fetch(`${STANDALONE_BASE}/api/needs-env`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(route.status, 500);
      const body = await route.json();
      assert.equal(body.error, 'Internal Server Error');
      assert.match(body.digest, /^[0-9a-f]{12}$/);
      // The log line under that digest names the route file and the error.
      const logLine = (needle) => log.split('\n').find((line) => line.includes(needle));
      await waitFor('route failure logged', async () => logLine(`"digest":"${body.digest}"`) !== undefined, 5_000);
      const routeLine = logLine(`"digest":"${body.digest}"`);
      assert.match(routeLine, /"msg":"route file failed to load"/);
      assert.match(routeLine, /needs-env[\\/]+route\.ts/);
      assert.match(routeLine, /"error":"STANDALONE_REQUIRED_VAR is not set"/);
      // OPTIONS too: a 405 would list methods the module may never export.
      const options = await fetch(`${STANDALONE_BASE}/api/needs-env`, { method: 'OPTIONS' });
      assert.equal(options.status, 500);
      assert.equal(options.headers.get('allow'), null);
      await options.text();
      // A WebSocket to it is closed with 1011 under a logged digest, not
      // the 4404 of a path without a wsHandler.
      const ws = new WebSocket(`${STANDALONE_BASE.replace(/^http/, 'ws')}/api/needs-env`);
      const closed = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket to a failed route.ts never closed')), 5_000);
        ws.addEventListener('close', (event) => {
          clearTimeout(timer);
          resolve({ code: event.code, reason: event.reason });
        });
      });
      assert.equal(closed.code, 1011);
      const wsDigest = /^internal error \(digest ([0-9a-f]{12})\)$/.exec(closed.reason)?.[1];
      assert.ok(wsDigest, `close reason: ${closed.reason}`);
      await waitFor('ws failure logged', async () => logLine(`"digest":"${wsDigest}"`) !== undefined, 5_000);
      const wsLine = logLine(`"digest":"${wsDigest}"`);
      assert.match(wsLine, /"msg":"route file failed to load"/);
      assert.match(wsLine, /needs-env[\\/]+route\.ts/);
      // The page sharing the module reports the same error - not a TypeError
      // on the export the failed evaluation left undefined.
      const page = await fetch(`${STANDALONE_BASE}/needs-env`);
      assert.equal(page.status, 500);
      await page.text();
      await waitFor('page failure logged', async () => logLine('"path":"/needs-env"') !== undefined, 5_000);
      const pageLine = logLine('"path":"/needs-env"');
      assert.match(pageLine, /"msg":"ssr render failed"/);
      assert.match(pageLine, /"error":"STANDALONE_REQUIRED_VAR is not set"/);
      assert.equal((await fetch(`${STANDALONE_BASE}/api/hello`)).status, 200);
    });

    await test('standalone: group layouts apply to dynamic pages from the prebuilt registry', async () => {
      const res = await fetch(`${STANDALONE_BASE}/posts/7`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /STANDALONE_POST id=\[7\]/);
      // getStaticPaths is export-only: the server renders any id.
      assert.match(await (await fetch(`${STANDALONE_BASE}/posts/8`)).text(), /STANDALONE_POST id=\[8\]/);
      assert.ok(html.indexOf('STANDALONE_BLOG_LAYOUT') !== -1, 'the (blog) layout must apply');
      assert.ok(html.indexOf('STANDALONE_BLOG_LAYOUT') < html.indexOf('STANDALONE_POST'));
      assert.doesNotMatch(await (await fetch(`${STANDALONE_BASE}/`)).text(), /STANDALONE_BLOG_LAYOUT/);
    });

    await test('standalone: metadata and the robots/sitemap modules come from the prebuilt registry', async () => {
      const post = await (await fetch(`${STANDALONE_BASE}/posts/7`)).text();
      assert.match(post, /<title>STANDALONE_ARTICLE_TITLE 7 \| Blog<\/title>/);
      const robots = await fetch(`${STANDALONE_BASE}/robots.txt`);
      assert.equal(robots.status, 200);
      assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.match(await robots.text(), /^User-Agent: \*\nDisallow: \/private\n/);
      const sitemap = await fetch(`${STANDALONE_BASE}/sitemap.xml`);
      assert.equal(sitemap.headers.get('content-type'), 'application/xml; charset=utf-8');
      // revalidate = 0: generated per request, never cached.
      assert.equal(sitemap.headers.get('x-gio-cache'), 'bypass');
      assert.match(await sitemap.text(), /<loc>https:\/\/standalone\.example\/<\/loc>/);
    });

    await test('standalone: CSS imports render their class and ship their prebuilt stylesheet', async () => {
      const html = await (await fetch(`${STANDALONE_BASE}/posts/7`)).text();
      const postClass = html.match(/<p class="(post_[0-9a-f]{6}_title)">/)?.[1];
      assert.ok(postClass, 'worker.js rendered the CSS Module class');
      const sheet = html.match(/<link rel="stylesheet" href="(\/_next\/static\/css\/route-[^"]+\.css)" data-precedence="default"\/>/)?.[1];
      assert.ok(sheet, 'the stylesheet is linked');
      const res = await fetch(`${STANDALONE_BASE}${sheet}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/css/);
      assert.match(res.headers.get('cache-control') ?? '', /immutable/);
      const css = await res.text();
      assert.ok(css.includes(`.${postClass}{color:`) && css.includes('.standalone-blog-css'), css);
      // The prebuilt chunk hydrates with the same class name.
      const chunk = html.match(/\/_next\/static\/chunks\/route-[^"]+?-[A-Z0-9]+\.js/)?.[0];
      assert.match(await (await fetch(`${STANDALONE_BASE}${chunk}`)).text(), new RegExp(`"${postClass}"`));
    });

    await test('standalone: per-folder not-found and error files come from the prebuilt registry', async () => {
      const missing = await fetch(`${STANDALONE_BASE}/posts/missing`);
      assert.equal(missing.status, 404);
      const html = await missing.text();
      assert.match(html, /STANDALONE_BLOG_NOT_FOUND/);
      assert.ok(html.indexOf('STANDALONE_BLOG_LAYOUT') < html.indexOf('STANDALONE_BLOG_NOT_FOUND'));
      const page = await (await fetch(`${STANDALONE_BASE}/posts/7`)).text();
      const chunk = page.match(/\/_next\/static\/chunks\/route-[^"]+?-[A-Z0-9]+\.js/)?.[0];
      assert.ok(chunk, 'post page has a prebuilt chunk');
      assert.match(await (await fetch(`${STANDALONE_BASE}${chunk}`)).text(), /STANDALONE_BLOG_ERROR/);
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

    if (process.platform !== 'win32') {
      await test('standalone: a SIGKILLed launcher takes the server and worker down, freeing the port', async () => {
        await startLauncher();
        const tree = descendantPids(run.pid);
        assert.ok(tree.length >= 2, 'server and worker run under the launcher');
        // SIGKILL cannot be forwarded: the server sees EOF on the stdin pipe
        // the launcher held (GIO_EXIT_ON_STDIN_EOF) and shuts down itself.
        run.kill('SIGKILL');
        await waitFor('launcher exit', () => Promise.resolve(runGone), 5_000);
        await waitFor('server and worker gone', () => Promise.resolve(!tree.some(processRunning)), 5_000);
        await assert.rejects(fetch(`${STANDALONE_BASE}/_gio/health`), 'nothing listens on the port');
        assert.match(log, /stdin closed: the launcher exited - shutting down/);
      });
    }

    await test('standalone: a worker pool boots from the prebuilt registry', async () => {
      const toml = join(outDir, 'gio.toml');
      const pooled = (await readFile(toml, 'utf8')).replace('http2 = false\n', 'http2 = false\nworkers = 2\n');
      assert.match(pooled, /workers = 2/);
      await writeFile(toml, pooled);
      log = '';
      await startLauncher();
      await waitFor('both standalone workers ready', async () =>
        (await (await fetch(`${STANDALONE_BASE}/_gio/health`)).json()).workers.ready === 2, 30_000);
      const pages = await Promise.all(
        Array.from({ length: 4 }, async () => (await fetch(`${STANDALONE_BASE}/posts/7`)).text()),
      );
      for (const html of pages) assert.match(html, /STANDALONE_POST id=\[7\]/);
      assert.doesNotMatch(log, /client bundles built|client build reused/, 'nothing builds at boot');
      const tree = process.platform === 'win32' ? [] : descendantPids(run.pid);
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(run.pid), '/T', '/F']);
      } else {
        run.kill('SIGTERM');
      }
      await waitFor('launcher exit', () => Promise.resolve(runGone), 15_000);
      await waitFor('every standalone worker reaped', () => Promise.resolve(!tree.some(processRunning)), 10_000);
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

/** The policy the CSP phase adds to its fixture copy's gio.toml. */
const CSP_TOML = `
[security]
csp = """
  default-src 'self'; script-src 'self' 'nonce-{nonce}' 'strict-dynamic';
  style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'
"""
# Forced HSTS (TLS terminated by a proxy) and an opt-in extra header.
hsts = { max_age = 600 }

[security.headers]
permissions-policy = "camera=()"
`;

/** Content types the CSP phase's echo route answers in (`?type=`). */
const CSP_ECHO_TYPES = [
  'text/javascript',
  'text/css',
  'application/xml',
  'text/csv',
  'image/svg+xml',
  'application/octet-stream',
];

/**
 * Phase 1c (CSP nonces): a fixture copy whose gio.toml turns on a nonce
 * Content-Security-Policy, in its own server instances - per-response
 * nonces make every page response unique, while the main phase compares
 * bodies across requests. The copy also turns CSRF protection off, which
 * must leave the WebSocket origin check on. Runs: production (every serve
 * path: buffered miss, cache hit, PPR shell + holes, streaming, 404, route
 * handlers in any content type), a restart on the same disk cache, the
 * same app with CSP off on that cache, a new deployment on that cache
 * (placeholder rotated), then dev (overlay and error page scripts).
 */
async function cspPhase() {
  const binary = findServerBinary();
  const cspDir = await copyFixtureForDev('.csp-fixture');
  const toml = await readFile(join(cspDir, 'gio.toml'), 'utf8');
  assert.ok(toml.includes('[security.csrf]\n'));
  const cspOffToml = toml.replace('[security.csrf]\n', '[security.csrf]\nenabled = false\n');
  const cspToml = cspOffToml + CSP_TOML;
  await writeFile(join(cspDir, 'gio.toml'), cspToml);
  await mkdir(join(cspDir, 'app', 'csp-boom'), { recursive: true });
  await writeFile(
    join(cspDir, 'app', 'csp-boom', 'page.tsx'),
    "export default function Boom() {\n  throw new Error('CSP_BOOM');\n}\n",
  );
  // cspNonce() echoed into non-HTML bodies, and a body the handler
  // compressed itself (which the server cannot search).
  const coreSrc = '../../../../../../packages/giojs-core/src';
  await mkdir(join(cspDir, 'app', 'api', 'csp-echo'), { recursive: true });
  await writeFile(
    join(cspDir, 'app', 'api', 'csp-echo', 'route.ts'),
    `import { cspNonce } from '${coreSrc}/csp.ts';
import type { GioRequest } from '${coreSrc}/context.ts';

export function GET(req: GioRequest): Response {
  const body = \`window.__cfg={nonce:\${JSON.stringify(cspNonce())}}\`;
  return new Response(body, { headers: { 'content-type': req.query['type'] ?? 'text/javascript' } });
}
`,
  );
  await mkdir(join(cspDir, 'app', 'api', 'csp-gzip'), { recursive: true });
  await writeFile(
    join(cspDir, 'app', 'api', 'csp-gzip', 'route.ts'),
    `import { gzipSync } from 'node:zlib';
import { cspNonce } from '${coreSrc}/csp.ts';

export function GET(): Response {
  return new Response(gzipSync(\`nonce=\${cspNonce()}\`), {
    headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
  });
}
`,
  );
  const sharedCache = await mkdtemp(join(tmpdir(), 'gio-int-csp-cache-'));
  const devCache = await mkdtemp(join(tmpdir(), 'gio-int-csp-devcache-'));
  /** The cache's one placeholder file (one per deployment, older ones removed). */
  const placeholderOf = async (cacheDir) => {
    const files = (await readdir(join(cacheDir, 'meta'))).filter((name) =>
      name.startsWith('csp-nonce-placeholder'),
    );
    assert.equal(files.length, 1, `one placeholder file, got ${files.join(', ')}`);
    assert.match(files[0], /^csp-nonce-placeholder-[0-9a-f]{16}$/);
    return (await readFile(join(cacheDir, 'meta', files[0]), 'utf8')).trim();
  };
  const bodies = [];
  const fetchHtml = async (path, init) => {
    const res = await fetch(`${BASE}${path}`, init);
    const html = await res.text();
    bodies.push(html);
    return { res, html };
  };
  let firstPlaceholder;
  let rotatedPlaceholder;
  let cspDeploymentId;
  const deploymentId = async () => (await (await fetch(`${BASE}/_gio/health`)).json()).deploymentId;

  const runs = [
    {
      label: 'production',
      appDir: cspDir,
      cacheDir: sharedCache,
      mode: 'production',
      async check(log) {
        firstPlaceholder = await placeholderOf(sharedCache);
        assert.match(firstPlaceholder, /^[0-9a-f]{32}$/);

        await test('CSP: buffered render and cache hit carry fresh nonces matching the header', async () => {
          const miss = await fetchHtml('/cached');
          assert.equal(miss.res.headers.get('x-gio-cache'), 'miss; stored');
          const missNonce = assertNoncedResponse(miss.res, miss.html, 'miss');
          const hit = await fetchHtml('/cached');
          assert.match(hit.res.headers.get('x-gio-cache') ?? '', /^hit/);
          // A shared cache would replay one nonce to every visitor: cached
          // pages stay out of CDNs (and get no ETag) while nonces are on.
          for (const [what, res] of [['miss', miss.res], ['hit', hit.res]]) {
            assert.equal(res.headers.get('cache-control'), 'private, no-cache', what);
            assert.equal(res.headers.get('etag'), null, what);
          }
          // Substituted before compression: the body went out gzipped.
          assert.equal(hit.res.headers.get('content-encoding'), 'gzip');
          const hitNonce = assertNoncedResponse(hit.res, hit.html, 'hit');
          assert.notEqual(hitNonce, missNonce, 'every response gets its own nonce');
          assert.match(hit.html, /__GIO_DEPLOYMENT_ID__/, 'the Rust-injected script is nonced too');
          assert.match(hit.res.headers.get('content-security-policy'), /default-src 'self'; script-src/);
        });

        await test('CSP: PPR shell hits and their streamed holes share one fresh nonce', async () => {
          const stored = await fetchHtml('/ppr', { headers: { cookie: 'who=csp1' } });
          assert.equal(stored.res.headers.get('x-gio-cache'), 'ppr; shell=stored');
          const storedNonce = assertNoncedResponse(stored.res, stored.html, 'ppr miss');
          await sleep(250);
          const nonces = new Set([storedNonce]);
          for (const who of ['csp2', 'csp3']) {
            const hit = await fetchHtml('/ppr', { headers: { cookie: `who=${who}` } });
            assert.equal(hit.res.headers.get('x-gio-cache'), 'ppr; shell=hit');
            assert.match(hit.html, new RegExp(`PPR_FIXTURE_HOLE who=${who}`));
            nonces.add(assertNoncedResponse(hit.res, hit.html, `ppr hit ${who}`));
          }
          assert.equal(nonces.size, 3);
        });

        await test('CSP: the script finishing a redirected PPR shell hit is nonced', async () => {
          const stored = await fetchHtml('/ppr-gate', { headers: { cookie: 'who=csp1' } });
          assert.equal(stored.res.headers.get('x-gio-cache'), 'ppr; shell=stored');
          await sleep(250);
          for (const cookie of [undefined, 'who=ghost']) {
            const hit = await fetchHtml('/ppr-gate', cookie ? { headers: { cookie } } : {});
            assert.equal(hit.res.headers.get('x-gio-cache'), 'ppr; shell=hit');
            assert.match(hit.html, /location\.(replace|reload)\(/);
            assertNoncedResponse(hit.res, hit.html, `ppr-gate ${cookie ?? 'anonymous'}`);
          }
        });

        await test('CSP: streamed and error pages are nonced as well', async () => {
          const streamed = await fetchHtml('/slow');
          assert.equal(streamed.res.headers.get('x-gio-cache'), 'bypass');
          assertNoncedResponse(streamed.res, streamed.html, 'streamed');
          const missing = await fetchHtml('/csp-missing-page');
          assert.equal(missing.res.status, 404);
          assertNoncedResponse(missing.res, missing.html, '404');
        });

        await test('CSP: forced HSTS and opt-in headers apply over plain HTTP', async () => {
          const res = await fetch(`${BASE}/robots.txt`);
          assert.equal(res.headers.get('strict-transport-security'), 'max-age=600');
          assert.equal(res.headers.get('permissions-policy'), 'camera=()');
          assert.ok(cspNonceOf(res.headers.get('content-security-policy')));
        });

        await test('CSP: route handlers echoing cspNonce() send the nonce in every content type', async () => {
          for (const type of CSP_ECHO_TYPES) {
            const res = await fetchHtml(`/api/csp-echo?type=${encodeURIComponent(type)}`);
            assert.equal(res.res.status, 200, type);
            const nonce = cspNonceOf(res.res.headers.get('content-security-policy'));
            assert.equal(res.html, `window.__cfg={nonce:${JSON.stringify(nonce)}}`, type);
            // The nonce is as long as the placeholder: a length still holds.
            const length = res.res.headers.get('content-length');
            if (length !== null) assert.equal(Number(length), res.html.length, type);
          }
        });

        await test('CSP: a dynamic body with its own Content-Encoding is refused, not leaked', async () => {
          for (let i = 0; i < 2; i += 1) {
            const res = await rawRequest('GET', '/api/csp-gzip');
            assert.equal(res.status, 500);
            assert.equal(res.headers['content-encoding'], undefined);
            bodies.push(res.body);
          }
          const refused = () => log().match(/refused a dynamic response that sets its own Content-Encoding/g) ?? [];
          await waitFor('Content-Encoding refusal logged', () => Promise.resolve(refused().length > 0), 5_000);
          assert.equal(refused().length, 1, 'logged once per path');
        });

        await test('CSRF off keeps the WebSocket origin check on', async () => {
          const res = await rawRequest(
            'POST',
            '/api/notes',
            { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
            JSON.stringify({ text: 'csrf-off' }),
          );
          assert.equal(res.status, 200, '[security.csrf] enabled = false');
          assert.equal(await upgradeStatus('/live', { Origin: 'https://evil.example' }), 403);
          assert.equal(await upgradeStatus('/live', { Origin: new URL(BASE).origin }), 101);
        });
      },
    },
    {
      label: 'restart',
      appDir: cspDir,
      cacheDir: sharedCache,
      mode: 'production',
      async check() {
        await test('CSP: the disk cache survives a restart and its pages still get nonces', async () => {
          assert.equal(await placeholderOf(sharedCache), firstPlaceholder, 'placeholder persisted');
          cspDeploymentId = await deploymentId();
          const hit = await fetchHtml('/cached');
          assert.match(hit.res.headers.get('x-gio-cache') ?? '', /^hit/);
          assertNoncedResponse(hit.res, hit.html, 'hit after restart');
          // A disk entry from before the restart: still never public.
          assert.equal(hit.res.headers.get('cache-control'), 'private, no-cache');
          assert.equal(hit.res.headers.get('etag'), null);
        });
      },
    },
    {
      label: 'CSP off',
      appDir: cspDir,
      // The same app (so the same build and deployment ID) without [security] csp.
      gioToml: cspOffToml,
      cacheDir: sharedCache,
      mode: 'production',
      async check() {
        await test('CSP: turning it off never serves pages cached with the placeholder', async () => {
          // Same build, same cache key: only the CSP setting differs.
          assert.equal(await deploymentId(), cspDeploymentId);
          const res = await fetchHtml('/cached');
          assert.equal(res.res.headers.get('x-gio-cache'), 'miss; stored');
          assert.equal(res.res.headers.get('content-security-policy'), null);
          assert.doesNotMatch(res.html, /nonce=/);
        });
      },
    },
    {
      label: 'new deployment',
      appDir: cspDir,
      gioToml: cspToml,
      cacheDir: sharedCache,
      mode: 'production',
      env: { GIO_DEPLOYMENT_ID: 'csp-rotated-deployment' },
      async check() {
        await test('CSP: a new deployment rotates the placeholder', async () => {
          assert.equal(await deploymentId(), 'csp-rotated-deployment');
          rotatedPlaceholder = await placeholderOf(sharedCache);
          assert.notEqual(rotatedPlaceholder, firstPlaceholder);
          const res = await fetchHtml('/cached');
          assert.equal(res.res.headers.get('x-gio-cache'), 'miss; stored');
          assertNoncedResponse(res.res, res.html, 'new deployment');
        });
      },
    },
    {
      label: 'development',
      appDir: cspDir,
      cacheDir: devCache,
      mode: 'development',
      async check() {
        await test('CSP (dev): the error overlay and dev error page scripts carry the nonce', async () => {
          const page = await fetchHtml('/');
          assertNoncedResponse(page.res, page.html, 'dev page');
          assert.match(page.html, /<script nonce="[^"]+" id="__gio_dev_overlay_script">/);
          const boom = await fetchHtml('/csp-boom');
          assert.equal(boom.res.status, 500);
          assert.match(boom.html, /__GIO_SSR_ERROR__=\{"message":"CSP_BOOM/);
          assertNoncedResponse(boom.res, boom.html, 'dev error page');
        });
        await test('CSP: the nonce placeholder never reaches a client', async () => {
          const placeholders = [firstPlaceholder, rotatedPlaceholder, await placeholderOf(devCache)];
          assert.ok(bodies.length > 10);
          for (const html of bodies) {
            for (const placeholder of placeholders) assert.ok(!html.includes(placeholder));
          }
        });
      },
    },
  ];

  for (const run of runs) {
    if (run.gioToml !== undefined) await writeFile(join(run.appDir, 'gio.toml'), run.gioToml);
    let log = '';
    const server = spawn(binary, [], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIO_APP_DIR: join(run.appDir, 'app'),
        GIO_CACHE_DIR: run.cacheDir,
        RUST_LOG: 'info',
        NODE_ENV: run.mode,
        ...run.env,
      },
    });
    server.stdout.on('data', (d) => { log += d.toString(); });
    server.stderr.on('data', (d) => { log += d.toString(); });
    let serverGone = false;
    const serverExited = new Promise((r) =>
      server.on('exit', () => { serverGone = true; r(); }),
    );
    try {
      await waitFor(`server health (CSP phase, ${run.label})`, async () => {
        const res = await fetch(`${BASE}/_gio/health`);
        return res.ok && (await res.json()).nodeReady === true;
      }, 30_000);
      await run.check(() => log);
    } catch (err) {
      console.error(`\nintegration (CSP phase, ${run.label}): FAILED`);
      console.error(err);
      console.error('\n── server log tail ──');
      console.error(significantLogTail(log));
      process.exitCode = 1;
    } finally {
      if (!serverGone) server.kill();
      await serverExited;
    }
    if (process.exitCode === 1) break;
  }
  for (const dir of [sharedCache, devCache, cspDir]) {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Phase 0 (no server): a gio.toml the server cannot honor stops it at
 * startup, naming the file, the line and the fix. A misspelled key used to
 * parse fine and be ignored - leaving a guarded path open, or a setting at
 * its default while the author believed it changed.
 */
async function strictConfigPhase() {
  const binary = findServerBinary();
  const projectDir = await mkdtemp(join(tmpdir(), 'gio-int-bad-config-'));
  // A port of its own: should the server wrongly start, it must not collide
  // with the fixture servers.
  const server = '[server]\nhost = "127.0.0.1"\nport = 39519\n\n';
  const guard = (line) => `[[guards]]\npath = "/admin/*rest"\n${line}\nredirect_to = "/login"\n`;
  try {
    await mkdir(join(projectDir, 'app'));
    const cases = [
      [
        'a guard with a misspelled key',
        server + guard('require_sesion = true'),
        /gio\.toml:7: unknown key `guards\[0\]\.require_sesion` - did you mean `guards\[0\]\.require_session`\?/,
      ],
      [
        'a guard with no requirement',
        server + guard(''),
        /invalid \[\[guards\]\] entry for "\/admin\/\*rest"/,
      ],
      [
        'a misspelled section',
        server + '[image]\nquality = 80\n',
        /gio\.toml:5: unknown key \[image\] - did you mean \[images\]\?/,
      ],
      [
        'a misspelled key',
        server + '[images]\nallowed_width = [640]\n',
        /gio\.toml:6: unknown key `images\.allowed_width` - did you mean `images\.allowed_widths`\?/,
      ],
      [
        'a cache backend that does not exist',
        server + '[cache.redis]\nenabled = true\nurl = "redis://localhost:6379"\n',
        /unknown key \[cache\.redis\] - \[cache\.redis\] is not available yet/,
      ],
    ];
    for (const [label, toml, expected] of cases) {
      await writeFile(join(projectDir, 'gio.toml'), toml);
      await test(`gio.toml with ${label} stops startup`, async () => {
        const run = spawnSync(binary, [], {
          cwd: projectDir,
          env: { ...process.env, GIO_APP_DIR: join(projectDir, 'app'), NODE_ENV: 'production' },
          encoding: 'utf8',
          timeout: 30_000,
        });
        assert.equal(run.status, 1, `exit status ${run.status} (signal ${run.signal}), stderr:\n${run.stderr}`);
        assert.match(run.stderr, /configuration error/);
        assert.match(run.stderr, expected);
        assert.ok(run.stderr.includes(join(projectDir, 'gio.toml')), `names the file:\n${run.stderr}`);
      });
      await test(`--check-config reports gio.toml with ${label} as JSON, exit 1`, async () => {
        const check = spawnSync(binary, ['--check-config'], {
          cwd: projectDir,
          env: { ...process.env, GIO_APP_DIR: join(projectDir, 'app'), NODE_ENV: 'production' },
          encoding: 'utf8',
          timeout: 30_000,
        });
        assert.equal(check.status, 1, `exit status ${check.status}, stderr:\n${check.stderr}`);
        const report = JSON.parse(check.stdout);
        assert.equal(report.ok, false);
        assert.match(report.errors[0], expected);
      });
    }
    await writeFile(join(projectDir, 'gio.toml'), server + '[cache]\ndisk_path = "public/_cache"\n');
    await test('a page cache directory inside public/ stops startup before it is created', async () => {
      const run = spawnSync(binary, [], {
        cwd: projectDir,
        env: { ...process.env, GIO_APP_DIR: join(projectDir, 'app'), NODE_ENV: 'production' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(run.status, 1, `exit status ${run.status} (signal ${run.signal}), stderr:\n${run.stderr}`);
      assert.match(
        run.stderr,
        /configuration error: \[cache\] disk_path: the page cache directory \S*public\/_cache is inside the public\/ directory/,
      );
      assert.equal(existsSync(join(projectDir, 'public', '_cache')), false, 'nothing was created');
      const check = spawnSync(binary, ['--check-config'], {
        cwd: projectDir,
        env: { ...process.env, GIO_APP_DIR: join(projectDir, 'app'), NODE_ENV: 'production' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(check.status, 1);
      assert.match(JSON.parse(check.stdout).errors[0], /^\[cache\] disk_path: .*inside the public\/ directory/);
      assert.equal(existsSync(join(projectDir, 'public', '_cache')), false, '--check-config creates nothing');
    });

    // Refusals that come after gio.toml parses: --check-config shares
    // startup's validation, so it must refuse exactly what startup refuses,
    // with the same message - and never echo a token.
    const secret = 's3cr3t-revalidate-token-0123456789abcdef';
    const refusals = [
      [
        'a CSRF trusted origin without a scheme',
        server + '[security.csrf]\ntrusted_origins = ["admin.example.com"]\n',
        {},
        /\[security\.csrf\] trusted_origins entry "admin\.example\.com" is not an origin/,
      ],
      [
        'a revalidation token that is too short',
        server + '[revalidate]\ntoken = "short"\n',
        {},
        /the revalidation token \(\[revalidate\] token\) is 5 bytes; at least 32 are required/,
      ],
      [
        'a GIO_REVALIDATE_TOKEN that is too short',
        server,
        { GIO_REVALIDATE_TOKEN: 'tiny' },
        /the revalidation token \(GIO_REVALIDATE_TOKEN\) is 4 bytes/,
      ],
      [
        'TLS without a certificate',
        server + '[server.tls]\nenabled = true\n',
        {},
        /TLS enabled but cert_path not set in gio\.toml/,
      ],
      [
        'a syntax error on a line holding a token',
        server + `[revalidate]\ntoken = "${secret}" extra\n`,
        {},
        /cannot parse \S*gio\.toml:6:52: expected newline/,
      ],
      // Refused before the worker is spawned (and bundling starts).
      [
        'a local [[fonts]] file that does not exist',
        server + '[[fonts]]\nfamily = "Missing"\nurl = "/public/fonts/missing.woff2"\n',
        {},
        /\[\[fonts\]\] Missing: \S*public\/fonts\/missing\.woff2 not found/,
      ],
      // An entry that matched nobody used to lock every scraper out (403).
      [
        'a malformed [metrics] ip_allowlist entry',
        server + '[metrics]\nip_allowlist = ["10.0.0.0/33"]\n',
        {},
        /invalid ip_allowlist entry "10\.0\.0\.0\/33"/,
      ],
    ];
    for (const [label, toml, extraEnv, expected] of refusals) {
      await writeFile(join(projectDir, 'gio.toml'), toml);
      const env = { ...process.env, GIO_APP_DIR: join(projectDir, 'app'), NODE_ENV: 'production', ...extraEnv };
      if (!extraEnv.GIO_REVALIDATE_TOKEN) delete env.GIO_REVALIDATE_TOKEN;
      await test(`${label}: startup and --check-config both refuse it`, async () => {
        const run = spawnSync(binary, [], { cwd: projectDir, env, encoding: 'utf8', timeout: 30_000 });
        assert.equal(run.status, 1, `exit status ${run.status} (signal ${run.signal}), stderr:\n${run.stderr}`);
        assert.match(run.stderr, /configuration error: /);
        assert.match(run.stderr, expected);
        const check = spawnSync(binary, ['--check-config'], { cwd: projectDir, env, encoding: 'utf8', timeout: 30_000 });
        assert.equal(check.status, 1, `--check-config said ok:\n${check.stdout}`);
        const report = JSON.parse(check.stdout);
        assert.equal(report.ok, false);
        assert.match(report.errors.join('\n'), expected);
        for (const output of [check.stdout, run.stderr]) {
          assert.ok(!output.includes(secret), `a token value leaked:\n${output}`);
        }
      });
    }
  } catch (err) {
    console.error(`\nintegration (strict gio.toml): FAILED\n${err?.stack ?? err}`);
    process.exitCode = 1;
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

/**
 * Phase 1e (gio.toml settings): the keys that used to be parsed but ignored
 * now take effect - PORT for a [server] table without a port, [compression],
 * [images] formats, [prefetch] budgets and [cache] disk_path - and a
 * top-level [x-...] table is left for other tools.
 */
async function configSettingsPhase() {
  const binary = findServerBinary();
  const appRoot = await copyFixtureForDev('.config-fixture');
  const tomlPath = join(appRoot, 'gio.toml');
  let toml = await readFile(tomlPath, 'utf8');
  assert.match(toml, /^port\s*=\s*39517$/m, 'fixture gio.toml sets the port');
  assert.match(toml, /^quality\s*=\s*70$/m, 'fixture gio.toml sets [images] quality');
  toml = toml
    .replace(/^port\s*=.*\n/m, '')
    .replace(/^quality\s*=\s*70$/m, 'quality        = 70\nformats        = ["webp"]');
  toml += [
    '',
    '[x-integration]',
    'note = "read by other tools, ignored by GioJS"',
    '',
    '[compression]',
    'enabled = false',
    '',
    '[prefetch]',
    'max_per_second = 1',
    '',
    '[cache]',
    'disk_path = ".gio/config-phase-pages"',
    '',
  ].join('\n');
  await writeFile(tomlPath, toml);

  const env = {
    ...process.env,
    GIO_APP_DIR: join(appRoot, 'app'),
    PORT: new URL(BASE).port,
    RUST_LOG: 'info',
    NODE_ENV: 'production',
  };
  delete env.GIO_PORT;
  delete env.GIO_CACHE_DIR;

  let log = '';
  const server = spawn(binary, [], { cwd: repoRoot, env });
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  let serverGone = false;
  const serverExited = new Promise((r) =>
    server.on('exit', () => { serverGone = true; r(); }),
  );

  try {
    await waitFor('server health (gio.toml settings)', async () => {
      const res = await fetch(`${BASE}/_gio/health`);
      return res.ok && (await res.json()).nodeReady === true;
    }, 30_000);

    await test('PORT sets the listen port when gio.toml names none', async () => {
      const plain = log.replace(/\x1b\[[0-9;]*m/g, '');
      assert.match(plain, /GioJS listening on 127\.0\.0\.1:39517 .*port_from="PORT"/);
    });

    await test('[compression] enabled = false sends bodies uncompressed', async () => {
      const res = await rawGet('/', { 'accept-encoding': 'gzip, br' });
      assert.equal(res.status, 200);
      assert.ok(res.body.length > 1024, `a body worth compressing (${res.body.length} bytes)`);
      assert.equal(res.headers['content-encoding'], undefined);
      assert.doesNotMatch(res.headers.vary ?? '', /accept-encoding/i);
    });

    await test('[images] formats limits what /_gio/image negotiates', async () => {
      const accept = { accept: 'image/avif,image/webp,*/*' };
      for (const query of ['', '&f=avif']) {
        const res = await fetch(`${BASE}/_gio/image?src=/gio-test.png&w=96${query}`, { headers: accept });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/webp', `w=96${query}`);
        await res.arrayBuffer();
      }
    });

    await test('[prefetch] max_per_second bounds prefetches per client', async () => {
      // Three at once fall into at most two one-second windows.
      const statuses = await Promise.all([0, 1, 2].map(async () => {
        const res = await fetch(`${BASE}/gio-test.png`, { headers: { purpose: 'prefetch' } });
        await res.arrayBuffer();
        return res.status;
      }));
      assert.ok(statuses.includes(200), `${statuses}`);
      assert.ok(statuses.includes(429), `${statuses}`);
      const plain = await fetch(`${BASE}/gio-test.png`);
      assert.equal(plain.status, 200, 'requests that are not prefetches are not budgeted');
      await plain.arrayBuffer();
    });

    await test('[cache] disk_path chooses the page cache directory', async () => {
      const res = await fetch(`${BASE}/cached`);
      assert.match(res.headers.get('x-gio-cache') ?? '', /^miss; stored$/);
      await res.text();
      const dir = join(appRoot, '.gio', 'config-phase-pages');
      await waitFor('page persisted under [cache] disk_path', async () => {
        const files = await readdir(dir).catch(() => []);
        return files.some((f) => f.endsWith('.json'));
      }, 10_000);
    });
  } catch (err) {
    console.error('\nintegration (gio.toml settings): FAILED');
    console.error(err);
    console.error('\n── server log tail ──');
    console.error(significantLogTail(log));
    process.exitCode = 1;
  } finally {
    if (!serverGone) server.kill();
    await serverExited;
    await rm(appRoot, { recursive: true, force: true });
  }
}

/**
 * Phase 1g (feature switches): every gio.toml switch that turns a feature
 * off, and every limit lifted to 0, against the real server. Run 1 turns
 * features off ([prefetch], [images], [cache] enabled = false, [css]
 * minify = false, a font without preload, unlimited and ping-less
 * WebSockets, a short render timeout); run 2 lifts limits to 0 and turns
 * the cache's sub-features off. The defaults stay covered by the main
 * phase and by what each run leaves alone.
 */
async function featureSwitchesPhase() {
  const binary = findServerBinary();
  const appRoot = await copyFixtureForDev('.switches-fixture');
  await mkdir(join(appRoot, 'app', 'api', 'sleep'), { recursive: true });
  await writeFile(
    join(appRoot, 'app', 'api', 'sleep', 'route.ts'),
    [
      '// Answers after ?ms= milliseconds: renders slower than [server] render_timeout_secs.',
      'export async function GET(req: { query: Record<string, string> }): Promise<unknown> {',
      "  const ms = Number(req.query['ms']) || 0;",
      '  await new Promise((resolve) => setTimeout(resolve, ms));',
      '  return { slept: ms };',
      '}',
      '',
    ].join('\n'),
  );
  // Any bytes do: fonts are served as-is.
  await mkdir(join(appRoot, 'public', 'fonts'), { recursive: true });
  await writeFile(join(appRoot, 'public', 'fonts', 'preloaded.woff2'), 'wOF2-preloaded');
  await writeFile(join(appRoot, 'public', 'fonts', 'lazy.woff2'), 'wOF2-lazy');
  const tomlPath = join(appRoot, 'gio.toml');
  const fixtureToml = await readFile(tomlPath, 'utf8');
  assert.match(fixtureToml, /^http2 = false$/m, 'fixture gio.toml sets [server] http2');
  assert.match(fixtureToml, /^quality\s*=\s*70$/m, 'fixture gio.toml sets [images] quality');
  const tomlWith = ({ server, images, tail }) =>
    fixtureToml
      .replace(/^http2 = false$/m, `http2 = false\n${server.join('\n')}`)
      .replace(/^quality\s*=\s*70$/m, `quality = 70\n${images.join('\n')}`)
      + ['', ...tail, ''].join('\n');

  /** The stylesheets a page links, fetched. */
  const linkedStylesheets = async (html) => {
    const hrefs = [...html.matchAll(/href="(\/_next\/static\/css\/[^"]+\.css)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0, 'the page links its stylesheets');
    return Promise.all(hrefs.map(async (href) => (await fetch(`${BASE}${href}`)).text()));
  };
  const cacheFiles = async (dir) =>
    (await readdir(dir, { recursive: true }).catch(() => [])).filter((f) => f.endsWith('.json'));

  /** Start the fixture copy with `toml`, run `fn`, stop it. */
  async function run(label, toml, fn) {
    await writeFile(tomlPath, toml);
    const cacheDir = await mkdtemp(join(tmpdir(), 'gio-int-switches-'));
    const env = {
      ...process.env,
      GIO_APP_DIR: join(appRoot, 'app'),
      GIO_CACHE_DIR: cacheDir,
      RUST_LOG: 'info',
      NODE_ENV: 'production',
    };
    let log = '';
    const server = spawn(binary, [], { cwd: repoRoot, env });
    server.stdout.on('data', (d) => { log += d.toString(); });
    server.stderr.on('data', (d) => { log += d.toString(); });
    let serverGone = false;
    const serverExited = new Promise((r) =>
      server.on('exit', () => { serverGone = true; r(); }),
    );
    try {
      await waitFor(`server health (${label})`, async () => {
        const res = await fetch(`${BASE}/_gio/health`);
        return res.ok && (await res.json()).nodeReady === true;
      }, 30_000);
      await fn({ cacheDir, env, log: () => log.replace(/\x1b\[[0-9;]*m/g, '') });
    } catch (err) {
      console.error(`\nintegration (feature switches, ${label}): FAILED`);
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

  try {
    await run('switched off', tomlWith({
      server: ['render_timeout_secs = 2'],
      images: ['enabled = false'],
      tail: [
        '[prefetch]', 'enabled = false', '',
        '[cache]', 'enabled = false', '',
        '[css]', 'minify = false', '',
        '[websocket]', 'max_connections = 0', 'ping_interval_secs = 0', '',
        '[[fonts]]', 'family = "Preloaded"', 'url = "/fonts/preloaded.woff2"', '',
        '[[fonts]]', 'family = "Lazy"', 'url = "/fonts/lazy.woff2"', 'preload = false',
      ],
    }), async ({ cacheDir }) => {
      await test('[prefetch] enabled = false answers every prefetch 429, other requests as usual', async () => {
        for (const path of ['/gio-test.png', '/cached']) {
          const res = await fetch(`${BASE}${path}`, { headers: { purpose: 'prefetch' } });
          await res.arrayBuffer();
          assert.equal(res.status, 429, path);
        }
        const plain = await fetch(`${BASE}/gio-test.png`);
        await plain.arrayBuffer();
        assert.equal(plain.status, 200);
      });

      await test('[images] enabled = false: /_gio/image is a 404 and <GioImage> renders plain src', async () => {
        const res = await fetch(`${BASE}/_gio/image?src=/gio-test.png&w=96`);
        await res.arrayBuffer();
        assert.equal(res.status, 404);
        const html = await (await fetch(`${BASE}/image`)).text();
        assert.match(html, /IMAGE_FIXTURE/);
        assert.doesNotMatch(html, /\/_gio\/image/, 'no optimizer URL anywhere');
        assert.doesNotMatch(html, /srcSet=/i);
        assert.match(html, /<img [^>]*src="\/gio-test\.png"/);
        const envelope = JSON.parse(html.match(/<script id="__gio_props" type="application\/json">([^<]*)</)[1]);
        assert.equal(envelope.images.unoptimized, true, 'hydration renders the same plain src');
      });

      await test('[cache] enabled = false renders every request, Cache-Control still public', async () => {
        for (let i = 0; i < 2; i++) {
          const res = await fetch(`${BASE}/cached`);
          await res.text();
          assert.equal(res.status, 200);
          assert.equal(res.headers.get('x-gio-cache'), 'bypass', `request ${i + 1}`);
          assert.match(
            res.headers.get('cache-control') ?? '',
            /^public, max-age=0, s-maxage=\d+, stale-while-revalidate=\d+$/,
          );
        }
        await sleep(500);
        assert.deepEqual(await cacheFiles(cacheDir), [], 'nothing written to the page cache directory');
      });

      await test('[css] minify = false leaves the bundled stylesheets unminified', async () => {
        const html = await (await fetch(`${BASE}/styled`)).text();
        assert.match(html, /FIXTURE_STYLED_PAGE/);
        const sheets = await linkedStylesheets(html);
        assert.ok(
          sheets.some((css) => /\{\n {2}color: rebeccapurple;\n\}/.test(css)),
          `card.module.css as written: ${sheets.join('\n---\n').slice(0, 400)}`,
        );
      });

      await test('[[fonts]] preload = false drops that font\'s preload link only', async () => {
        const html = await (await fetch(`${BASE}/`)).text();
        const preloads = [...html.matchAll(/<link rel="preload" href="\/_gio\/fonts\/([^"]+)" as="font"/g)]
          .map((m) => m[1]);
        assert.equal(preloads.length, 1, `${preloads}`);
        assert.match(preloads[0], /^preloaded/i);
        assert.match(html, /<link rel="stylesheet" href="\/_gio\/fonts\/fonts\.css">/);
        const css = await (await fetch(`${BASE}/_gio/fonts/fonts.css`)).text();
        assert.match(css, /font-family: ?['"]?Lazy/, 'the lazy font keeps its @font-face');
      });

      await test('[websocket] max_connections = 0 and ping_interval_secs = 0 accept and keep sockets', async () => {
        // 0 used to close every socket with 1013, and a 0 ping interval
        // panicked the connection task before any message was relayed.
        const ws = new WebSocket('ws://127.0.0.1:39517/ws/rooms/switches');
        const messages = [];
        ws.addEventListener('message', (event) => messages.push(String(event.data)));
        const closed = new Promise((resolve) =>
          ws.addEventListener('close', (event) => resolve(event.code), { once: true }),
        );
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', () => reject(new Error('socket failed to open')), { once: true });
        });
        await waitFor('the room greeting', () => Promise.resolve(messages.length > 0), 5_000);
        assert.equal(JSON.parse(messages[0]).type, 'hello');
        ws.send('ping-less');
        await waitFor('the room broadcast', () =>
          Promise.resolve(messages.includes('switches:ping-less')), 5_000);
        ws.close();
        assert.equal(await closed, 1005);
      });

      await test('[server] render_timeout_secs bounds how long a render may take', async () => {
        const started = Date.now();
        const slow = await fetch(`${BASE}/api/sleep?ms=6000`);
        await slow.text();
        assert.equal(slow.status, 504);
        assert.ok(Date.now() - started < 5_000, `answered after ${Date.now() - started}ms`);
        const quick = await fetch(`${BASE}/api/sleep?ms=50`);
        assert.equal(quick.status, 200);
        assert.deepEqual(await quick.json(), { slept: 50 });
      });
    });
    if (process.exitCode === 1) return;

    await run('limits lifted', tomlWith({
      server: ['render_timeout_secs = 0', 'rate_limit_max_buckets = 0'],
      images: [
        'max_remote_bytes = 0', 'remote_timeout_secs = 0',
        'max_source_dimension = 0', 'max_decode_bytes = 0',
      ],
      tail: [
        '[prefetch]', 'max_concurrent = 0', 'max_per_second = 0', '',
        '[cache]', 'disk_enabled = false', 'etag = false', 'swr_multiplier = 0', '',
        '[[rate_limits]]', 'path = "/keyed-limit"', 'per_ip = 1', 'window_seconds = 3600',
        'burst = 0', 'key_header = "x-api-key"', 'max_keys_per_client = 0',
      ],
    }), async ({ cacheDir, env, log }) => {
      const expected = [
        '[server] render_timeout_secs = 0: ',
        '[server] rate_limit_max_buckets = 0: ',
        '[[rate_limits]] /keyed-limit: max_keys_per_client = 0 - ',
        '[images] max_remote_bytes = 0: ',
        '[images] remote_timeout_secs = 0: ',
        '[images] max_source_dimension = 0: ',
        '[images] max_decode_bytes = 0: ',
      ];

      await test('limits lifted to 0 are startup warnings and --check-config warnings', async () => {
        for (const line of expected) {
          assert.ok(
            log().split('\n').some((l) => l.includes('WARN') && l.includes(line)),
            `startup warns: ${line}`,
          );
        }
        const check = spawnSync(binary, ['--check-config'], {
          cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000,
        });
        assert.equal(check.status, 0, check.stderr);
        const report = JSON.parse(check.stdout);
        assert.equal(report.ok, true);
        for (const line of expected) {
          assert.ok(report.warnings.some((w) => w.startsWith(line)), `--check-config: ${line}`);
        }
      });

      await test('[prefetch] budgets of 0 are unlimited', async () => {
        const statuses = await Promise.all(Array.from({ length: 40 }, async () => {
          const res = await fetch(`${BASE}/gio-test.png`, { headers: { purpose: 'prefetch' } });
          await res.arrayBuffer();
          return res.status;
        }));
        assert.deepEqual([...new Set(statuses)], [200], `${statuses}`);
      });

      await test('[cache] disk_enabled = false keeps pages in memory only', async () => {
        const miss = await fetch(`${BASE}/cached`);
        await miss.text();
        assert.equal(miss.headers.get('x-gio-cache'), 'miss; stored');
        const hit = await fetch(`${BASE}/cached`);
        await hit.text();
        assert.match(hit.headers.get('x-gio-cache') ?? '', /^hit; ttl=\d+$/, 'memory still serves hits');
        await sleep(500);
        assert.deepEqual(await cacheFiles(cacheDir), [], 'no entry files');
      });

      await test('[cache] etag = false sends no page ETag and never a 304', async () => {
        const hit = await rawGet('/cached', { 'if-none-match': '*' });
        assert.match(hit.headers['x-gio-cache'] ?? '', /^hit; /);
        assert.equal(hit.status, 200);
        assert.equal(hit.headers.etag, undefined);
      });

      await test('[cache] swr_multiplier = 0 drops stale-while-revalidate', async () => {
        const hit = await fetch(`${BASE}/cached`);
        await hit.text();
        assert.match(hit.headers.get('cache-control') ?? '', /^public, max-age=0, s-maxage=\d+$/);
      });

      await test('[[rate_limits]] max_keys_per_client = 0 gives every key its own budget', async () => {
        // Past 64 keys from one client they used to share one bucket.
        const statuses = [];
        for (let i = 0; i < 70; i++) {
          const res = await rawGet('/keyed-limit', { 'x-api-key': `gateway-key-${i}` });
          statuses.push(res.status);
        }
        assert.deepEqual([...new Set(statuses)], [404], `${statuses}`);
        const again = await rawGet('/keyed-limit', { 'x-api-key': 'gateway-key-0' });
        assert.equal(again.status, 429, 'each key still has its own limit');
      });

      await test('the optimizer and stylesheets keep their defaults', async () => {
        const image = await fetch(`${BASE}/_gio/image?src=/gio-test.png&w=96`, { headers: { accept: 'image/webp' } });
        await image.arrayBuffer();
        assert.equal(image.status, 200, 'decoding without limits still works');
        const html = await (await fetch(`${BASE}/styled`)).text();
        const sheets = await linkedStylesheets(html);
        assert.ok(sheets.every((css) => !css.includes('\n  color:')), 'production CSS is minified by default');
      });

      await test('[server] render_timeout_secs = 0 serves renders as usual', async () => {
        const res = await fetch(`${BASE}/api/sleep?ms=1500`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { slept: 1500 });
      });
    });
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

/**
 * Phase 1f (gio CLI): the launcher and the binary together. `--check-config`
 * reports what the fixture's gio.toml, .env files and environment resolve to
 * without binding anything; `gio doctor` validates through it; `gio start`
 * passes --port through and prints the URL once /_gio/health reports the
 * real worker ready.
 */
async function cliPhase() {
  const binary = findServerBinary();
  const gio = join(repoRoot, 'packages', 'giojs', 'bin', 'gio.js');
  const cacheDir = await mkdtemp(join(tmpdir(), 'gio-int-cli-cache-'));
  await linkFixtureDeps();
  const env = {
    ...process.env,
    GIO_APP_DIR: join(fixtureDir, 'app'),
    GIO_CACHE_DIR: cacheDir,
    GIO_SERVER_BIN: binary,
  };
  delete env.NODE_ENV;
  let log = '';
  let launcher = null;
  let launcherExited = Promise.resolve();
  let port = null;
  try {
    await test('--check-config reports the fixture\'s resolved settings, never a secret', async () => {
      const check = spawnSync(binary, ['--check-config'], {
        cwd: repoRoot,
        env: { ...env, NODE_ENV: 'production' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(check.status, 0, check.stderr);
      const report = JSON.parse(check.stdout);
      assert.equal(report.ok, true);
      assert.equal(report.mode, 'production');
      assert.deepEqual(report.envFiles, ['.env.production', '.env']);
      assert.deepEqual(report.listen, { host: '127.0.0.1', port: 39517, portSource: 'gio.toml', tls: false });
      assert.equal(report.trustedProxies, 1);
      assert.equal(report.rateLimitRules > 0, true);
      assert.equal(report.sessionSecret, 'valid', 'GIO_SESSION_SECRET from .env.production');
      assert.equal(report.cacheDir, cacheDir);
      assert.doesNotMatch(check.stdout, new RegExp(FIXTURE_SESSION_SECRET));

      const overridden = spawnSync(binary, ['--check-config'], {
        cwd: repoRoot,
        env: { ...env, GIO_PORT: '39599' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.deepEqual(JSON.parse(overridden.stdout).listen,
        { host: '127.0.0.1', port: 39599, portSource: 'GIO_PORT', tls: false });
    });

    await test('gio doctor validates gio.toml with the server binary', async () => {
      const doctor = spawnSync(process.execPath, [gio, 'doctor', '--json'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const report = JSON.parse(doctor.stdout);
      const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
      assert.equal(byId.config.status, 'ok', JSON.stringify(byId.config));
      assert.match(byId.config.title, /gio\.toml is valid/);
      assert.equal(byId.binary.status, 'ok');
      assert.equal(byId.session.status, 'ok', 'guards plus a secret');
    });

    await test('gio start --port prints the URL once the worker is ready', async () => {
      port = await new Promise((resolve) => {
        const probe = createNetServer();
        probe.listen(0, '127.0.0.1', () => {
          const { port: free } = probe.address();
          probe.close(() => resolve(free));
        });
      });
      launcher = spawn(process.execPath, [gio, 'start', '--port', String(port)], { cwd: repoRoot, env });
      launcherExited = new Promise((resolve) => launcher.on('exit', resolve));
      launcher.stdout.on('data', (d) => { log += d.toString(); });
      launcher.stderr.on('data', (d) => { log += d.toString(); });
      await waitFor('the gio start banner', () => log.includes('- Local:'), 60_000);
      assert.match(log, new RegExp(`GioJS \\S+ \\(production\\)\\n  - Local: +http://localhost:${port}\\n`));
      // The fixture binds 127.0.0.1: nothing to show other devices.
      assert.match(log, /- Network: +not exposed/);
      const health = await (await fetch(`http://127.0.0.1:${port}/_gio/health`)).json();
      assert.equal(health.nodeReady, true);
      assert.match(log, new RegExp(`GioJS listening on 127\\.0\\.0\\.1:${port}`));
    });
  } catch (err) {
    console.error(`\nintegration (gio CLI): FAILED\n${err?.stack ?? err}`);
    console.error('\n── launcher log tail ──');
    console.error(significantLogTail(log));
    process.exitCode = 1;
  } finally {
    // Windows: kill() is TerminateProcess; the server then reads EOF on
    // the stdin pipe the launcher held and shuts down on its own.
    if (launcher !== null && launcher.exitCode === null) launcher.kill('SIGTERM');
    await launcherExited;
    if (port !== null) {
      // Gone once its port refuses connections (Windows: not yet when the
      // launcher dies), so its files are closed before the cleanup.
      await waitFor('the gio start server to shut down', async () => {
        try {
          await fetch(`http://127.0.0.1:${port}/_gio/health`);
          return false;
        } catch {
          return true;
        }
      }, 30_000).catch(() => {});
    }
    await rm(cacheDir, { recursive: true, force: true });
  }
}

await strictConfigPhase();
if (process.exitCode !== 1) {
  await main();
}
if (process.exitCode !== 1) {
  await cspPhase();
}
if (process.exitCode !== 1) {
  await unsetNodeEnvPhase();
}
if (process.exitCode !== 1) {
  await inheritedModePhase();
}
if (process.exitCode !== 1) {
  await untrustedProxyPhase();
}
if (process.exitCode !== 1) {
  await opsPhase();
}
if (process.exitCode !== 1) {
  await workersPhase();
}
if (process.exitCode !== 1) {
  await imageConfigCachePhase();
}
if (process.exitCode !== 1) {
  await buildChangeCachePhase();
}
if (process.exitCode !== 1) {
  await configSettingsPhase();
}
if (process.exitCode !== 1) {
  await featureSwitchesPhase();
}
if (process.exitCode !== 1) {
  await cliPhase();
}
if (process.exitCode !== 1) {
  await testingKitPhase();
}
if (process.exitCode !== 1) {
  await devWatchPhase();
}
if (process.exitCode !== 1) {
  await devCacheDirPhase();
}
if (process.exitCode !== 1) {
  await standalonePhase();
}
console.log(`\nintegration: ${passed} passed${process.exitCode === 1 ? ', with FAILURES' : ''}`);
// Any stray handle (an orphaned worker holding a stdio pipe) must never keep
// the harness alive after the verdict is printed - CI burned 30 minutes on
// exactly that.
process.exit(process.exitCode ?? 0);
