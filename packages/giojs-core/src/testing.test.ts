/**
 * giojs-core/src/testing.test.ts
 *
 * The `@gio.js/core/testing` kit against test-fixtures/testing-app: pages
 * with getServerSideProps, cookies, redirects, notFound() and error files,
 * route handlers with JSON/form/binary bodies, multiple cookies and SSE, and
 * the real server via createTestServer when a giojs-server binary exists.
 */
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TEST_ENTRY_SCRIPT,
  callRoute,
  createTestServer,
  renderPage,
  resetTestApp,
  type TestServer,
} from '@gio.js/core/testing';
import { buildClientBundles, clientBuildErrorFor } from './client-build.ts';
import { logger } from './logger.ts';
import { discoverLayouts, discoverRoutes } from './router.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageDir));
const fixtureRoot = join(packageDir, 'test-fixtures', 'testing-app');
const appDir = join(fixtureRoot, 'app');

/** Write a throwaway project (react linked in, like an installed app); returns its root. */
async function writeProject(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  await mkdir(join(root, 'node_modules'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dep of ['react', 'react-dom']) {
    await symlink(join(packageDir, 'node_modules', dep), join(root, 'node_modules', dep), linkType);
  }
  return root;
}

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeAll(() => {
  // Failure paths (boom, handler errors) log by design.
  quiet = [
    vi.spyOn(logger, 'error').mockImplementation(() => undefined),
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined),
  ];
});
afterAll(async () => {
  for (const spy of quiet) spy.mockRestore();
  await resetTestApp();
});

describe('renderPage', () => {
  it('renders a page inside its layouts, with the hydration props', async () => {
    const page = await renderPage('/', { appDir });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.html).toContain('<html lang="en">');
    expect(page.html).toContain('TESTING_KIT_HOME');
    // Rendered like a served page: envelope + bootstrap module.
    expect(page.html).toContain(TEST_ENTRY_SCRIPT);
    expect(page.props).toEqual({ params: {}, searchParams: {} });
    expect(page.cacheable).toBe(false);
    expect(page.redirect).toBeUndefined();
    expect(page.error).toBeUndefined();
  });

  it('runs getServerSideProps with the query, cookies and plugins, and returns its cookies', async () => {
    const page = await renderPage('/greet?name=ada&x=1', {
      appDir,
      cookies: { theme: 'dark' },
      query: { x: '2' },
    });
    expect(page.status).toBe(200);
    expect(page.props).toEqual({ name: 'ada', theme: 'dark', plugin: 'on' });
    expect(page.html).toContain('HELLO_<!-- -->ada');
    expect(page.setCookies).toEqual(['visited=1; Path=/', 'last=greet; Path=/; HttpOnly']);
    expect(page.headers['x-greeting']).toBe('hello');
    expect(page.headers['set-cookie']).toBeUndefined();
  });

  it('merges cookies given as a header and as an object', async () => {
    const page = await renderPage('/greet', {
      appDir,
      headers: { Cookie: 'other=1' },
      cookies: { theme: 'sepia' },
    });
    expect(page.props?.['theme']).toBe('sepia');
  });

  it('reports cacheability the way the page cache decides it', async () => {
    const cached = await renderPage('/cached', { appDir });
    expect(cached.cacheable).toBe(true);
    expect(cached.cacheMaxAge).toBe(60);
    expect(cached.props).toEqual({ generated: 'static' });

    // revalidate, but the render read a cookie: personal, never shared.
    const personal = await renderPage('/personal', { appDir, cookies: { user: 'ada' } });
    expect(personal.props).toEqual({ user: 'ada' });
    expect(personal.cacheable).toBe(false);
    expect(personal.cacheMaxAge).toBe(0);

    // gSSP response headers make a page uncacheable too.
    expect((await renderPage('/greet', { appDir })).cacheable).toBe(false);
  });

  it('answers a getServerSideProps redirect with its status, location and cookies', async () => {
    const page = await renderPage('/old', { appDir });
    expect(page.status).toBe(301);
    expect(page.redirect).toEqual({ destination: '/greet?name=moved', permanent: true });
    expect(page.headers['location']).toBe('/greet?name=moved');
    expect(page.setCookies).toEqual(['moved=1; Path=/']);
    expect(page.props).toBeNull();
    expect(page.html).toBe('');
  });

  it('resolves notFound() and { notFound: true } to the nearest not-found file', async () => {
    const ok = await renderPage('/posts/7', { appDir });
    expect(ok.props).toEqual({ id: '7', title: 'Post 7' });

    for (const path of ['/posts/missing', '/posts/gone']) {
      const page = await renderPage(path, { appDir });
      expect(page.status).toBe(404);
      expect(page.html).toContain('TESTING_KIT_POST_404');
      expect(page.html).toContain('<html lang="en">');
      expect(page.props).toBeNull();
      expect(page.cacheable).toBe(false);
    }

    const unmatched = await renderPage('/no/such/page', { appDir });
    expect(unmatched.status).toBe(404);
    expect(unmatched.html).toContain('TESTING_KIT_404');
  });

  it('answers a failed render with the error file and a digest, never the message', async () => {
    const page = await renderPage('/boom', { appDir });
    expect(page.status).toBe(500);
    expect(page.html).toMatch(/TESTING_KIT_ERROR <!-- -->[0-9a-f]{12}/);
    expect(page.html).not.toContain('TESTING_KIT_SECRET_FAILURE');
    expect(page.props).toBeNull();
  });

  it('answers HEAD without a body', async () => {
    const page = await renderPage('/greet', { appDir, method: 'HEAD' });
    expect(page.status).toBe(200);
    expect(page.html).toBe('');
    expect(page.setCookies).toHaveLength(2);
  });

  it('rejects what a page request cannot be', async () => {
    await expect(
      renderPage('/', { appDir, method: 'POST' as 'GET' }),
    ).rejects.toThrow(/use callRoute/);
    await expect(renderPage('greet', { appDir })).rejects.toThrow(/absolute path/);
    await expect(
      renderPage('/greet', { appDir, cookies: { theme: 'dark; admin=1' } }),
    ).rejects.toThrow(/must not contain/);
    await expect(
      renderPage('/greet', { appDir, cookies: { 'bad name': 'x' } }),
    ).rejects.toThrow(/invalid cookie name/);
    await expect(renderPage('/api/events', { appDir })).rejects.toThrow(/event stream/);
  });

  it('defaults the app directory to GIO_APP_DIR', async () => {
    const previous = process.env.GIO_APP_DIR;
    process.env.GIO_APP_DIR = appDir;
    try {
      expect((await renderPage('/')).html).toContain('TESTING_KIT_HOME');
    } finally {
      if (previous === undefined) delete process.env.GIO_APP_DIR;
      else process.env.GIO_APP_DIR = previous;
    }
  });
});

describe('renderPage without error or not-found files', () => {
  let root: string;

  beforeAll(async () => {
    root = await writeProject('gio-testing-bare-', {
      'app/page.tsx': `import React from 'react';
export default function Home() { return React.createElement('p', null, 'BARE_HOME'); }
`,
      'app/boom/page.tsx': `import React from 'react';
export async function getServerSideProps() { throw new Error('BARE_SECRET'); }
export default function Boom() { return React.createElement('p', null, 'never'); }
`,
    });
  });

  afterAll(async () => {
    await resetTestApp(join(root, 'app'));
    await rm(root, { recursive: true, force: true });
  });

  it('answers with the server\'s built-in pages', async () => {
    const appDir = join(root, 'app');
    // No root layout: the document shell comes from the renderer.
    const home = await renderPage('/', { appDir });
    expect(home.html).toMatch(/^<!DOCTYPE html><html>/);
    expect(home.html).toContain('BARE_HOME');

    const missing = await renderPage('/nope', { appDir });
    expect(missing.status).toBe(404);
    expect(missing.html).toContain('Page not found');

    const boom = await renderPage('/boom', { appDir });
    expect(boom.status).toBe(500);
    expect(boom.error?.message).toBe('Internal Server Error');
    expect(boom.error?.digest).toMatch(/^[0-9a-f]{12}$/);
    expect(boom.html).toContain(`Error reference: <code>${boom.error?.digest}</code>`);
    expect(boom.html).not.toContain('BARE_SECRET');
  });

  it('caches discovery per app until resetTestApp', async () => {
    const appDir = join(root, 'app');
    expect((await renderPage('/late', { appDir })).status).toBe(404);
    await mkdir(join(appDir, 'late'));
    await writeFile(
      join(appDir, 'late', 'page.tsx'),
      `import React from 'react';
export default function Late() { return React.createElement('p', null, 'LATE_PAGE'); }
`,
    );
    // Discovered once: the new page is not seen yet.
    expect((await renderPage('/late', { appDir })).status).toBe(404);
    await resetTestApp(appDir);
    const late = await renderPage('/late', { appDir });
    expect(late.status).toBe(200);
    expect(late.html).toContain('LATE_PAGE');
  });
});

describe('callRoute', () => {
  it('sends an object as JSON and reads the JSON answer', async () => {
    const res = await callRoute('/api/echo?from=path', {
      appDir,
      method: 'post',
      body: { title: 'hello', tags: ['a'] },
      query: { page: '2' },
      cookies: { session: 'abc' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({
      method: 'POST',
      body: { title: 'hello', tags: ['a'] },
      query: { from: 'path', page: '2' },
      cookies: { session: 'abc' },
      contentType: 'application/json',
    });
    expect(res.stream).toBeNull();
  });

  it('keeps an explicit content-type, and answers 415 for a non-JSON body', async () => {
    const patched = await callRoute('/api/echo', {
      appDir,
      method: 'POST',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body: { title: null },
    });
    expect(await patched.json()).toMatchObject({ contentType: 'application/merge-patch+json' });

    const text = await callRoute('/api/echo', { appDir, method: 'POST', body: '{"a":1}' });
    expect(text.status).toBe(415);
  });

  it('returns every Set-Cookie value intact', async () => {
    const res = await callRoute('/api/session', { appDir, method: 'POST', body: { user: 'ada' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, user: 'ada' });
    expect(res.setCookies).toEqual([
      'session=user-ada; Path=/; HttpOnly; SameSite=Lax',
      // The Expires date carries a comma: never joined or split.
      'theme=dark; Expires=Wed, 21 Oct 2037 00:00:00 GMT; Path=/; SameSite=Lax',
    ]);
    expect(res.headers['set-cookie']).toBeUndefined();

    const out = await callRoute('/api/session', { appDir, method: 'DELETE' });
    expect(out.status).toBe(204);
    expect(await out.text()).toBe('');
  });

  it('reads text responses, form bodies and binary bodies', async () => {
    const text = await callRoute('/api/text?q=x', { appDir });
    expect(text.status).toBe(202);
    expect(text.headers['x-handler']).toBe('text');
    expect(text.headers['content-type']).toBe('text/plain;charset=UTF-8');
    expect(await text.text()).toBe('plain x');

    const form = await callRoute('/api/text', {
      appDir,
      method: 'POST',
      body: new URLSearchParams({ name: 'Ada Lovelace', role: 'admin' }),
    });
    expect(await form.json()).toEqual({
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      fields: { name: 'Ada Lovelace', role: 'admin' },
    });

    const binary = await callRoute('/api/binary', {
      appDir,
      method: 'PUT',
      body: new Uint8Array([0xff, 0x00, 0x41]),
    });
    expect(binary.headers['x-was-base64']).toBe('true');
    expect([...(await binary.bytes())]).toEqual([0x41, 0x00, 0xff]);

    const utf8 = await callRoute('/api/binary', { appDir, method: 'PUT', body: new TextEncoder().encode('ab') });
    expect(utf8.headers['x-was-base64']).toBe('false');
    expect(await utf8.text()).toBe('ba');
  });

  it('answers unknown methods, notFound() and handler failures like the server', async () => {
    const put = await callRoute('/api/echo', { appDir, method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers['allow']).toBe('GET, POST, HEAD');

    const missing = await callRoute('/api/missing', { appDir });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not Found' });

    const failed = await callRoute('/api/missing', { appDir, method: 'POST' });
    expect(failed.status).toBe(500);
    const body = await failed.json<{ error: string; digest: string }>();
    expect(body.error).toBe('Internal Server Error');
    expect(body.digest).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(body)).not.toContain('TESTING_KIT_HANDLER_FAILURE');
  });

  it('renders pages for GET and refuses other methods on them', async () => {
    const page = await callRoute('/posts/3', { appDir });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('POST_<!-- -->Post 3');
    expect((await callRoute('/posts/3', { appDir, method: 'POST' })).status).toBe(405);
  });

  it('exposes an event stream framed like the server sends it', async () => {
    const res = await callRoute('/api/events?count=2', { appDir });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.stream).not.toBeNull();
    expect(await res.text()).toBe(
      'id: 1\nevent: tick\ndata: {"n":1}\n\n' + 'id: 2\nevent: tick\ndata: {"n":2}\n\n',
    );
  });

  it('runs the stream cleanup when the reader goes away', async () => {
    const counter = (): number =>
      Number((globalThis as Record<string, unknown>)['__testingKitSseCleanups'] ?? 0);
    const before = counter();
    const res = await callRoute('/api/events?count=1&open', { appDir });
    const reader = res.stream!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: {"n":1}');
    expect(counter()).toBe(before);
    await reader.cancel();
    expect(counter()).toBe(before + 1);
  });
});

describe('server-only', () => {
  let root: string;

  beforeAll(async () => {
    root = await writeProject('gio-testing-client-', {
      'app/leak/page.tsx': `import React from 'react';
import { renderPage } from '@gio.js/core/testing';
export default function Leak() {
  return React.createElement('button', { onClick: () => void renderPage('/') }, 'LEAK');
}
`,
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the testing kit out of client bundles', async () => {
    const appDir = join(root, 'app');
    const manifest = await buildClientBundles({
      routes: await discoverRoutes(appDir),
      layouts: await discoverLayouts(appDir),
      projectRoot: root,
      dev: true,
      nodePaths: [join(packageDir, 'node_modules')],
    });
    expect(manifest.get('/leak')).toBeUndefined();
    expect(clientBuildErrorFor('/leak')).toContain('app/leak/page.tsx -> @gio.js/core/testing');
  }, 60_000);
});

/** A giojs-server binary to run against, if this checkout has one. */
function serverBinary(): string | undefined {
  if (process.env.GIO_SERVER_BIN) return process.env.GIO_SERVER_BIN;
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const profile of ['debug', 'release']) {
    const candidate = join(repoRoot, 'target', profile, `giojs-server${exe}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Linux: live processes running from `dir` (the worker's cwd is the project root). */
function processesIn(dir: string): number[] {
  if (process.platform !== 'linux') return [];
  const found: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readlinkSync(`/proc/${name}/cwd`) === dir) found.push(Number(name));
    } catch {
      // Gone, or not ours.
    }
  }
  return found;
}

describe('createTestServer', () => {
  it('explains a missing binary', async () => {
    await expect(
      createTestServer({ appDir, binary: join(tmpdir(), 'no-such-giojs-server') }),
    ).rejects.toThrow(/binary not found at .*no-such-giojs-server/);
  });

  const binary = serverBinary();
  describe.skipIf(binary === undefined)('against the real server', () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await createTestServer({ appDir, binary: binary!, env: { RUST_LOG: 'info' } });
    }, 90_000);

    afterAll(async () => {
      await server?.close();
    });

    it('serves pages and route handlers on 127.0.0.1', async () => {
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      const page = await fetch(`${server.url}/greet?name=srv`, { headers: { cookie: 'theme=dark' } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('HELLO_<!-- -->srv');
      expect(html).toContain('plugin=<!-- -->on');
      expect(page.headers.getSetCookie()).toEqual(['visited=1; Path=/', 'last=greet; Path=/; HttpOnly']);

      const api = await fetch(`${server.url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: 'srv' }),
      });
      expect(api.status).toBe(201);
      expect(api.headers.getSetCookie()).toHaveLength(2);
      expect(server.logs()).toContain('GioJS listening on 127.0.0.1:');
    });

    it('uses a private cache, so the project cache is never touched', async () => {
      const first = await fetch(`${server.url}/cached`);
      expect(first.headers.get('x-gio-cache')).toMatch(/^miss/);
      await first.text();
      const second = await fetch(`${server.url}/cached`);
      expect(second.headers.get('x-gio-cache')).toMatch(/^hit/);
      await second.text();
      expect(existsSync(join(fixtureRoot, '.gio', 'cache'))).toBe(false);
    });

    it('takes down the server and its worker on close', async () => {
      expect(processesIn(fixtureRoot).length).toBeGreaterThan(0);
      await server.close();
      await server.close();
      await expect(fetch(`${server.url}/_gio/health`)).rejects.toThrow();
      expect(processesIn(fixtureRoot)).toEqual([]);
    }, 30_000);
  });
});
