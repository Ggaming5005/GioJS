import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Authentication',
  description: 'Encrypted cookie sessions, session guards verified in Rust, and secure cookie helpers.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Authentication</h1>
      <p className="page-subtitle">Encrypted cookie sessions, session guards verified in Rust, and secure cookie helpers.</p>

      <p>
        GioJS ships the primitives a login needs, with secure defaults and no extra
        dependencies:
      </p>
      <ul>
        <li>
          <strong><code>createSessionStorage</code></strong> (from <code>@gio.js/core</code>) -
          sessions stored in an encrypted, signed cookie. No session database to run.
        </li>
        <li>
          <strong><code>require_session</code> guards</strong> - <code>[[guards]]</code> in{' '}
          <code>gio.toml</code> or <code>middleware.ts</code> that verify the session&apos;s
          signature and expiry in the Rust HTTP layer, before any Node code runs.
        </li>
        <li>
          <strong><code>serializeCookie</code>, <code>parseCookies</code>, <code>signValue</code>,{' '}
          <code>unsignValue</code></strong> - for every other cookie.
        </li>
      </ul>

      <p>
        For a working starting point, <code>npx create-giojs add auth</code> (or{' '}
        <code>--auth</code> when creating the app) adds a login page, logout, and a guarded{' '}
        <code>/dashboard</code> built from these pieces - see the{' '}
        <a href="/docs/guides/authentication-example">authentication example</a>.
      </p>

      <h2 id="1-set-a-session-secret">1. Set a session secret</h2>
      <p>
        Sessions are encrypted and signed with keys derived from{' '}
        <code>GIO_SESSION_SECRET</code>. Generate a secret of at least 32 bytes:
      </p>
      <CodeBlock lang="bash" code={`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`} />
      <p>
        Set it in the server&apos;s environment, or in a git-ignored{' '}
        <code>.env.production.local</code> (the server loads <code>.env</code> files at
        startup, and the worker inherits them). Never commit it.
      </p>
      <ul>
        <li>
          <strong>Production</strong> without a secret: <code>createSessionStorage()</code>{' '}
          throws with the command above, and every <code>require_session</code> guard denies
          all requests (fail closed) with an error in the server log. Called at module scope
          (as in <code>lib/session.server.ts</code>), the throw happens when a module imports
          it: each page and <code>route.ts</code> that does answers 500 with an error digest,
          and the log line under that digest names the file and the missing secret.
        </li>
        <li>
          <strong>Development</strong> without a secret: the server generates an ephemeral one
          and shares it with the worker, so logins work out of the box and survive worker
          restarts, but reset when the server restarts. A warning says so.
        </li>
        <li>
          <strong>Tests</strong> (<code>@gio.js/core/testing</code>, which runs in production
          mode under vitest&apos;s <code>NODE_ENV=test</code>): the kit sets a random secret
          for the test process when none is set - see{' '}
          <a href="/docs/testing#sessions">Testing</a>.
        </li>
      </ul>

      <h2 id="2-create-a-session-storage">2. Create a session storage</h2>
      <CodeBlock lang="ts" title="lib/session.server.ts" code={`import { createSessionStorage } from '@gio.js/core';

interface UserSession {
  userId: string;
  name: string;
}

export const sessions = createSessionStorage<UserSession>({
  // all optional:
  // cookieName: 'gio_session',
  // maxAge: 60 * 60 * 24 * 7,           // seconds; carried in the token and the cookie
  // cookie: { sameSite: 'strict' },     // serializeCookie options
});`} />
      <p>
        Name the module <code>*.server.ts</code>: it is then guaranteed never to reach a client
        bundle - a page that used it outside <code>getServerSideProps</code> would fail its
        client build instead of shipping your session code to the browser.
      </p>
      <p>
        Keys come from <code>GIO_SESSION_SECRET</code> unless you pass a{' '}
        <code>secrets</code> option. Leave that option unset for any storage a guard checks:{' '}
        <code>require_session</code> guards verify with <code>GIO_SESSION_SECRET</code> only
        (in development without one, the server&apos;s ephemeral secret), so sessions signed with other
        secrets are turned away on every request and the login loops back to{' '}
        <code>redirect_to</code>. Node logs a warning when a <code>secrets</code> option signs
        with a key <code>GIO_SESSION_SECRET</code> does not contain. To rotate, put several
        secrets in <code>GIO_SESSION_SECRET</code> (see Rotating secrets below).
      </p>

      <h2 id="3-log-in">3. Log in</h2>
      <p>
        <code>getSession</code> reads the request&apos;s session (an empty, new one when there is
        none), and <code>commitSession</code> encrypts it into a <code>Set-Cookie</code> value:
      </p>
      <CodeBlock lang="ts" title="app/api/login/route.ts" code={`import type { GioRequest } from '@gio.js/core';
import { sessions } from '../../../lib/session.server.ts';

export async function POST(req: GioRequest) {
  const form = new URLSearchParams(req.body ?? '');
  const user = await verifyPassword(form.get('email'), form.get('password'));
  if (!user) {
    return new Response(null, { status: 303, headers: { Location: '/login?error=1' } });
  }
  const session = sessions.getSession(req);
  session.set('userId', user.id);
  session.set('name', user.name);
  return new Response(null, {
    status: 303,
    headers: { Location: '/dashboard', 'Set-Cookie': sessions.commitSession(session) },
  });
}`} />
      <p>
        From <code>getServerSideProps</code>, return the cookie in{' '}
        <code>headers: {'{'} &apos;set-cookie&apos;: sessions.commitSession(session) {'}'}</code>.
        Every <code>commitSession</code> re-encrypts the data with a fresh expiry, so committing
        on each visit gives a rolling session.
      </p>

      <h2 id="4-protect-pages-with-a-guard">4. Protect pages with a guard</h2>
      <CodeBlock lang="toml" title="gio.toml" code={`[[guards]]
path            = "/dashboard/*rest"
require_session = true
redirect_to     = "/login"`} />
      <CodeBlock lang="ts" code={`// middleware.ts - the same rule
import { defineMiddleware } from '@gio.js/core';

export default defineMiddleware({
  guards: [{ path: '/dashboard/*rest', requireSession: true, redirectTo: '/login' }],
});`} />
      <p>
        The guard reads the <code>gio_session</code> cookie (set <code>require_cookie</code> /{' '}
        <code>requireCookie</code> when your storage uses another <code>cookieName</code>),
        checks its HMAC against every secret in <code>GIO_SESSION_SECRET</code> in constant
        time - never against a storage&apos;s <code>secrets</code> option - and checks its
        expiry. A missing, forged, tampered, or expired session gets a <code>302</code> to{' '}
        <code>redirect_to</code> and never reaches Node. Rust only verifies - it never decrypts,
        so the encryption key stays in the worker. A guard with <code>require_cookie</code>{' '}
        alone still only checks that the cookie exists; see{' '}
        <a href="/docs/middleware">Middleware</a> for patterns and evaluation order.
      </p>
      <p>
        A broken guard never leaves its path open: a <code>gio.toml</code> guard with a
        misspelled key or no requirement stops the server at startup, and a{' '}
        <code>middleware.ts</code> guard whose requirement is malformed denies every request to
        its path until fixed, with a warning saying why.
      </p>

      <h2 id="5-read-the-session">5. Read the session</h2>
      <CodeBlock lang="ts" title="app/dashboard/page.tsx" code={`import { sessions } from '../../lib/session.server.ts';

export async function getServerSideProps(ctx) {
  const session = sessions.getSession(ctx);
  return { props: { name: session.get('name') ?? 'guest' } };
}`} />
      <p>
        <code>getSession</code> accepts the <code>getServerSideProps</code> context, a{' '}
        <code>route.ts</code> <code>GioRequest</code>, a plugin&apos;s request, a web{' '}
        <code>Request</code>, or a raw <code>Cookie</code> header. On a page it reads{' '}
        <code>ctx.cookies</code>, which marks the render personalized: it is never cached and
        served to another visitor, even with <code>export const revalidate</code>. A guard
        proves the session is authentic; checks on what is inside it (roles, a disabled
        account) belong here, in the page: a plugin&apos;s <code>onRequest</code> does not run
        when the Rust cache answers, and a page that exports <code>revalidate</code> without
        reading the session is cached and served to anyone the guard lets through.
      </p>
      <p>
        A session exposes <code>get(key)</code>, <code>set(key, value)</code>,{' '}
        <code>unset(key)</code>, <code>has(key)</code>, a <code>data</code> snapshot, and{' '}
        <code>isNew</code> (true when the request had no valid session). Values must be
        JSON-serializable. Expired, tampered, or foreign cookies simply produce an empty new
        session - <code>getSession</code> never throws on bad input.
      </p>

      <h2 id="6-log-out">6. Log out</h2>
      <CodeBlock lang="ts" title="app/api/logout/route.ts" code={`import { sessions } from '../../../lib/session.server.ts';

export function POST() {
  return new Response(null, {
    status: 303,
    headers: { Location: '/', 'Set-Cookie': sessions.destroySession() },
  });
}`} />
      <div className="callout">
        Cookie sessions are stateless: logging out deletes the browser&apos;s cookie, but a
        copy of it stays valid until it expires. If logout must end every copy (a stolen
        laptop, a password change), keep <code>maxAge</code> short, or store a per-user session
        version server-side, put it in the session, and compare the two when you read it.
      </div>

      <h2 id="rotating-secrets">Rotating secrets</h2>
      <p>
        <code>GIO_SESSION_SECRET</code> takes several comma-separated secrets. The first one
        encrypts and signs new sessions; all of them are accepted when reading, in Node and in
        the Rust guards alike. To rotate without logging everyone out:
      </p>
      <ol>
        <li>Prepend the new secret: <code>GIO_SESSION_SECRET=new,old</code>, and restart.</li>
        <li>Sessions are re-signed with <code>new</code> whenever they are committed.</li>
        <li>After <code>maxAge</code> has passed, remove <code>old</code>.</li>
      </ol>
      <p>
        Removing a secret immediately invalidates every session it signed - the way to log
        everyone out after a leak.
      </p>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>
          The whole session lives in the cookie, and browsers drop cookies over 4096 bytes:{' '}
          <code>commitSession</code> throws a clear error instead of silently losing the
          session. Keep ids and small flags in it; look the rest up server-side.
        </li>
        <li>
          Changing <code>cookieName</code> logs everyone out: the cookie name is bound into
          every token, so a session cannot be replayed under another cookie that shares the
          secret.
        </li>
      </ul>

      <h2 id="csrf">CSRF</h2>
      <p>
        Session cookies are <code>SameSite=Lax</code> by default, so browsers leave them off
        cross-site <code>POST</code>, <code>fetch</code>, and iframe requests - a malicious site
        cannot submit a form as your logged-in user. Keep every state change behind{' '}
        <code>POST</code>, <code>PUT</code>, <code>PATCH</code>, or <code>DELETE</code> (never{' '}
        <code>GET</code>, which top-level navigations send cookies with).{' '}
        <code>SameSite</code> is the first layer. The Rust server&apos;s{' '}
        <a href="/docs/security">CSRF protection</a>, on by default, adds a second: it refuses
        cross-site requests with those methods before they reach your code.{' '}
        <code>sameSite: &apos;strict&apos;</code> is available when even links from other
        sites should arrive logged out.
      </p>

      <h2 id="cookies">Cookies</h2>
      <p>
        <code>serializeCookie(name, value, options?)</code> builds one <code>Set-Cookie</code>{' '}
        value. Its defaults are the secure ones:
      </p>
      <table>
        <thead>
          <tr><th>Option</th><th>Default</th><th>Notes</th></tr>
        </thead>
        <tbody>
          <tr><td><code>path</code></td><td><code>/</code></td><td>Must start with <code>/</code>.</td></tr>
          <tr><td><code>httpOnly</code></td><td><code>true</code></td><td>Scripts cannot read the cookie.</td></tr>
          <tr><td><code>secure</code></td><td>on in production</td><td>Off in development (plain-http localhost), except for <code>__Secure-</code>/<code>__Host-</code> names, <code>sameSite: &apos;none&apos;</code> and <code>partitioned</code>, which browsers accept only with it (Chrome and Firefox take <code>Secure</code> cookies from <code>http://localhost</code>). Pass <code>secure: false</code> explicitly to serve production over http.</td></tr>
          <tr><td><code>sameSite</code></td><td><code>&apos;lax&apos;</code></td><td><code>&apos;strict&apos;</code> or <code>&apos;none&apos;</code> (requires <code>secure</code>).</td></tr>
          <tr><td><code>maxAge</code> / <code>expires</code></td><td>-</td><td>Whole seconds / a <code>Date</code>. Neither means a browser-session cookie; <code>maxAge: 0</code> deletes.</td></tr>
          <tr><td><code>domain</code></td><td>-</td><td>Host-only when omitted.</td></tr>
          <tr><td><code>partitioned</code></td><td><code>false</code></td><td>CHIPS; requires <code>secure</code>.</td></tr>
        </tbody>
      </table>
      <CodeBlock lang="ts" code={`import { serializeCookie } from '@gio.js/core';

headers.append('Set-Cookie', serializeCookie('theme', 'dark', { httpOnly: false, maxAge: 31536000 }));
headers.append('Set-Cookie', serializeCookie('theme', '', { maxAge: 0 }));   // delete
headers.append('Set-Cookie', serializeCookie('q', encodeURIComponent(search)));`} />
      <p>
        Names and values are validated against RFC 6265 and anything invalid throws - a value
        with <code>;</code>, a space, a quote, or a line break could otherwise smuggle extra
        attributes or headers into the response. Values are not encoded for you: encode free
        text yourself, as above. Combinations browsers would silently reject also throw - an
        explicit <code>secure: false</code> with a <code>__Secure-</code> or{' '}
        <code>__Host-</code> name, <code>sameSite: &apos;none&apos;</code>, or{' '}
        <code>partitioned</code>, or a <code>__Host-</code> cookie with a{' '}
        <code>domain</code> or a <code>path</code> other than <code>/</code>.{' '}
        <code>parseCookies(header)</code> is the parser behind <code>ctx.cookies</code> and{' '}
        <code>req.cookies</code>; read its result with <code>Object.hasOwn</code> when the
        cookie name comes from elsewhere, since a plain object also &quot;has&quot;{' '}
        <code>constructor</code>.
      </p>

      <h2 id="signed-values">Signed values</h2>
      <p>
        For a value that must not be forged but may be read - an id in a URL, a
        preference cookie:
      </p>
      <CodeBlock lang="ts" code={`import { signValue, unsignValue } from '@gio.js/core';

const signed = signValue('user-42', secrets);   // "user-42.<HMAC-SHA256, base64url>"
unsignValue(signed, secrets);                   // "user-42"
unsignValue('user-43.' + signed.split('.')[1], secrets);   // null`} />
      <p>
        <code>secrets</code> is a string or an array (the first signs, all verify), each at
        least 32 bytes. Signatures are compared in constant time. The value itself stays
        readable - use a session for anything secret.
      </p>

      <h2 id="token-format">Token format</h2>
      <p>
        For reference only - the format is internal and may change behind a new version tag:
      </p>
      <CodeBlock lang="text" code={`v1.<exp>.<payload>.<mac>

exp      expiry, unix seconds
payload  base64url( iv[12] | AES-256-GCM(JSON data) | tag[16] ),  AAD = "<cookie name>\\nv1.<exp>"
mac      base64url( HMAC-SHA256(macKey, "<cookie name>\\nv1.<exp>.<payload>") )

encKey / macKey = HKDF-SHA256(secret, salt = "", info = "gio-session-enc" / "gio-session-mac")`} />
      <p>
        The expiry travels in clear and the MAC uses its own key, which is what lets the Rust
        guards verify authenticity and expiry without being able to decrypt.
      </p>
    </>
  );
}
