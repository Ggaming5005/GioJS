import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'createTestServer',
  description:
    'Start the real GioJS server for your app on a free port, with a private cache, for end-to-end tests of everything the Rust layer does.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>createTestServer</h1>
      <p className="page-subtitle">
        Start the real GioJS server for your app on a free port, with a private cache, for
        end-to-end tests of everything the Rust layer does.
      </p>
      <CodeBlock lang="ts" code={`import { createTestServer } from '@gio.js/core/testing';

const server = await createTestServer();
const res = await fetch(\`\${server.url}/posts/1\`);
await server.close();`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        { name: 'appDir', type: 'string', default: 'GIO_APP_DIR, else ./app', description: <>The <code>app/</code> directory; the server runs from its parent, the project root.</> },
        {
          name: 'env',
          type: 'Record<string, string | undefined>',
          default: '{}',
          description: (
            <>
              Extra environment for the server and its worker; <code>undefined</code> removes
              an inherited variable. <code>{"{ NODE_ENV: 'development' }"}</code> gives a
              development server.
            </>
          ),
        },
        { name: 'port', type: 'number', default: 'a free port', description: <>The port on <code>127.0.0.1</code>. With a fixed port there is no retry when it is taken.</> },
        {
          name: 'binary',
          type: 'string',
          default: 'GIO_SERVER_BIN, else @gio.js/server',
          description: (
            <>
              The <code>giojs-server</code> binary to run. Without it,{' '}
              <code>GIO_SERVER_BIN</code>, then the platform binary that{' '}
              <code>@gio.js/server</code> installed, then (inside the GioJS repository) a{' '}
              <code>target/debug</code> or <code>target/release</code> build.
            </>
          ),
        },
        { name: 'timeoutMs', type: 'number', default: '60000', description: <>How long to wait for the worker to be ready, in milliseconds.</> },
      ]} />
      <h3 id="returns">Returns</h3>
      <p>A <code>{'Promise<TestServer>'}</code>, resolved once the Node worker is ready:</p>
      <PropsTable kind="Field" rows={[
        { name: 'url', type: 'string', description: <>The base URL, <code>http://127.0.0.1:&lt;port&gt;</code>, without a trailing slash.</> },
        { name: 'port', type: 'number', description: <>The port it listens on.</> },
        { name: 'logs()', type: 'string', description: <>Everything the server and its worker printed so far (the last 1 MiB).</> },
        { name: 'close()', type: 'Promise<void>', description: <>Stops the server and every process it started; safe to call twice.</> },
      ]} />
      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The server reads your <code>gio.toml</code>, <code>middleware.ts</code>,{' '}
          <code>gio.config.ts</code> and <code>.env</code> files as in production; only the
          listen address is overridden, through <code>GIO_HOST</code> and{' '}
          <code>GIO_PORT</code>.
        </li>
        <li>
          Each server gets its own temporary page cache, image cache and IPC sockets, so
          several can run side by side, and the project&apos;s <code>.gio/cache</code> is never
          read or written. They are deleted on <code>close()</code>.
        </li>
        <li>
          It polls <code>/_gio/health</code> until the worker reports ready (a{' '}
          <code>404</code> there - <code>[health] enabled = false</code> - counts as ready,
          since the port opens only once the worker is up).
        </li>
        <li>
          Values the test kit loaded from <code>.env</code> files and the random session
          secret it may have set are not passed on: the server loads the files itself, by its
          own mode. Variables your test set are passed on.
        </li>
        <li>
          A running server never keeps the test process alive. When the process exits, or
          crashes, exit hooks kill the servers; when no hook can run (a{' '}
          <code>SIGKILL</code>, a vitest thread torn down), a small watchdog process does.
        </li>
      </ul>
      <h3 id="errors">Errors</h3>
      <ul>
        <li>
          No binary found: it throws, naming <code>npm install --save-dev @gio.js/server</code>{' '}
          and <code>GIO_SERVER_BIN</code>. A <code>binary</code> or{' '}
          <code>GIO_SERVER_BIN</code> path that does not exist throws too.
        </li>
        <li>The server exits before it is ready: it throws with the last 40 lines of its log.</li>
        <li>Not ready within <code>timeoutMs</code>: it stops the server and throws, with the log.</li>
        <li>The chosen free port was taken in the meantime: it retries on another port, up to three times.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="guards-csrf-and-headers">Guards, CSRF and headers (vitest)</h3>
      <p>
        For a project with a session guard on <code>/admin</code> and the{' '}
        <code>/api/notes</code> handler from{' '}
        <a href="/docs/functions/request-errors#accept-json-and-a-plain-form">Request body
        errors</a>:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[guards]]
path = "/admin/*rest"
require_session = true
redirect_to = "/login"`} />
      <CodeBlock lang="ts" title="tests/server.test.ts" code={`import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestServer, type TestServer } from '@gio.js/core/testing';

let server: TestServer;
beforeAll(async () => {
  server = await createTestServer({ env: { GIO_SESSION_SECRET: 'test-only-secret-at-least-32-bytes-long' } });
}, 60_000);   // the worker builds client bundles before it is ready
afterAll(() => server.close());

it('guards /admin in Rust', async () => {
  const res = await fetch(\`\${server.url}/admin\`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/login');
});

it('refuses a cross-site POST', async () => {
  const res = await fetch(\`\${server.url}/api/notes\`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{"text":"hi"}',
  });
  expect(res.status).toBe(403);
});

it('sends the default security headers', async () => {
  const res = await fetch(server.url);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});`} />
      <h3 id="the-page-cache-and-revalidation">The page cache and revalidation</h3>
      <p>
        With the cached <code>/posts/[id]</code> page and the <code>PUT</code> handler that
        calls <code>revalidateTag</code> from{' '}
        <a href="/docs/functions/revalidate-tag#tag-a-list-and-its-items">revalidateTag</a>:
      </p>
      <CodeBlock lang="ts" code={`it('purges a post on update', async () => {
  await fetch(\`\${server.url}/posts/1\`);                       // miss; stored
  const cached = await fetch(\`\${server.url}/posts/1\`);
  expect(cached.headers.get('x-gio-cache')).toMatch(/^hit/);

  await fetch(\`\${server.url}/api/posts/1\`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Changed' }),
  });
  const fresh = await fetch(\`\${server.url}/posts/1\`);
  expect(fresh.headers.get('x-gio-cache')).toMatch(/^miss/);
  expect(await fresh.text()).toContain('Changed');
});`} />
      <p>
        <code>fetch()</code> in Node sends neither <code>Origin</code> nor{' '}
        <code>Sec-Fetch-Site</code>, so its <code>POST</code>s pass the CSRF check like any
        client that is not a browser page. Set an <code>origin</code> header of another site
        to test the refusal, as in the first example.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Startup takes seconds</strong> - the worker builds the client bundles first.
          Start one server per test file in <code>beforeAll</code>, give that hook a longer
          timeout, and close it in <code>afterAll</code>.
        </li>
        <li>
          <strong>Production mode</strong> unless you pass <code>NODE_ENV=development</code> in{' '}
          <code>env</code>, so the server needs what production needs - for example a{' '}
          <code>GIO_SESSION_SECRET</code> when a session storage is created at import.
        </li>
        <li>
          <strong>Plain HTTP only.</strong> A <code>gio.toml</code> with{' '}
          <code>[server.tls]</code> enabled needs a test copy of the project without it.
        </li>
        <li>
          <strong>The binary</strong> comes from the <code>@gio.js/server</code> package
          (scaffolded apps have it), or from <code>GIO_SERVER_BIN</code> - useful in CI with a
          binary you built.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/testing#the-real-server-createtestserver">Testing: The real server</a></li>
        <li><a href="/docs/functions/render-page">renderPage</a> and <a href="/docs/functions/call-route">callRoute</a> - in-process, much faster</li>
        <li><a href="/docs/security#csrf">Security: CSRF protection</a></li>
        <li><a href="/docs/env-vars">Environment variables</a> - <code>GIO_SERVER_BIN</code>, <code>GIO_HOST</code>, <code>GIO_PORT</code></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
