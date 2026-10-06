import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Middleware</h1>
      <p className="page-subtitle">Declarative redirects, rewrites, response headers, and auth guards - executed in Rust before routing.</p>

      <p>
        GioJS middleware is a set of declarative rules, not request-time
        JavaScript. You describe redirects, rewrites, response headers, and
        cookie guards; they are compiled once at load time and evaluated in the
        Rust HTTP layer on every request - before routing, before the cache,
        and before any Node code runs. Because the rules execute inside the
        server itself rather than in a separate step, there is no request
        header that skips them (contrast with Next.js middleware, where the
        <code>x-middleware-subrequest</code> header could bypass authorization
        checks entirely - CVE-2025-29927). A request either satisfies the
        rules or never reaches your pages.
      </p>

      <p>Rules come from two places, and you can use either or both:</p>
      <ul>
        <li><strong>gio.toml</strong> - static rules in your server config</li>
        <li><strong>middleware.ts</strong> - a file at the project root (sibling of <code>app/</code>)</li>
      </ul>

      <h2>gio.toml rules</h2>
      <CodeBlock lang="toml" code={`[[redirects]]
from   = "/old-home"
to     = "/"
status = 301          # 301, 302, 307, or 308 - defaults to 302

[[redirects]]
from = "/blog/:slug"
to   = "/posts/:slug"

[[rewrites]]
from = "/docs/*rest"  # served under the requested URL
to   = "/guide/*rest"

[[headers]]
path = "/docs/*rest"
[headers.headers]
x-frame-options = "DENY"

[[guards]]
path           = "/admin/*rest"
require_cookie = "session"
redirect_to    = "/login"`} />

      <h2>middleware.ts</h2>
      <p>
        The same four rule kinds, typed. Export the result of{' '}
        <code>defineMiddleware</code> as the default export (guard fields are
        camelCase here):
      </p>
      <CodeBlock lang="ts" code={`// middleware.ts (project root, next to app/)
import { defineMiddleware } from '@gio.js/core';

export default defineMiddleware({
  redirects: [
    { from: '/blog/:slug', to: '/posts/:slug', status: 301 },
  ],
  rewrites: [
    { from: '/docs/*rest', to: '/guide/*rest' },
  ],
  headers: [
    { path: '/admin/*rest', headers: { 'x-frame-options': 'DENY' } },
  ],
  guards: [
    { path: '/admin/*rest', requireCookie: 'session', redirectTo: '/login' },
  ],
});`} />
      <p>
        These rules travel to the Rust server inside the worker&apos;s READY
        frame and refresh whenever the worker restarts. In development the
        watcher restarts the worker on source changes anywhere in the project,
        including <code>middleware.ts</code>, <code>gio.toml</code>, and{' '}
        <code>gio.config.*</code>, so middleware edits are picked up with the
        next restart. <code>gio.toml</code> rules are compiled once at server
        startup.
      </p>

      <h2>Pattern language</h2>
      <p>
        Patterns use the routing conventions and must start with <code>/</code>:
      </p>
      <ul>
        <li><strong>Literal segments</strong> - <code>/about</code> matches exactly <code>/about</code></li>
        <li><strong><code>:param</code></strong> - captures one segment: <code>/posts/:id</code> matches <code>/posts/42</code> but not <code>/posts</code> or <code>/posts/a/b</code></li>
        <li><strong><code>*rest</code></strong> - captures the entire remainder, slashes included, and may be empty: <code>/docs/*rest</code> matches <code>/docs/a/b/c</code> and <code>/docs</code> itself. It must be the last segment. A guard on <code>/admin/*rest</code> therefore also protects <code>/admin</code>, and one <code>/*rest</code> header rule covers the whole site, root included</li>
      </ul>
      <p>
        Captures substitute into <code>to</code> targets by name, in any order.
        An empty catch-all contributes no segment, so{' '}
        <code>/old/*rest</code> &rarr; <code>/new/*rest</code> sends{' '}
        <code>/old</code> to <code>/new</code>:
      </p>
      <CodeBlock lang="toml" code={`[[redirects]]
from = "/u/:user/p/:post"
to   = "/p/:post/by/:user"   # /u/alice/p/42 -> /p/42/by/alice`} />
      <p>
        Rules match the <strong>canonical</strong> request path - the same
        path the router resolves. Repeated slashes collapse, a trailing slash
        is ignored, and percent-escapes of unreserved characters (letters,
        digits, <code>-</code> <code>.</code> <code>_</code> <code>~</code>)
        are decoded, so <code>/admin/</code>, <code>//admin</code> and{' '}
        <code>/%61dmin</code> all meet a guard written for{' '}
        <code>/admin</code>. Your app sees those escapes decoded too, so a
        rule and the router can never disagree about which page a request
        reaches. A path containing a <code>.</code> or <code>..</code>{' '}
        segment (raw or escaped), or a <code>%</code> that does not start a
        valid escape (<code>/%zz</code>, <code>/a%</code>), is rejected with{' '}
        <code>400</code> before any rule or route runs.{' '}
        <code>[[rate_limits]]</code> use the same canonical form.
      </p>
      <p>
        Every rule is validated when it is loaded, never at request time: a
        relative pattern, a catch-all in the middle, a <code>to</code> target
        referencing an unknown capture, a disallowed redirect status, or an
        invalid header name/value causes that rule to be skipped with a
        warning in the server log.
      </p>

      <h2>Evaluation order</h2>
      <p>Per request, the short-circuiting phases run in a fixed order:</p>
      <ol>
        <li><strong>Guards</strong></li>
        <li><strong>Redirects</strong></li>
        <li><strong>Rewrites</strong></li>
      </ol>
      <p>
        Within each phase the first matching rule wins, and{' '}
        <code>gio.toml</code> rules are checked before{' '}
        <code>middleware.ts</code> rules. The phase order holds across both
        sources - a <code>middleware.ts</code> guard beats a{' '}
        <code>gio.toml</code> redirect on the same path.
      </p>
      <p>
        The original query string is preserved verbatim: redirects append it to
        the <code>Location</code> header, and rewrites keep it on the rewritten
        URI. A rewrite changes the path that routing and the cache key see, while
        the browser URL stays what the client requested.
      </p>

      <h2>Guards</h2>
      <p>
        A guard redirects (302) any request to a matching path that does not
        carry a non-empty cookie of the given name - the request never reaches
        Node. It is a presence check, not validation: use it to keep anonymous
        traffic out of authenticated sections cheaply, and verify the session
        itself in <code>getServerSideProps</code> or a route handler.
      </p>

      <h2>Header rules</h2>
      <p>
        Header rules stamp response headers and do not short-circuit: every
        header rule whose <code>path</code> matches contributes its headers.
        They match the path the client requested (before any rewrite), apply
        to redirect responses produced by redirect and guard rules as well -
        so security headers like <code>strict-transport-security</code> cover
        those too - and names/values are validated once at load time. A
        rule&apos;s value replaces the response&apos;s own value for that
        header, except <code>set-cookie</code>: a rule cookie is added next to
        the cookies the page or route handler set, never in place of them.
      </p>

      <h2>public/ files at the site root</h2>
      <p>
        A file in <code>public/</code> answers at its root URL as well as under{' '}
        <code>/public/*</code> - <code>public/members/report.pdf</code> is both{' '}
        <code>/members/report.pdf</code> and <code>/public/members/report.pdf</code>. Rules
        written for the <code>/public/...</code> URL follow the file to its root URL:
      </p>
      <ul>
        <li>
          <strong>Guards</strong> for the <code>/public/...</code> URL run after the requested
          URL&apos;s own rules let the request through, so a guard on{' '}
          <code>/public/members/*rest</code> also protects <code>/members/report.pdf</code>.
        </li>
        <li>
          <strong>Header rules</strong> for both URLs are stamped; when both set the same
          header, the rule for the requested URL wins.
        </li>
        <li>
          <strong><code>[[rate_limits]]</code></strong> for both URLs must admit the request,
          and a rule matching both is charged once.
        </li>
        <li>
          <strong>Redirects and rewrites</strong> match only the URL requested, so a{' '}
          <code>/public/*rest</code> &rarr; <code>/*rest</code> redirect that moves old links
          to the root does not loop.
        </li>
      </ul>

      <div className="callout">
        GioJS&apos;s own <code>/_gio</code> endpoints (health, metrics, image
        optimization, fonts, and devtools in development) are exempt from all
        middleware rules. Every other <code>/_gio/...</code> path answers{' '}
        <code>404</code> from Rust and never reaches your pages, so a
        top-level dynamic segment like <code>app/[org]/</code> can never be
        rendered with <code>org = &quot;_gio&quot;</code> behind your
        rules&apos; back.
      </div>
    </>
  );
}
