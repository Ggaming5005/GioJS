import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'defineMiddleware',
  description:
    'Type the rules of middleware.ts - redirects, rewrites, response headers and guards that the Rust server runs before any Node code.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>defineMiddleware</h1>
      <p className="page-subtitle">
        Type the rules of <code>middleware.ts</code> - redirects, rewrites, response headers
        and guards that the Rust server runs before any Node code.
      </p>
      <CodeBlock lang="ts" title="middleware.ts" code={`import { defineMiddleware } from '@gio.js/core';

export default defineMiddleware({
  redirects: [{ from: '/blog/:slug', to: '/posts/:slug', status: 308 }],
});`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>defineMiddleware(rules)</code> returns <code>rules</code> unchanged: it exists
        for the <code>MiddlewareRules</code> type, so your editor checks the shape. The file
        is <code>middleware.ts</code> (or <code>middleware.js</code>) at the project root,
        next to <code>app/</code>, and the rules are its default export.
      </p>
      <PropsTable kind="Key" rows={[
        {
          name: 'redirects',
          type: '{ from, to, status? }[]',
          description: (
            <>
              Answer a matching path with a redirect to <code>to</code>.{' '}
              <code>status</code> is <code>301</code>, <code>302</code>, <code>307</code> or{' '}
              <code>308</code>; the server uses <code>302</code> when it is left out.
            </>
          ),
        },
        {
          name: 'rewrites',
          type: '{ from, to }[]',
          description: (
            <>
              Serve <code>to</code> for a matching path while the browser keeps the URL it
              asked for. Routing and the page cache see the rewritten path.
            </>
          ),
        },
        {
          name: 'headers',
          type: '{ path, headers: Record<string, string> }[]',
          description: (
            <>
              Set response headers on every response whose path matches. Every matching rule
              applies; an empty value removes a header, including a default security header.
            </>
          ),
        },
        {
          name: 'guards',
          type: 'MiddlewareGuard[]',
          description: (
            <>
              Redirect (<code>302</code>) a request without a credential to{' '}
              <code>redirectTo</code>. <code>{'{ path, requireSession: true, redirectTo }'}</code>{' '}
              verifies a <a href="/docs/functions/create-session-storage">session</a>{' '}
              cookie&apos;s signature and expiry; <code>{"{ path, requireCookie: 'name', redirectTo }"}</code>{' '}
              only checks that the cookie is present. With both, the session is read from the
              named cookie instead of <code>gio_session</code>.
            </>
          ),
        },
      ]} />
      <p>
        Patterns use the routing conventions: literal segments, <code>:param</code> for one
        segment and <code>*rest</code> for the rest of the path (possibly empty, so{' '}
        <code>/admin/*rest</code> covers <code>/admin</code> too). Captures fill the same
        names in <code>to</code>.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The worker loads the file at startup and sends the rules to the Rust server, which
          compiles them and runs them on every request after rate limiting and the CSRF
          check, before routing. No request reaches Node without passing them. The rules are reloaded each time the
          worker restarts - in development, on every source change.
        </li>
        <li>
          Per request: guards, then redirects, then rewrites; the first match wins within each
          phase, and <code>gio.toml</code> rules are checked before <code>middleware.ts</code>{' '}
          rules in every phase. Header rules are applied independently.
        </li>
        <li>
          The original query string is kept: appended to a redirect&apos;s or a guard&apos;s{' '}
          <code>Location</code>, and kept on a rewritten request.
        </li>
        <li>
          <code>/_gio/*</code> endpoints are never matched.
        </li>
      </ul>
      <h3 id="validation">Validation</h3>
      <ul>
        <li>
          A malformed redirect, rewrite or header rule is dropped with a warning in the log;
          the rest of the file still applies.
        </li>
        <li>
          A malformed guard fails closed: a guard with a <code>path</code> whose requirement
          is missing or wrong (<code>{"requireSession: 'true'"}</code>, an unknown key, a{' '}
          <code>redirectTo</code> that does not start with <code>/</code>) denies every request
          to that path - redirecting to its <code>redirectTo</code>, or <code>/</code> - until
          it is fixed.
        </li>
        <li>
          A default export that is not an object is ignored with a warning.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="all-four-rule-kinds">All four rule kinds</h3>
      <CodeBlock lang="ts" title="middleware.ts" code={`import { defineMiddleware } from '@gio.js/core';

export default defineMiddleware({
  redirects: [
    { from: '/blog/:slug', to: '/posts/:slug', status: 308 },
  ],
  rewrites: [
    { from: '/docs/*rest', to: '/api/docs/*rest' },
  ],
  headers: [
    { path: '/api/*rest', headers: { 'cache-control': 'no-store' } },
  ],
  guards: [
    { path: '/admin/*rest', requireSession: true, redirectTo: '/login' },
  ],
});`} />
      <p>Requests against this file:</p>
      <CodeBlock lang="text" code={`GET /blog/hello?ref=x   -> 308  Location: /posts/hello?ref=x
GET /admin/users?y=1    -> 302  Location: /login?y=1   (no valid session)
GET /api/posts/1        -> 200  Cache-Control: no-store`} />
      <h3 id="rules-built-from-code">Rules built from code</h3>
      <p>
        What only code can express is the reason to use <code>middleware.ts</code> over{' '}
        <code>gio.toml</code>:
      </p>
      <CodeBlock lang="ts" title="middleware.ts" code={`import { readFileSync } from 'node:fs';
import { defineMiddleware } from '@gio.js/core';

// { "/old-path": "/new-path", ... } exported from the CMS
const moved: Record<string, string> = JSON.parse(
  readFileSync(new URL('./data/moved-pages.json', import.meta.url), 'utf8'),
);

export default defineMiddleware({
  redirects: Object.entries(moved).map(([from, to]) => ({
    from,
    to,
    status: 301 as const,
  })),
});`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Declarative only.</strong> Unlike Next.js middleware, there is no function
          that runs per request: the rules are data that Rust evaluates. For per-request
          logic, use <code>getServerSideProps</code>, a route handler or a Node plugin.
        </li>
        <li>
          <strong>A file that fails to load is ignored.</strong> When importing{' '}
          <code>middleware.ts</code> throws, the worker logs{' '}
          <code>middleware file failed to load - rules ignored</code> and runs without its
          rules - its guards included. Keep guards for sensitive paths in{' '}
          <code>gio.toml</code>, which refuses to start on a bad guard.
        </li>
        <li>
          <strong>Guards do not pass the path on.</strong> The redirect keeps the query string
          but not the path that was asked for; read the path in the login page if you need a{' '}
          <code>?next=</code> target.
        </li>
        <li>
          <strong>Same rules, two homes.</strong> Everything here can also live in{' '}
          <code>gio.toml</code> as <code>[[redirects]]</code>, <code>[[rewrites]]</code>,{' '}
          <code>[[headers]]</code> and <code>[[guards]]</code> (snake_case keys there:{' '}
          <code>require_session</code>, <code>redirect_to</code>).
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/middleware">Middleware</a> - the pattern language, evaluation order, guards and header rules in depth</li>
        <li><a href="/docs/file-conventions/middleware">middleware.ts</a></li>
        <li><a href="/docs/configuration/redirects">[[redirects]]</a>, <a href="/docs/configuration/rewrites">[[rewrites]]</a>, <a href="/docs/configuration/headers">[[headers]]</a>, <a href="/docs/configuration/guards">[[guards]]</a></li>
        <li><a href="/docs/functions/define-config">defineConfig</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Guards gain <code>requireSession</code>, verified in Rust; a malformed guard
              denies its path instead of being dropped.
            </>
          ),
        },
        { version: 'v0.1.0-beta.6', changes: 'Introduced.' },
      ]} />
    </>
  );
}
