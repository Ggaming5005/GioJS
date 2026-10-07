import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'renderPage',
  description:
    "Render a page in your test process through the worker's own pipeline, and inspect its status, HTML, props, cookies, redirect and cacheability.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>renderPage</h1>
      <p className="page-subtitle">
        Render a page in your test process through the worker&apos;s own pipeline, and inspect
        its status, HTML, props, cookies, redirect and cacheability.
      </p>
      <CodeBlock lang="ts" code={`import { renderPage } from '@gio.js/core/testing';

const page = await renderPage('/posts/1');`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>renderPage(path, options?)</code>. <code>path</code> is an absolute path, query
        string allowed (<code>/posts?page=2</code>).
      </p>
      <PropsTable kind="Option" rows={[
        { name: 'appDir', type: 'string', default: 'GIO_APP_DIR, else ./app', description: <>The <code>app/</code> directory, resolved from the working directory.</> },
        { name: 'method', type: "'GET' | 'HEAD'", default: "'GET'", description: <>Other methods throw - use <a href="/docs/functions/call-route">callRoute</a> to post to a page action.</> },
        { name: 'headers', type: 'Record<string, string>', description: <>Request headers; names are case-insensitive. <code>host</code> defaults to <code>localhost</code>.</> },
        { name: 'cookies', type: 'Record<string, string>', description: <>Sent as the <code>Cookie</code> header, after any <code>cookie</code> in <code>headers</code>. Values are sent as given.</> },
        { name: 'query', type: 'Record<string, string>', description: <>Merged over the query string in <code>path</code>.</> },
        {
          name: 'locale',
          type: 'string',
          default: "''",
          description: (
            <>
              The locale <code>[i18n]</code> detection would have picked. No detection runs:
              for <code>/fr/about</code>, pass <code>{"renderPage('/about', { locale: 'fr' })"}</code>.
            </>
          ),
        },
      ]} />

      <h3 id="returns">Returns</h3>
      <p>A <code>{'Promise<RenderPageResult>'}</code>:</p>
      <PropsTable kind="Field" rows={[
        { name: 'status', type: 'number', description: <>The status the worker answered with.</> },
        { name: 'headers', type: 'Record<string, string>', description: <>The worker&apos;s response headers, lowercase. The Rust server adds its own (security headers, <code>Cache-Control</code>, <code>X-Gio-Cache</code>) on top - those are not here.</> },
        { name: 'setCookies', type: 'string[]', description: <>Every <code>Set-Cookie</code> value, in order.</> },
        { name: 'html', type: 'string', description: <>The rendered document, with its hydration envelope and stylesheet links; <code>&apos;&apos;</code> for <code>HEAD</code>.</> },
        { name: 'props', type: 'Record<string, unknown> | null', description: <>The hydration props as serialized into the page. <code>null</code> for a redirect, a 404, an error, or props that are not JSON-serializable.</> },
        { name: 'cacheable', type: 'boolean', description: <>Whether the server would store the response in its shared page cache: <code>revalidate</code> set, no cookies sent, no credentials read.</> },
        { name: 'cacheMaxAge', type: 'number', description: <>Seconds it would be kept; <code>0</code> when not cacheable.</> },
        { name: 'cacheTags', type: 'string[]', description: <>The tags it would be stored under for <code>revalidateTag()</code>: <code>export const tags</code> plus the ones <code>getServerSideProps</code> returned, validated and de-duplicated. Empty when not cacheable.</> },
        { name: 'redirect', type: '{ destination: string; permanent: boolean } | undefined', description: <>Set for a 3xx answer; <code>permanent</code> for 301 and 308.</> },
        { name: 'error', type: '{ message: string; digest?: string; stack?: string } | undefined', description: <>Set when the render failed and no <code>error.tsx</code> answered (status 500). <code>message</code> is generic in production; <code>stack</code> is set in development only.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          On the first call per app directory it discovers your routes, layouts,{' '}
          <code>route.ts</code> handlers, <code>not-found</code> and <code>error</code> files,
          metadata routes and <code>gio.config.ts</code> plugins (running their{' '}
          <code>onStartup</code>), and loads the project&apos;s <code>.env</code> files - never
          over a variable already set. A route conflict fails the call like it fails the
          worker&apos;s boot.
        </li>
        <li>
          <code>getServerSideProps</code>, layouts, <code>notFound()</code>,{' '}
          <code>redirect()</code> and <code>error.tsx</code> files answer exactly as on the
          server. Nothing is cached between calls.
        </li>
        <li>
          Not applied, because the Rust server does them: <code>gio.toml</code> and{' '}
          <code>middleware.ts</code> rules and guards, CSRF checks, rate limits, security
          headers, the page cache, compression and locale detection. Test those with{' '}
          <a href="/docs/functions/create-test-server">createTestServer</a>.
        </li>
        <li>
          The test runs in production mode unless <code>NODE_ENV=development</code> (vitest
          sets <code>test</code>): error pages show only a digest, and the message is on the{' '}
          <code>ssr render failed</code> log line.
        </li>
        <li>
          With no <code>GIO_SESSION_SECRET</code> in the environment or a <code>.env</code>{' '}
          file, discovery sets a random one for the test process, so session modules load.
        </li>
      </ul>
      <h3 id="errors">Errors</h3>
      <ul>
        <li>A <code>method</code> other than <code>GET</code> or <code>HEAD</code>: <code>TypeError</code>.</li>
        <li>A page that answers with an event stream: <code>TypeError</code> - read it with <code>callRoute</code>.</li>
        <li>
          A path that does not start with <code>/</code>, or one the server would refuse with{' '}
          <code>400</code> before any page sees it (a <code>.</code> or <code>..</code>{' '}
          segment, a stray <code>%</code>): <code>TypeError</code>.
        </li>
        <li>An invalid cookie name, or a cookie value with <code>;</code>, CR or LF: <code>TypeError</code>.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="props-tags-and-cacheability">Props, tags and cacheability</h3>
      <CodeBlock lang="ts" title="tests/posts.test.ts" code={`import { expect, it } from 'vitest';
import { renderPage } from '@gio.js/core/testing';

it('renders a cached, tagged post', async () => {
  const page = await renderPage('/posts/1');
  expect(page.status).toBe(200);
  expect(page.props).toEqual({ post: { id: '1', title: 'Hello', slug: 'hello' } });
  expect(page.cacheable).toBe(true);
  expect(page.cacheMaxAge).toBe(60);
  expect(page.cacheTags).toEqual(['posts', 'post:1']);
});

it('404s an unknown post', async () => {
  const page = await renderPage('/posts/999');
  expect(page.status).toBe(404);
  expect(page.props).toBeNull();
});`} />
      <h3 id="a-redirect-and-a-cookie">A redirect and a cookie</h3>
      <CodeBlock lang="ts" code={`it('sends visitors without a session to /login', async () => {
  const page = await renderPage('/dashboard');
  expect(page.status).toBe(302);
  expect(page.redirect).toEqual({ destination: '/login?next=%2Fdashboard', permanent: false });
});

it('greets a returning visitor', async () => {
  const page = await renderPage('/welcome', { cookies: { seen: '1' } });
  expect(page.props).toEqual({ firstVisit: false });
  expect(page.cacheable).toBe(false);   // it read and set cookies
});`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Modules are imported once per process.</strong>{' '}
          <a href="/docs/functions/reset-test-app">resetTestApp</a> re-runs discovery for added
          or removed files, but an edit to an imported module shows up only in a new test
          process.
        </li>
        <li>
          <strong>Assert on <code>props</code></strong> rather than on HTML text: React
          separates adjacent text with <code>{'<!-- -->'}</code> in server HTML.
        </li>
        <li>
          <strong>CSS Modules</strong> render the server&apos;s class names under node:test; under
          vitest add <a href="/docs/functions/gio-vitest">gioVitest()</a>.
        </li>
        <li>
          <strong>Server-only.</strong> <code>@gio.js/core/testing</code> imports the
          server-only marker: a page or component that imports it has its client bundle
          refused.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/testing#pages-renderpage">Testing: Pages</a></li>
        <li><a href="/docs/functions/call-route">callRoute</a>, <a href="/docs/functions/create-test-server">createTestServer</a>, <a href="/docs/functions/reset-test-app">resetTestApp</a></li>
        <li><a href="/docs/page-exports/get-server-side-props">getServerSideProps</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
