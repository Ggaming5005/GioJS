import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Redirecting',
  description:
    'Every way to send a visitor to another URL in GioJS - from a page action, ' +
    'getServerSideProps, a route handler, gio.toml rules, middleware.ts and guards - and ' +
    'which status code each one sends.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Redirecting</h1>
      <p className="page-subtitle">
        Every way to send a visitor to another URL in GioJS - from a page action,{' '}
        <code>getServerSideProps</code>, a route handler, <code>gio.toml</code> rules,{' '}
        <a href="/docs/file-conventions/middleware"><code>middleware.ts</code></a> and guards - and which status code each one sends.
      </p>

      <p>
        Pick the place by when you know where the visitor should go. Rules that depend only
        on the URL belong in <code>gio.toml</code> or <code>middleware.ts</code>: the Rust
        server answers them before any of your code runs. Decisions that need data - is this
        visitor signed in, does this post still exist - belong in your server code.
      </p>
      <table>
        <thead>
          <tr><th>API</th><th>Where</th><th>Use it for</th><th>Default status</th></tr>
        </thead>
        <tbody>
          <tr><td><a href="#redirect-in-a-page-action"><code>redirect()</code></a></td><td>Page <code>action</code></td><td>After a form post (Post/Redirect/Get)</td><td><code>303</code></td></tr>
          <tr><td><a href="#redirect-in-getserversideprops"><code>redirect()</code> or <code>{'{ redirect }'}</code></a></td><td><code>getServerSideProps</code></td><td>Before rendering: auth checks, moved records</td><td><code>303</code>; <code>302</code> or <code>301</code> for the object form</td></tr>
          <tr><td><a href="#redirect-in-a-route-handler"><code>redirect()</code> or a redirect <code>Response</code></a></td><td><code>route.ts</code></td><td>API endpoints, short links, OAuth hops</td><td><code>303</code> for <code>redirect()</code>; yours for a <code>Response</code></td></tr>
          <tr><td><a href="#redirects-in-gio-toml"><code>[[redirects]]</code></a></td><td><code>gio.toml</code></td><td>Moved URLs known at deploy time</td><td><code>302</code></td></tr>
          <tr><td><a href="#redirects-in-middleware-ts"><code>redirects</code></a></td><td><code>middleware.ts</code></td><td>The same rules, typed and in TypeScript</td><td><code>302</code></td></tr>
          <tr><td><a href="#guards"><code>redirect_to</code></a></td><td><code>[[guards]]</code></td><td>Sending signed-out visitors to a login page</td><td><code>302</code> (fixed)</td></tr>
          <tr><td><a href="#on-the-client"><code>router.push</code>, <code>navigate()</code></a></td><td>Browser</td><td>After a client-side event</td><td>-</td></tr>
        </tbody>
      </table>

      <h2 id="redirect-in-a-page-action">redirect() in a page action</h2>
      <p>
        A page&apos;s <a href="/docs/page-exports/action"><code>action</code></a> handles the{' '}
        <code>POST</code> of its form. Return{' '}
        <a href="/docs/functions/redirect"><code>redirect(url)</code></a> from{' '}
        <code>@gio.js/core</code> when it succeeds. The default <code>303 See Other</code>{' '}
        makes the browser load the target with a <code>GET</code>, so reloading the next page
        never submits the form again:
      </p>
      <CodeBlock lang="tsx" title="app/contact/page.tsx" code={`import React from 'react';
import { redirect, type ActionArgs } from '@gio.js/core';
import { saveMessage } from '../../lib/messages';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const email = String(form.get('email') ?? '');
  if (!email.includes('@')) {
    return { status: 422, data: { error: 'Enter a valid email.' } };
  }
  await saveMessage(email, String(form.get('message') ?? ''));
  return redirect('/contact/thanks');
}

export default function Contact({ actionData }: { actionData?: { error?: string } }): React.JSX.Element {
  return (
    <form method="post">
      <input name="email" type="email" />
      <textarea name="message" />
      {actionData?.error !== undefined && <p role="alert">{actionData.error}</p>}
      <button type="submit">Send</button>
    </form>
  );
}`} />
      <p>
        The second argument is a status or <code>{'{ status, headers }'}</code>. Headers go out
        with the redirect - a session cookie after a login, an expired one after a logout:
      </p>
      <CodeBlock lang="ts" code={`return redirect('/dashboard', {
  headers: { 'set-cookie': sessions.commitSession(session) },
});`} />
      <p>
        With <a href="/docs/components/gio-form"><code>&lt;GioForm&gt;</code></a> the same
        action runs, and the hydrated form follows the redirect through the client router -
        no full page load, and the browser history records the URL the redirect landed on.
        A redirect to another site is followed with a full navigation.
      </p>

      <h2 id="redirect-in-getserversideprops">redirect() in getServerSideProps</h2>
      <p>
        <a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a>{' '}
        runs before the page renders, so a redirect there replaces the page entirely. Return{' '}
        <code>redirect()</code>, or throw it from any helper it calls - one guard function then
        serves pages and actions alike:
      </p>
      <CodeBlock lang="ts" title="lib/auth.server.ts" code={`import { createSessionStorage, redirect } from '@gio.js/core';

export const sessions = createSessionStorage<{ userId: string }>();

export function requireUser(cookies: Record<string, string>): string {
  const userId = sessions.getSession({ cookies }).get('userId');
  if (userId === undefined) throw redirect('/login', 307);
  return userId;
}`} />
      <CodeBlock lang="tsx" title="app/account/page.tsx" code={`import { redirect, type GsspContext } from '@gio.js/core';

export async function getServerSideProps(ctx: GsspContext) {
  const user = ctx.cookies['user'];
  if (user === undefined) {
    // Remember where the visitor was going, as a path on this site.
    return redirect(\`/login?next=\${encodeURIComponent(ctx.path)}\`);
  }
  return { props: { user } };
}`} />
      <p>
        The Next.js-style object form also works, and maps <code>permanent</code> to{' '}
        <code>301</code> or <code>302</code>:
      </p>
      <CodeBlock lang="ts" title="app/moved/page.tsx" code={`export async function getServerSideProps() {
  return { redirect: { destination: '/storefront', permanent: true } }; // 301
}`} />
      <p>
        Redirect answers are never stored in the page cache, even on a page that exports{' '}
        <code>revalidate</code>, and carry <code>Cache-Control: private, no-cache</code>{' '}
        unless their headers set one - a <code>301</code> is otherwise cacheable by default,
        and a CDN would replay one visitor&apos;s redirect to everyone. On a page cached with{' '}
        <a href="/docs/page-exports/shell"><code>shell = &apos;cache&apos;</code></a>, the
        shell&apos;s <code>200</code> is already sent when <code>getServerSideProps</code>{' '}
        answers, so the page sends the visitor on with <code>location.replace()</code> (or
        reloads once to get the real response); a <a href="#guards">guard</a> avoids that
        flash. See <a href="/docs/caching-layers#partial-prerendering-ppr">Caching Layers</a>.
      </p>

      <h2 id="redirect-in-a-route-handler">Redirect in a route handler</h2>
      <p>
        A <a href="/docs/file-conventions/route"><code>route.ts</code></a> handler may return
        or throw <code>redirect()</code>, as an action does: the answer has its status
        (<code>303</code> unless you pick another), its headers and a{' '}
        <code>Location</code> header with the URL as written, relative or absolute. A web{' '}
        <code>Response</code> works too, but <code>Response.redirect()</code> accepts only
        an absolute URL: on a path like <code>/</code> it throws, and the handler answers{' '}
        <code>500</code>.
      </p>
      <CodeBlock lang="ts" title="app/api/go/route.ts" code={`import { redirect, type GioRequest } from '@gio.js/core';

const LINKS: Record<string, string> = {
  docs: 'https://giojs.com/docs',
  home: '/',
};

// /api/go?to=docs - a short-link endpoint.
export function GET(req: GioRequest) {
  const target = LINKS[req.query['to'] ?? ''];
  if (target === undefined) return Response.json({ error: 'unknown link' }, { status: 404 });
  return redirect(target, 307);
}`} />

      <h2 id="redirects-in-gio-toml">[[redirects]] in gio.toml</h2>
      <p>
        For URLs that moved, a <a href="/docs/configuration/redirects"><code>[[redirects]]</code></a>{' '}
        rule is answered by the Rust server before routing, the page cache or Node. Patterns
        use the routing syntax: <code>:param</code> captures one segment and{' '}
        <code>*rest</code> any number of them, zero included:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[redirects]]
from = "/blog/:slug"
to = "/posts/:slug"
status = 308                 # 301, 302 (default), 307 or 308

[[redirects]]
from = "/docs-old/*rest"
to = "/docs/*rest"           # /docs-old -> /docs, /docs-old/a/b -> /docs/a/b`} />
      <CodeBlock lang="text" code={`$ curl -sI 'http://localhost:3000/blog/hello?ref=mail'
HTTP/1.1 308 Permanent Redirect
location: /posts/hello?ref=mail`} />
      <ul>
        <li>The original query string is appended to the target verbatim.</li>
        <li>
          Rules match the canonical path, so <code>/blog//hello/</code> or an escaped spelling
          is caught by the same rule.
        </li>
        <li>
          Any other <code>status</code> is a startup error, as is an unknown key: a typo never
          silently turns into a <code>302</code>.
        </li>
        <li>
          <a href="/docs/configuration/headers"><code>[[headers]]</code></a> rules for the path
          apply to the redirect response too.
        </li>
      </ul>

      <h2 id="redirects-in-middleware-ts">Redirects in middleware.ts</h2>
      <p>
        The same rules in TypeScript, typed by{' '}
        <a href="/docs/functions/define-middleware"><code>defineMiddleware</code></a>. They
        travel to the Rust server when the worker starts and run there, exactly like{' '}
        <code>gio.toml</code> rules:
      </p>
      <CodeBlock lang="ts" title="middleware.ts" code={`import { defineMiddleware } from '@gio.js/core';

export default defineMiddleware({
  redirects: [
    { from: '/pricing-2025', to: '/pricing', status: 301 },
  ],
});`} />
      <p>
        <code>middleware.ts</code> is declarative: it cannot look at cookies or call a
        database. For a decision per visitor, use <a href="#guards">a guard</a> or{' '}
        <a href="#redirect-in-getserversideprops"><code>getServerSideProps</code></a>.
      </p>

      <h2 id="guards">Guards</h2>
      <p>
        A <a href="/docs/configuration/guards"><code>[[guards]]</code></a> rule redirects every
        request to its paths that lacks a credential - a valid session, or a cookie - with a{' '}
        <code>302</code> to <code>redirect_to</code>, before any of your code runs:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[guards]]
path = "/admin/*rest"
require_session = true       # a valid createSessionStorage() cookie
redirect_to = "/login"`} />
      <CodeBlock lang="text" code={`$ curl -sI 'http://localhost:3000/admin/users?tab=2'
HTTP/1.1 302 Found
location: /login?tab=2`} />
      <p>
        The request&apos;s query string is appended, but the path the visitor asked for is
        not passed along. To send visitors back after they sign in, redirect from{' '}
        <code>getServerSideProps</code> with a <code>next</code> parameter instead, as shown
        above. See <a href="/docs/authentication">Authentication</a>.
      </p>

      <h2 id="order-of-evaluation">Order of evaluation</h2>
      <p>For each request the Rust server checks, in order:</p>
      <ol>
        <li>guards, then redirects, then rewrites - <code>gio.toml</code> rules before <code>middleware.ts</code> rules within each step. Every matching guard must admit the request; among redirects and among rewrites the first match wins;</li>
        <li>the page cache and static files;</li>
        <li>the Node worker: a page action, then <code>getServerSideProps</code>, or a route handler.</li>
      </ol>
      <p>
        So a guard on a path beats a redirect rule for it, and a rule beats anything a page
        would answer. See <a href="/docs/middleware#evaluation-order">Middleware</a>.
      </p>

      <h2 id="on-the-client">On the client</h2>
      <p>
        In an event handler, move with{' '}
        <a href="/docs/hooks/use-router"><code>useRouter()</code></a> (<code>push</code>,{' '}
        <code>replace</code>) or <a href="/docs/functions/navigate"><code>navigate()</code></a>.
        Both fetch the next page through the client router; when the server answers that
        request with a redirect, the router follows it and records the final URL.
      </p>
      <CodeBlock lang="tsx" code={`import React from 'react';
import { useRouter } from '@gio.js/react';

function SignOut(): React.JSX.Element {
  const router = useRouter();
  return <button onClick={() => router.replace('/goodbye')}>Sign out</button>;
}`} />

      <h2 id="choosing-a-status-code">Choosing a status code</h2>
      <table>
        <thead>
          <tr><th>Status</th><th>Meaning</th><th>Method on the next request</th><th>Use for</th></tr>
        </thead>
        <tbody>
          <tr><td><code>301</code></td><td>Moved permanently</td><td>Browsers switch <code>POST</code> to <code>GET</code></td><td>Old URLs of <code>GET</code> pages</td></tr>
          <tr><td><code>308</code></td><td>Moved permanently</td><td>Kept</td><td>Old URLs that also receive <code>POST</code>s (APIs)</td></tr>
          <tr><td><code>302</code></td><td>Found, temporarily elsewhere</td><td>Browsers switch <code>POST</code> to <code>GET</code></td><td>Temporary moves, sign-in gates</td></tr>
          <tr><td><code>307</code></td><td>Temporarily elsewhere</td><td>Kept</td><td>Temporary moves of endpoints</td></tr>
          <tr><td><code>303</code></td><td>See other</td><td>Always <code>GET</code></td><td>After a form post</td></tr>
        </tbody>
      </table>
      <p>
        <code>redirect()</code> accepts <code>301</code>, <code>302</code>, <code>303</code>,{' '}
        <code>307</code> and <code>308</code> and throws a <code>TypeError</code> for anything
        else; <code>[[redirects]]</code> and <code>middleware.ts</code> accept all of those but{' '}
        <code>303</code>. Browsers and search engines remember permanent redirects for a long
        time: use <code>302</code> or <code>307</code> until you are sure.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Open redirects.</strong> Never redirect to a URL taken from the request
          unchecked: <code>?next=https://evil.example</code> would turn your login page into a
          phishing hop. Accept only paths on your site:
          <CodeBlock lang="ts" code={`/** Same-site paths only; \`//evil.example\` and absolute URLs fall back to \`/\`. */
export function safeNext(value: string | undefined): string {
  return value !== undefined && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\\\')
    ? value
    : '/';
}`} />
        </li>
        <li>
          <code>redirect()</code> throws a <code>TypeError</code> for an empty URL or one with
          control characters, which would otherwise inject headers.
        </li>
        <li>
          With <a href="/docs/i18n">i18n</a>, <code>ctx.path</code> is the path without the
          locale prefix: add the prefix back (<code>ctx.locale</code>) when the target should
          keep the visitor&apos;s language.
        </li>
        <li>
          A redirect can set cookies: pass <code>headers</code> to <code>redirect()</code>, or
          return <code>{'{ redirect, headers }'}</code> from <code>getServerSideProps</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/functions/redirect"><code>redirect</code></a> reference</li>
        <li><a href="/docs/forms">Forms &amp; Mutations</a> - Post/Redirect/Get</li>
        <li><a href="/docs/middleware">Middleware</a> - rules, patterns and guards</li>
        <li><a href="/docs/configuration/redirects"><code>[[redirects]]</code></a> and <a href="/docs/configuration/guards"><code>[[guards]]</code></a></li>
        <li><a href="/docs/authentication">Authentication</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              <code>redirect()</code> for page actions, <code>getServerSideProps</code> and{' '}
              <code>route.ts</code> handlers, with headers. Redirects from actions,{' '}
              <code>getServerSideProps</code> and handlers carry{' '}
              <code>Cache-Control: private, no-cache</code> unless their headers set one.{' '}
              <code>*rest</code> matches zero segments. Rules match the
              canonical path, and header rules apply to redirect responses. A per-visitor
              redirect on a PPR shell hit reaches the visitor.
            </>
          ),
        },
      ]} />
    </>
  );
}
