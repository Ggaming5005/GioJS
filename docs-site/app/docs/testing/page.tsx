import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function TestingPage(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Testing</h1>
      <p className="page-subtitle">
        Test pages and route handlers with <code>@gio.js/core/testing</code> - in-process
        renders for fast unit tests, and the real Rust server for end-to-end checks. Works
        with vitest and node:test, from TypeScript test files.
      </p>

      <h2>Three helpers</h2>
      <table>
        <thead>
          <tr><th>Helper</th><th>What runs</th><th>Use it for</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>renderPage(path, options)</code></td>
            <td>The worker&apos;s own render pipeline, in your test process - no server</td>
            <td><code>getServerSideProps</code>, props, cookies, redirects, 404s, error pages, cacheability</td>
          </tr>
          <tr>
            <td><code>callRoute(path, options)</code></td>
            <td>Your <code>route.ts</code> handler, in your test process</td>
            <td>API handlers: JSON bodies, status codes, cookies, event streams</td>
          </tr>
          <tr>
            <td><code>createTestServer(options)</code></td>
            <td>The real <code>giojs-server</code> binary plus its Node worker, on a free port</td>
            <td>Everything Rust does: <code>gio.toml</code> and <code>middleware.ts</code> rules, guards, CSRF, security headers, the page cache, rate limits</td>
          </tr>
        </tbody>
      </table>
      <p>
        <code>renderPage</code> and <code>callRoute</code> discover your <code>app/</code>{' '}
        routes, layouts, <code>route.ts</code> handlers, <code>not-found</code> and{' '}
        <code>error</code> files and <code>gio.config.ts</code> plugins once per app
        directory, then answer exactly like the worker answers the server -{' '}
        <code>notFound()</code>, redirects and error pages included. What the Rust layer adds
        in front of the worker (rules, guards, CSRF, headers, caching, locale detection) is
        not applied; test that through <code>createTestServer</code>.
      </p>
      <p>
        Your project&apos;s <code>.env</code> files are loaded into the test process before
        anything of the app is imported, the way the server loads them for its worker: the
        same files and precedence, the <code>.env.development*</code> files only when{' '}
        <code>NODE_ENV=development</code> (vitest sets <code>NODE_ENV=test</code>, so{' '}
        <code>.env.production*</code> apply), and never over a variable that is already set.
        To give tests their own values, set them in the test environment (the shell, or
        vitest&apos;s <code>test.env</code>) - those win over every file. A{' '}
        <code>createTestServer</code> server reads the files itself, by its own mode: what{' '}
        <code>renderPage</code> loaded is not handed down to it, what your test set is.
      </p>

      <h2>Setup</h2>
      <p>
        <code>@gio.js/core</code> comes with <code>@gio.js/server</code>. With pnpm (no
        hoisting), add it - and <code>tsx</code> for node:test - as dev dependencies:{' '}
        <code>pnpm add -D @gio.js/core tsx</code>.
      </p>
      <h3>vitest</h3>
      <CodeBlock lang="bash" code={`npm install --save-dev vitest`} />
      <p>
        vitest does not read tsconfig <code>paths</code>, so mirror the scaffold&apos;s{' '}
        <code>@/*</code> alias:
      </p>
      <CodeBlock lang="ts" code={`// vitest.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'] },
});`} />
      <CodeBlock lang="json" code={`// package.json
"scripts": {
  "test": "vitest run"
}`} />
      <h3>node:test</h3>
      <p>
        No extra packages: node:test is built in and <code>tsx</code> runs the TypeScript
        (Node 20.6 or newer).
      </p>
      <CodeBlock lang="json" code={`// package.json
"scripts": {
  "test": "node --import tsx --test tests/*.test.ts"
}`} />
      <p>
        On Windows (no shell globbing) list the files, or use Node 21+&apos;s own glob
        support: <code>{`node --import tsx --test "tests/**/*.test.ts"`}</code>.
      </p>

      <h2>Pages: renderPage</h2>
      <CodeBlock lang="ts" code={`// tests/pages.test.ts (vitest)
import { describe, expect, it } from 'vitest';
import { renderPage } from '@gio.js/core/testing';

describe('/posts/[id]', () => {
  it('renders the post from getServerSideProps', async () => {
    const page = await renderPage('/posts/2');
    expect(page.status).toBe(200);
    expect(page.props).toMatchObject({ post: { id: '2' } });
    expect(page.html).toContain('<article');
  });

  it('sends visitors without a session to /login', async () => {
    const page = await renderPage('/dashboard');
    expect(page.redirect).toEqual({ destination: '/login', permanent: false });
  });

  it('greets a returning visitor', async () => {
    const page = await renderPage('/dashboard?tab=billing', {
      cookies: { theme: 'dark' },
      headers: { 'accept-language': 'de' },
    });
    expect(page.props?.theme).toBe('dark');
    expect(page.setCookies).toContain('seen=1; Path=/');
  });

  it('404s an unknown post', async () => {
    expect((await renderPage('/posts/does-not-exist')).status).toBe(404);
  });
});`} />
      <p>
        <strong>Options:</strong> <code>appDir</code> (default <code>GIO_APP_DIR</code>, else{' '}
        <code>./app</code>), <code>method</code> (<code>GET</code> or <code>HEAD</code>),{' '}
        <code>headers</code>, <code>cookies</code> (sent as the <code>Cookie</code> header),{' '}
        <code>query</code> (merged over the path&apos;s query string) and <code>locale</code>{' '}
        (what <code>[i18n]</code> detection would have picked).
      </p>
      <p>
        The path goes to the worker the way the server forwards it: never parsed as a URL (
        <code>//posts/2</code> routes like <code>/posts/2</code>, never as a host),
        percent-encoded like a client sends it, escapes normalized. A path the server answers
        with 400 before any page sees it - a <code>.</code> or <code>..</code> segment, a
        stray <code>%</code> - throws.
      </p>
      <div className="callout">
        <strong>Apps with <code>[i18n]</code>:</strong> no locale detection runs in-process.
        The server strips the locale prefix from the path and always forwards a locale (the
        detected one, else <code>default_locale</code>), so pass the unprefixed path plus the
        locale: <code>/fr/about</code> is{' '}
        <code>{`renderPage('/about', { locale: 'fr' })`}</code>, and a page that reads{' '}
        <code>ctx.locale</code> sees <code>&apos;&apos;</code> unless you pass one. Detection
        itself is tested through <code>createTestServer</code>.
      </div>
      <p><strong>Result:</strong></p>
      <ul>
        <li><code>status</code>, <code>headers</code> (the worker&apos;s, lowercase - Rust adds its own on top), and <code>setCookies</code> (every <code>Set-Cookie</code> value, intact).</li>
        <li><code>html</code> - the full document, rendered with the hydration envelope like a served page.</li>
        <li><code>props</code> - the hydration props exactly as serialized into the page; <code>null</code> for redirects, 404s, errors, or props that are not JSON-serializable (that page renders but never hydrates).</li>
        <li><code>redirect</code> - <code>{`{ destination, permanent }`}</code> for 3xx answers.</li>
        <li><code>cacheable</code> / <code>cacheMaxAge</code> - whether the Rust page cache would store this response, by the server&apos;s own rule: <code>revalidate</code> set, no cookies or per-request headers sent, and no credentials read (a page that reads <code>ctx.cookies</code> is never shared).</li>
        <li><code>error</code> - set when the render failed and no <code>error.tsx</code> answered: <code>message</code> (generic in production), <code>digest</code>, and <code>stack</code> in development.</li>
      </ul>
      <div className="callout">
        Tests run in production mode unless <code>NODE_ENV=development</code>: error pages
        show only a digest, like for real visitors. The message and stack are on the{' '}
        <code>ssr render failed</code> log line (stderr) under the same digest.
      </div>
      <p>
        React separates adjacent text with <code>{'<!-- -->'}</code> in server HTML (
        <code>{`Hello {name}`}</code> renders as <code>{'Hello <!-- -->Ada'}</code>), so prefer
        asserting on <code>props</code>, or match the HTML with a pattern.
      </p>

      <h2>Route handlers: callRoute</h2>
      <CodeBlock lang="ts" code={`import { expect, it } from 'vitest';
import { callRoute } from '@gio.js/core/testing';

it('logs in with a session cookie', async () => {
  const res = await callRoute('/api/login', {
    method: 'POST',
    body: { user: 'ada', password: 'secret' },   // sent as JSON
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.setCookies).toHaveLength(2);
  expect(res.setCookies[0]).toMatch(/^gio_session=/);
});

it('rejects a form post to a JSON endpoint', async () => {
  const res = await callRoute('/api/login', {
    method: 'POST',
    body: new URLSearchParams({ user: 'ada' }),
  });
  expect(res.status).toBe(415);
});`} />
      <p>
        <code>body</code> takes a string (sent as <code>text/plain</code>),{' '}
        <code>URLSearchParams</code> (a form), a <code>Uint8Array</code> (raw bytes), or any
        other value, sent as JSON with <code>Content-Type: application/json</code>. A{' '}
        <code>content-type</code> in <code>headers</code> always wins. The response reads
        like a fetch <code>Response</code>: <code>status</code>, <code>headers</code>,{' '}
        <code>setCookies</code>, and async <code>text()</code>, <code>json()</code> and{' '}
        <code>bytes()</code>. Handler failures answer like the server: <code>notFound()</code>{' '}
        is a JSON 404, a throw is a 500 with a digest, an unexported method a 405.
      </p>
      <h3>Event streams</h3>
      <p>
        A handler returning a <code>GioEventStream</code> answers with{' '}
        <code>res.stream</code>: the events exactly as a client receives them (
        <code>{'id: / event: / data: '}</code> frames). <code>text()</code> waits until the
        handler closes the stream; for a stream that stays open, read what you need and
        cancel - that runs the handler&apos;s cleanup, like a client disconnecting.
      </p>
      <CodeBlock lang="ts" code={`const res = await callRoute('/api/events');
const reader = res.stream!.getReader();
const { value } = await reader.read();
expect(new TextDecoder().decode(value)).toContain('data: {"n":1}');
await reader.cancel();   // runs the cleanup function the handler returned`} />

      <h2>The real server: createTestServer</h2>
      <CodeBlock lang="ts" code={`import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestServer, type TestServer } from '@gio.js/core/testing';

let server: TestServer;
beforeAll(async () => {
  server = await createTestServer();
}, 60_000);   // the worker builds client bundles before it is ready
afterAll(() => server.close());

it('guards /admin in Rust', async () => {
  const res = await fetch(\`\${server.url}/admin\`, { redirect: 'manual' });
  expect(res.status).toBe(302);
});

it('blocks cross-site posts', async () => {
  const res = await fetch(\`\${server.url}/api/notes\`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(403);
});`} />
      <p>
        <code>createTestServer</code> starts the <code>giojs-server</code> binary for your
        project on a free port on <code>127.0.0.1</code> and resolves once{' '}
        <code>/_gio/health</code> reports the Node worker ready. Each server gets a private
        page cache and IPC sockets (several can run side by side, and the project&apos;s{' '}
        <code>.gio/cache</code> is never read or filled). Your <code>gio.toml</code> is used
        as-is except for the listen address, which comes from <code>GIO_HOST</code> /{' '}
        <code>GIO_PORT</code>.
      </p>
      <ul>
        <li><strong>Options:</strong> <code>appDir</code>, <code>env</code> (extra variables for the server and worker; <code>undefined</code> removes one - <code>{`{ NODE_ENV: 'development' }`}</code> gives a dev server), <code>port</code>, <code>binary</code>, <code>timeoutMs</code> (default 60 s).</li>
        <li><strong>Result:</strong> <code>url</code> (no trailing slash), <code>port</code>, <code>logs()</code> (server and worker output so far), <code>close()</code>.</li>
        <li><strong>The binary</strong> is <code>GIO_SERVER_BIN</code> if set, else the platform binary <code>@gio.js/server</code> installed. Without one it throws, naming the package to install.</li>
        <li><strong><code>close()</code></strong> kills the server and its worker&apos;s whole process group (the worker runs in its own group). Call it in <code>afterAll</code> / <code>after</code>: it frees the port and the processes right away.</li>
        <li><strong>A forgotten <code>close()</code></strong> leaves nothing behind either. A running server never keeps the test process alive, so the run still ends, and exit hooks take the servers down with it - also on a crash or Ctrl+C. Where no hook gets to run - the test process killed with <code>SIGKILL</code>, a vitest worker thread (<code>pool: &apos;threads&apos;</code>) torn down - each server&apos;s small watchdog process kills it as soon as the process or thread that started it is gone.</li>
        <li>The server speaks plain HTTP; a <code>gio.toml</code> with <code>[server.tls]</code> enabled needs a test copy of the project without it.</li>
      </ul>

      <h2>node:test</h2>
      <CodeBlock lang="ts" code={`// tests/app.test.ts - node --import tsx --test tests/app.test.ts
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { callRoute, createTestServer, renderPage, type TestServer } from '@gio.js/core/testing';

test('home page renders', async () => {
  const page = await renderPage('/');
  assert.equal(page.status, 200);
});

test('notes API creates a note', async () => {
  const res = await callRoute('/api/notes', { method: 'POST', body: { title: 'hi' } });
  assert.equal(res.status, 201);
});

let server: TestServer;
before(async () => { server = await createTestServer(); });
after(() => server.close());

test('served through Rust', async () => {
  const res = await fetch(server.url);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});`} />

      <h2>Module caching</h2>
      <p>
        Page, layout and route modules are imported once per process, like in the worker.
        Discovery is cached per app directory too; <code>resetTestApp(appDir?)</code> drops
        it (and runs plugin <code>onShutdown</code> hooks), so the next render sees added or
        removed files. A change to a module that was already imported only shows up in a
        fresh process: vitest&apos;s watch mode and <code>node --test</code> start one per run
        (vitest also isolates each test file by default). Module-level state in your pages
        or helpers therefore lives for the whole file - reset it in your own{' '}
        <code>beforeEach</code>.
      </p>

      <h2>Keep it out of the browser</h2>
      <p>
        <code>@gio.js/core/testing</code> is server-only. Import it from test files only: a
        page or component that imports it has its client bundle rejected, naming the import
        chain, like any other <a href="/docs/configuration">server-only</a> import.
      </p>
    </>
  );
}
