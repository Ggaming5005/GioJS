/**
 * tests/integration/testing-kit.test.ts
 *
 * `@gio.js/core/testing` under node:test + tsx - the setup the testing docs
 * describe - against packages/giojs-core/test-fixtures/testing-app:
 * renderPage and callRoute in-process, then createTestServer with the real
 * binary (GIO_SERVER_BIN). run.mjs runs this file and then checks that no
 * server or worker process outlived it.
 *
 *   GIO_SERVER_BIN=target/debug/giojs-server node --import tsx tests/integration/testing-kit.test.ts
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callRoute,
  createTestServer,
  renderPage,
  resetTestApp,
  type TestServer,
} from '../../packages/giojs-core/src/testing.ts';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const appDir = join(repoRoot, 'packages', 'giojs-core', 'test-fixtures', 'testing-app', 'app');

describe('in-process helpers', () => {
  after(() => resetTestApp());

  test('renderPage runs getServerSideProps with cookies and returns its props', async () => {
    const page = await renderPage('/greet?name=node', { appDir, cookies: { theme: 'dark' } });
    assert.equal(page.status, 200);
    assert.deepEqual(page.props, { name: 'node', theme: 'dark', plugin: 'on' });
    assert.equal(page.setCookies.length, 2);
  });

  test('renderPage resolves redirects and notFound()', async () => {
    assert.deepEqual((await renderPage('/old', { appDir })).redirect, {
      destination: '/greet?name=moved',
      permanent: true,
    });
    const missing = await renderPage('/posts/missing', { appDir });
    assert.equal(missing.status, 404);
    assert.match(missing.html, /TESTING_KIT_POST_404/);
  });

  test('callRoute sends JSON and reads every cookie', async () => {
    const res = await callRoute('/api/session', { appDir, method: 'POST', body: { user: 'node' } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, user: 'node' });
    assert.equal(res.setCookies.length, 2);
  });
});

describe('createTestServer', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer({ appDir });
  });

  after(async () => {
    await server.close();
  });

  test('serves the app on a free port with its worker ready', async () => {
    const health = (await (await fetch(`${server.url}/_gio/health`)).json()) as { nodeReady: boolean };
    assert.equal(health.nodeReady, true);
    const res = await fetch(`${server.url}/greet?name=srv`, { headers: { cookie: 'theme=dark' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /HELLO_<!-- -->srv/);
    assert.deepEqual(res.headers.getSetCookie(), ['visited=1; Path=/', 'last=greet; Path=/; HttpOnly']);
  });

  test('route handlers answer through Rust, CSRF checks included', async () => {
    const res = await fetch(`${server.url}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ via: 'rust' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { body: unknown }).body, { via: 'rust' });

    const crossSite = await fetch(`${server.url}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    });
    assert.equal(crossSite.status, 403);
  });

  test('a second server runs side by side', async () => {
    const second = await createTestServer({ appDir });
    try {
      assert.notEqual(second.port, server.port);
      assert.equal((await fetch(`${second.url}/posts/2`)).status, 200);
    } finally {
      await second.close();
    }
  });
});

describe('createTestServer with a broken app', () => {
  test('a middleware.ts that throws fails the server with its error, not a timeout', async () => {
    // Its rules - guards included - used to be dropped with a warning while
    // the server served everything.
    const root = await mkdtemp(join(tmpdir(), 'gio-broken-middleware-'));
    try {
      await mkdir(join(root, 'app'));
      await writeFile(join(root, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
      await writeFile(
        join(root, 'middleware.ts'),
        "export default { guards: [{ path: '/admin/*rest', requireSession: true, redirectTo: '/login' }] };\n" +
          "throw new Error('boom');\n",
      );
      await assert.rejects(createTestServer({ appDir: join(root, 'app'), timeoutMs: 60_000 }), (error: Error) => {
        assert.match(
          error.message,
          /^giojs-server exited before it was ready: the Node worker exited before it was ready \(exit status: 1\):\n {2}\S*middleware\.ts failed to load: boom\n/,
        );
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
