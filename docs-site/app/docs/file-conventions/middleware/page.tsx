import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'middleware.ts',
  description:
    'Redirects, rewrites, response headers and auth guards declared in TypeScript at the project root, and enforced by the Rust server before routing.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>middleware.ts</h1>
      <p className="page-subtitle">
        Redirects, rewrites, response headers and auth guards declared in TypeScript at the
        project root, and enforced by the Rust server before routing.
      </p>
      <CodeBlock lang="ts" title="middleware.ts" code={`import { defineMiddleware } from '@gio.js/core';

export default defineMiddleware({
  redirects: [{ from: '/old-blog/*rest', to: '/blog/*rest', status: 308 }],
  rewrites: [{ from: '/docs/*rest', to: '/guide/*rest' }],
  headers: [{ path: '/api/*rest', headers: { 'x-api-version': '1' } }],
  guards: [{ path: '/account/*rest', requireSession: true, redirectTo: '/login' }],
});`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>middleware.ts</code> or <code>middleware.js</code> (<code>.ts</code> first) in
        the project root, next to <code>app/</code> - not inside it, and not in a{' '}
        <code>src/</code> folder. It is optional.
      </p>

      <h3 id="default-export">Default export</h3>
      <p>
        An object with up to four lists. <a href="/docs/functions/define-middleware"><code>defineMiddleware()</code></a>{' '}
        returns it unchanged and types it as <code>MiddlewareRules</code>.
      </p>
      <PropsTable kind="Key" rows={[
        { name: 'redirects', type: '{ from: string; to: string; status?: 301 | 302 | 307 | 308 }[]', description: <>Answer with a redirect. <code>status</code> defaults to <code>302</code>.</> },
        { name: 'rewrites', type: '{ from: string; to: string }[]', description: 'Serve another path while the browser URL stays the same.' },
        { name: 'headers', type: '{ path: string; headers: Record<string, string> }[]', description: 'Add or override response headers on matching paths.' },
        { name: 'guards', type: 'MiddlewareGuard[]', description: <>Redirect requests without a cookie (<code>requireCookie</code>) or without a valid session (<code>requireSession: true</code>, checking the <code>gio_session</code> cookie or the one <code>requireCookie</code> names) to <code>redirectTo</code>, a path on this site starting with one <code>/</code>, with a <code>302</code>.</> },
      ]} />
      <p>
        Patterns are the routing ones: literal segments, <code>:param</code> for one segment
        and <code>*rest</code> for the rest of the path (which may be empty), substituted into{' '}
        <code>to</code> by name. The <a href="/docs/middleware#pattern-language">pattern
        language</a> and each rule kind are explained in the Middleware guide.
      </p>

      <h3 id="how-it-runs">How it runs</h3>
      <ul>
        <li>
          <strong>Once, at worker startup.</strong> The worker imports the file and sends the
          rules to the Rust server, which compiles them next to the rules from{' '}
          <code>gio.toml</code>. No JavaScript runs per request: a request is redirected,
          rewritten or refused before it reaches Node, and no header the client sends can
          skip a rule.
        </li>
        <li>
          <strong>Order.</strong> Guards, then redirects, then rewrites, with{' '}
          <code>gio.toml</code> rules tried before <code>middleware.ts</code> rules within
          each phase. Every matching guard must admit the request (the first that refuses
          redirects); among redirects and among rewrites the first match wins. Header rules
          apply to the response, redirects and guard answers included.
        </li>
        <li>
          <strong>Reloads.</strong> The rules are read again whenever the worker restarts. In
          development, saving the file restarts it.
        </li>
        <li>
          <strong><code>/_gio/*</code></strong> (the server&apos;s own endpoints) is never
          matched.
        </li>
      </ul>

      <h3 id="validation">Validation</h3>
      <p>
        The file is strict, like <code>gio.toml</code>: a rule is never dropped while the app
        serves, because a dropped guard would leave its path open. The worker refuses to boot,
        with every problem listed, when:
      </p>
      <ul>
        <li>
          the file throws while it loads (an import that fails, a missing environment variable
          read at the top level), or has no default export;
        </li>
        <li>the default export is not an object, or has a key other than the four sections;</li>
        <li>
          an entry has an unknown key (with the closest valid one), a missing or malformed
          field, a pattern the server cannot match (no leading <code>/</code>, a{' '}
          <code>*rest</code> that is not the last segment), a <code>to</code> that is not a
          path on this site or uses a capture the pattern does not define, a status other
          than 301, 302, 307 or 308, or an invalid header name or value;
        </li>
        <li>
          a guard names no requirement (<code>requireSession: true</code> or a{' '}
          <code>requireCookie</code>), or its <code>redirectTo</code> is not a path on this
          site.
        </li>
      </ul>
      <p>
        A path on this site starts with one <code>/</code>: <code>//evil.example</code> and{' '}
        <code>/\evil.example</code> are refused, because a browser reads them as links to
        another site. Send visitors to another site from a route handler.
      </p>
      <CodeBlock lang="text" code={`/srv/shop/middleware.ts is invalid - no rule loads until every problem is fixed:
  - guards[0] ("members/*rest"): path must start with "/"
  - guards[1] ("/staff"): unknown key "require_session" - did you mean "requireSession"?
  - guards[1] ("/staff"): names no requirement: set requireSession: true or requireCookie`} />
      <p>
        In production the server then exits 1 with that error (see{' '}
        <a href="/docs/cli/giojs-server#worker-boot-errors">worker boot errors</a>). In
        development it waits for you to save a fix; a file broken by a later edit makes the
        worker answer <code>503</code> - the last rules it loaded stay in force - until the
        next save fixes it. A <code>requireSession</code> guard denies every request while{' '}
        <code>GIO_SESSION_SECRET</code> is missing or invalid, and the server logs why.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="rules-built-from-code">Rules built from code</h3>
      <p>
        The file is a module: it can import data and read the environment, as long as the
        result is plain rules. It is evaluated once per worker start.
      </p>
      <CodeBlock lang="ts" title="middleware.ts" code={`import { defineMiddleware } from '@gio.js/core';
import { MOVED_PAGES } from './lib/moved-pages';

export default defineMiddleware({
  redirects: MOVED_PAGES.map(({ from, to }) => ({ from, to, status: 301 })),
  headers: process.env.STAGING === '1'
    ? [{ path: '/*rest', headers: { 'x-robots-tag': 'noindex' } }]
    : [],
});`} />

      <h3 id="protect-a-members-area">Protect a members area</h3>
      <CodeBlock lang="ts" title="middleware.ts" code={`import { defineMiddleware } from '@gio.js/core';

export default defineMiddleware({
  guards: [
    // Verified in Rust with GIO_SESSION_SECRET: signature and expiry of the gio_session cookie.
    { path: '/members/*rest', requireSession: true, redirectTo: '/login' },
  ],
});`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          This is not Next.js middleware: there is no function that runs per request and no{' '}
          <code>NextResponse</code>. Logic that must look at each request in JavaScript
          belongs in <code>getServerSideProps</code>, a page action, a <code>route.ts</code>, or
          an <code>onRequest</code> plugin in <a href="/docs/file-conventions/gio-config">gio.config.ts</a>.
        </li>
        <li>
          Everything here can also be written in <code>gio.toml</code> (
          <code>[[redirects]]</code>, <code>[[rewrites]]</code>, <code>[[headers]]</code>,{' '}
          <code>[[guards]]</code>, with snake_case guard keys). Use <code>middleware.ts</code>{' '}
          when the rules come from code or should be type-checked.
        </li>
        <li>
          Like <code>gio.toml</code>, a rule that cannot be enforced stops the worker at boot
          instead of being skipped, guards included (see <a href="#validation">Validation</a>).
        </li>
        <li>
          Rules see the canonical path: repeated and trailing slashes collapsed, escapes of
          unreserved characters decoded.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/middleware">Middleware</a> - the guide.</li>
        <li><a href="/docs/functions/define-middleware"><code>defineMiddleware</code></a></li>
        <li><a href="/docs/configuration/redirects"><code>[[redirects]]</code></a>, <a href="/docs/configuration/rewrites"><code>[[rewrites]]</code></a>, <a href="/docs/configuration/headers"><code>[[headers]]</code></a>, <a href="/docs/configuration/guards"><code>[[guards]]</code></a></li>
        <li><a href="/docs/authentication">Authentication</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>A file that throws while loading, or any rule that cannot be enforced as written (an invalid pattern, a malformed field, an unknown key, a target a browser reads as another site), stops the worker at boot; such rules used to be dropped with a warning, a guard&apos;s path left open. <code>*rest</code> also matches zero segments. Header rules also apply to redirect and guard responses. <code>requireSession</code> guards verify the session in Rust.</> },
        { version: 'v0.1.0-beta.6', changes: <>Introduced: redirects, rewrites, headers and cookie guards from a project-root <code>middleware.ts</code>.</> },
      ]} />
    </>
  );
}
