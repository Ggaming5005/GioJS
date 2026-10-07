import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[[guards]]',
  description:
    'Session and cookie gates checked in Rust before routing: a request without the credential is ' +
    'redirected and never reaches Node.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[[guards]]</h1>
      <p className="page-subtitle">
        Session and cookie gates checked in Rust before routing: a request without the credential
        is redirected and never reaches Node.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[guards]]
path = "/admin/*rest"
require_session = true
redirect_to = "/login"`} />
      <p>
        <a href="/docs/authentication#4-protect-pages-with-a-guard">Authentication</a> walks through
        sessions and guards together.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'path', type: 'string', required: true, description: <>The path pattern to protect: literal segments, <code>:param</code> and a final <code>*rest</code>. <code>/admin/*rest</code> also covers <code>/admin</code> itself.</> },
        { key: 'require_session', type: 'boolean', default: 'false', description: <>Require a valid, unexpired session from <a href="/docs/functions/create-session-storage"><code>createSessionStorage</code></a>: the cookie&apos;s signature must verify with <code>GIO_SESSION_SECRET</code> (any of its rotated secrets). Read from <code>gio_session</code>, or from the cookie <code>require_cookie</code> names.</> },
        { key: 'require_cookie', type: 'string', default: '""', description: <>Alone: require a non-empty cookie of this name - a presence check that proves nothing, so validate the cookie in the page too. With <code>require_session</code>: the name of the session cookie.</> },
        { key: 'redirect_to', type: 'string', required: true, description: <>Where a refused request is sent, a path starting with <code>/</code>.</> },
      ]} />
      <p>
        <code>requireSession</code>, <code>requireCookie</code> and <code>redirectTo</code> - the
        spellings <code>middleware.ts</code> uses - are accepted too.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Guards run first, before redirects and rewrites, on the canonical path. Every guard that
          matches must admit the request; the first one that does not answers{' '}
          <code>302</code> to its <code>redirect_to</code>, with the original query string appended.
        </li>
        <li>
          A page a guard admitted goes out <code>Cache-Control: private, no-cache</code> without an
          ETag, even from the page cache: a CDN never runs the guard.
        </li>
        <li>
          A guard also covers a <code>public/</code> file at both of its URLs, and the image
          optimizer refuses (<code>403</code>) to read a guarded file for a visitor the guard turns
          away.
        </li>
        <li>
          Without a valid <code>GIO_SESSION_SECRET</code>, a <code>require_session</code> guard
          refuses every request and the server logs an error saying how to generate a secret.
        </li>
        <li>Rust&apos;s own <code>/_gio</code> endpoints are not guarded.</li>
      </ul>

      <h3 id="errors">Errors</h3>
      <p>A guard that would leave its path open stops startup instead of being skipped:</p>
      <CodeBlock lang="text" code={`gio.toml:1: invalid [[guards]] entry for "/admin/*rest": names no requirement: set require_session = true or a non-empty require_cookie
gio.toml:1: invalid [[guards]] entry for "/admin/*rest": pattern must start with '/': login
gio.toml:5: invalid [[guards]] entry for "members/*rest": pattern must start with '/': members/*rest
gio.toml:9: invalid [[guards]] entry for "/a/*rest/c": catch-all segment must be the last segment: /a/*rest/c
gio.toml:3: unknown key \`guards[0].require_sesion\` - did you mean \`guards[0].require_session\`?`} />

      <h2 id="examples">Examples</h2>
      <h3 id="protect-an-admin-area">Protect an admin area</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[guards]]
path = "/admin/*rest"
require_session = true
redirect_to = "/login"`} />
      <p>
        <code>/admin/users?page=2</code> without a session goes to <code>/login?page=2</code>.
      </p>

      <h3 id="a-session-under-another-cookie-name">A session under another cookie name</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[guards]]
path = "/account/*rest"
require_session = true
require_cookie = "app_session"
redirect_to = "/sign-in"`} />

      <h3 id="keep-anonymous-traffic-out-cheaply">Keep anonymous traffic out cheaply</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[guards]]
path = "/beta/*rest"
require_cookie = "beta_invite"
redirect_to = "/waitlist"`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Do not guard the <code>redirect_to</code> page itself with the same guard: the browser would
          be sent in a loop.
        </li>
        <li>
          The guard checks the session&apos;s signature and expiry only; roles and permissions belong
          in <code>getServerSideProps</code> or the route handler.
        </li>
        <li>The rules are compiled once at startup; a new <code>GIO_SESSION_SECRET</code> needs a restart.</li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li><strong>Guards fail closed.</strong> A broken guard never leaves its path open: in gio.toml it stops startup, and from <code>middleware.ts</code> it denies every request.</li>
        <li>The refusal is always a <code>302</code>.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/authentication">Authentication</a></li>
        <li><a href="/docs/middleware#guards">Middleware: Guards</a></li>
        <li><a href="/docs/functions/create-session-storage"><code>createSessionStorage</code></a></li>
        <li><a href="/docs/configuration/redirects"><code>[[redirects]]</code></a> and <a href="/docs/configuration/headers"><code>[[headers]]</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Added <code>require_session</code>, verified in Rust. A guard with a misspelled key, no requirement or an invalid path stops startup instead of being skipped. <code>*rest</code> matches zero segments, and admitted pages are never shared by caches.</> },
        { version: 'v0.1.0-beta.6', changes: <>Introduced with <code>require_cookie</code>.</> },
      ]} />
    </>
  );
}
