import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Middleware',
  description:
    'Declarative redirects, rewrites, response headers, and auth guards - executed in Rust ' +
    'before routing.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Middleware</h1>
      <p className="page-subtitle">Declarative redirects, rewrites, response headers, and auth guards - executed in Rust before routing.</p>

      <p>
        GioJS middleware is a set of declarative rules, not request-time
        JavaScript. You describe redirects, rewrites, response headers, and
        session or cookie guards; they are compiled once at load time and evaluated in the
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
      <p>
        For every way to redirect - rules, guards, page actions and{' '}
        <code>getServerSideProps</code> - and which status code to use, see{' '}
        <a href="/docs/guides/redirecting">Redirecting</a>.
      </p>

      <h2 id="giotoml-rules">gio.toml rules</h2>
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
path            = "/admin/*rest"
require_session = true      # a valid, unexpired session (see Authentication)
redirect_to     = "/login"`} />

      <h2 id="middlewarets">middleware.ts</h2>
      <p>
        The same four rule kinds, typed. Export the result of{' '}
        <a href="/docs/functions/define-middleware"><code>defineMiddleware</code></a> as the default export (guard fields are
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
    { path: '/admin/*rest', requireSession: true, redirectTo: '/login' },
  ],
});`} />
      <p>
        These rules travel to the Rust server inside the worker&apos;s READY
        frame and refresh whenever the worker restarts. In development the
        watcher restarts the worker on source changes anywhere in the project,
        including <a href="/docs/file-conventions/middleware"><code>middleware.ts</code></a>, <code>gio.toml</code>, and{' '}
        <code>gio.config.*</code>, so middleware edits are picked up with the
        next restart. <code>gio.toml</code> rules are compiled once at server
        startup.
      </p>

      <h2 id="pattern-language">Pattern language</h2>
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
        <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a> use the same canonical form.
      </p>
      <p>
        Every rule is validated when it is loaded, never at request time, and
        a rule that cannot be enforced as written is an error, not a warning:
        a skipped guard would leave its path open, and a skipped redirect or
        header rule would quietly serve what it was meant to change. That
        covers a relative pattern (<code>members/*rest</code>), a catch-all
        that is not the last segment (<code>/a/*rest/c</code>), a{' '}
        <code>to</code> target that is not a path or references an unknown
        capture, a disallowed redirect status, an invalid header name or
        value, a guard that names no requirement or whose{' '}
        <code>redirectTo</code> is not a path, and an unknown key (a
        misspelled <code>require_session</code>).
      </p>
      <ul>
        <li>
          <strong>gio.toml</strong> - the server refuses to start, naming the
          file, the line and the reason.
        </li>
        <li>
          <strong>middleware.ts</strong> - the worker refuses to boot, listing
          every problem with the rule&apos;s position (
          <code>guards[0] (&quot;members/*rest&quot;): path must start with &quot;/&quot;</code>).
          So does a <code>middleware.ts</code> that throws while it loads, or
          has no default export: its rules - guards included - are never
          dropped while the app serves. In production the server exits with
          the error (see{' '}
          <a href="/docs/cli/giojs-server#worker-boot-errors">worker boot errors</a>);
          in development it waits for the fix, and a file broken by a later
          edit makes the worker answer <code>503</code> until it is fixed.
        </li>
      </ul>

      <h2 id="evaluation-order">Evaluation order</h2>
      <p>Per request, the short-circuiting phases run in a fixed order:</p>
      <ol>
        <li><strong>Guards</strong></li>
        <li><strong>Redirects</strong></li>
        <li><strong>Rewrites</strong></li>
      </ol>
      <p>
        Guards are not first-match: every guard whose path matches is checked,
        and each must admit the request. The first one that refuses (in order,{' '}
        <code>gio.toml</code> guards before <code>middleware.ts</code> guards)
        decides the redirect, so a <code>/admin/*rest</code> session guard and
        a <code>/admin/billing</code> cookie guard both apply to{' '}
        <code>/admin/billing</code>. Among redirects, and among rewrites, the
        first matching rule wins, <code>gio.toml</code> rules first. The phase
        order holds across both sources - a <code>middleware.ts</code> guard
        beats a <code>gio.toml</code> redirect on the same path.
      </p>
      <p>
        The original query string is preserved verbatim: redirects and guard
        redirects append it to the <code>Location</code> header (
        <code>/admin?next=1</code> goes to <code>/login?next=1</code>), and
        rewrites keep it on the rewritten URI. Redirect and rewrite targets are
        paths starting with <code>/</code> - for an external URL, redirect from
        a route handler or <code>getServerSideProps</code>. A rewrite changes the path that routing and the cache key see, while
        the browser URL stays what the client requested.
      </p>

      <h2 id="guards">Guards</h2>
      <p>
        A guard redirects (302) any request to a matching path that lacks the
        credential it requires - the request never reaches Node. There are two
        kinds:
      </p>
      <ul>
        <li>
          <strong><code>require_session = true</code></strong>{' '}
          (<code>requireSession: true</code>) - the <code>gio_session</code> cookie
          must hold a session from <a href="/docs/functions/create-session-storage"><code>createSessionStorage</code></a> whose
          signature verifies with <code>GIO_SESSION_SECRET</code> (any rotated
          secret) and that has not expired. Rust checks both before routing;
          anything else is treated like a missing cookie. Add{' '}
          <code>require_cookie</code> to read a session stored under another
          cookie name. Without a valid secret the guard denies every request and
          the server logs why. See <a href="/docs/authentication">Authentication</a>.
        </li>
        <li>
          <strong><code>require_cookie = &quot;name&quot;</code></strong> alone - a
          presence check: any non-empty cookie of that name passes. It keeps
          anonymous traffic out cheaply but proves nothing, so validate the cookie
          itself in <a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a> or a route handler.
        </li>
      </ul>
      <p>
        A page a guard lets through is for that visitor only: even when GioJS
        caches it, it goes out as <code>Cache-Control: private, no-cache</code>{' '}
        without an ETag, so a CDN (which never runs the guard) cannot serve it to
        anyone else. See <a href="/docs/caching">Caching</a>.
      </p>

      <h2 id="header-rules">Header rules</h2>
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
      <p>
        Header rules also win over the default security headers
        (<code>x-frame-options</code>, <code>referrer-policy</code>, CSP, ...),
        and an empty value removes such a default for the rule&apos;s paths -{' '}
        <code>x-frame-options = &quot;&quot;</code> lets other sites frame{' '}
        <code>/embed/*rest</code>. See <a href="/docs/security">Security</a>.
      </p>

      <h2 id="public-files-at-the-site-root">public/ files at the site root</h2>
      <p>
        A file in <a href="/docs/file-conventions/public-folder"><code>public/</code></a> answers at its root URL as well as under{' '}
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
        <li>
          <strong>The image optimizer</strong> is held to the guards of both URLs: a
          local <code>/_gio/image</code> <code>src</code> that a guard covers gets{' '}
          <code>403</code> for visitors the guard turns away, and{' '}
          <code>Cache-Control: private, no-cache</code> for those it admits.
        </li>
      </ul>
      <p>
        An escaped slash or backslash (<code>%2F</code>, <code>%5C</code>) never names a
        file: under <code>/public/</code> it gets <code>400</code>, and at the root the
        request goes to your pages, so <code>/members%2Freport.pdf</code> cannot reach the
        file past the rules for <code>/members/*rest</code>.
      </p>

      <div className="callout">
        GioJS&apos;s own <code>/_gio</code> endpoints (health, metrics, image
        optimization, fonts, and devtools in development) are exempt from all
        middleware rules (the image optimizer still checks the guards of the
        public/ file it reads). Every other <code>/_gio/...</code> path answers{' '}
        <code>404</code> from Rust and never reaches your pages, so a
        top-level dynamic segment like <code>app/[org]/</code> can never be
        rendered with <code>org = &quot;_gio&quot;</code> behind your
        rules&apos; back.
      </div>
    </>
  );
}
