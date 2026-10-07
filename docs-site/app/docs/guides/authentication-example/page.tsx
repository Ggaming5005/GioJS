import React from 'react';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Guides</div>
      <h1>Authentication Example</h1>
      <p className="page-subtitle">
        A working login: encrypted cookie sessions, a page action that checks credentials, a
        logout route, and a protected section guarded in Rust.
      </p>

      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --auth   # a new app
npx create-giojs add auth                    # an existing app`} />
      <p>
        Run <code>npm run dev</code>, open <code>/dashboard</code>, and the guard sends you to{' '}
        <code>/login</code>. The demo user is in <code>.env.development</code> (
        <code>DEMO_EMAIL</code> / <code>DEMO_PASSWORD</code>). The building blocks are explained
        on the <a href="/docs/authentication">Authentication</a> page; this guide walks through
        the files the feature adds.
      </p>

      <h2>The session storage</h2>
      <CodeBlock lang="ts" code={`// lib/session.server.ts
import { createSessionStorage } from '@gio.js/core';

export interface UserSession {
  email: string;
}

export const sessions = createSessionStorage<UserSession>();`} />
      <p>
        The session lives in an encrypted, signed <code>gio_session</code> cookie, with keys from{' '}
        <code>GIO_SESSION_SECRET</code>. In development the server makes an ephemeral secret
        when none is set; in production a missing secret is an error. The <code>.server.ts</code>{' '}
        name keeps the module out of client bundles.
      </p>

      <h2>Logging in</h2>
      <p>
        <code>app/login/page.tsx</code> renders a <code>&lt;GioForm&gt;</code> and handles its
        POST in a page action. Wrong credentials re-render the page with a 422 and the typed
        email; the right ones commit the session and redirect:
      </p>
      <CodeBlock lang="tsx" code={`export async function action(req: ActionArgs) {
  const form = await req.formData();
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const email = field('email').trim();
  if (!verifyCredentials(email, field('password'))) {
    return { status: 422, data: { error: 'Wrong email or password.', email } };
  }
  const session = sessions.getSession(req);
  session.set('email', email);
  return redirect('/dashboard', { headers: { 'set-cookie': sessions.commitSession(session) } });
}`} />
      <p>
        <code>verifyCredentials</code> (<code>lib/auth.server.ts</code>) compares both the email
        and the password with <code>timingSafeEqual</code> over SHA-256 digests, always both,
        so response times reveal neither which field was wrong nor how much of it matched. When{' '}
        <code>DEMO_EMAIL</code> or <code>DEMO_PASSWORD</code> is unset or empty - as in
        production, which never loads <code>.env.development</code> - nobody can log in. (The
        first file that sets a variable wins, and <code>.env.local</code> comes before{' '}
        <code>.env.development</code>, which is why <code>.env.example</code> lists them
        commented out: copied as is, empty values would turn the demo login off.) Replace it
        with a lookup in your user store and a password-hash check (<code>node:crypto</code>&apos;s{' '}
        <code>scrypt</code>, for one) before going live.
      </p>

      <h2>The protected section</h2>
      <CodeBlock lang="toml" code={`# gio.toml
[[guards]]
path = "/dashboard/*rest"
require_session = true
redirect_to = "/login"

[[rate_limits]]
path = "/login"
per_ip = 10
window_seconds = 60
burst = 5`} />
      <p>
        The guard runs in the Rust server before any Node code: a request for{' '}
        <code>/dashboard</code> or anything below it without a valid, unexpired session is
        redirected to <code>/login</code>. The rate limit answers password guessing with{' '}
        <code>429</code>, also in Rust. <code>app/dashboard/page.tsx</code> reads the session in{' '}
        <code>getServerSideProps</code>, which also marks the render personal, so it is never
        cached and served to someone else.
      </p>

      <h2>Logging out</h2>
      <CodeBlock lang="ts" code={`// app/logout/route.ts
export function POST(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': sessions.destroySession() },
  });
}`} />
      <p>
        The dashboard posts to it with <code>&lt;GioForm action=&quot;/logout&quot;&gt;</code>.
        Logout deletes the cookie; a copied cookie stays valid until it expires (see{' '}
        <a href="/docs/authentication">Authentication</a> for revoking every copy).
      </p>

      <h2>CSRF</h2>
      <p>
        The forms carry no CSRF tokens, and need none: the Rust server refuses cross-site{' '}
        <code>POST</code>, <code>PUT</code>, <code>PATCH</code> and <code>DELETE</code> requests
        with <code>403</code> before an action or route handler runs, and the session cookie is{' '}
        <code>SameSite=Lax</code>. Keep every state change behind one of those methods - never
        a <code>GET</code>. See <a href="/docs/security">Security</a>.
      </p>

      <h2>Before you deploy</h2>
      <CodeBlock lang="bash" code={`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`} />
      <p>
        Set the result as <code>GIO_SESSION_SECRET</code> in the server environment or a
        git-ignored <code>.env.production.local</code> (<code>.env.example</code> lists every
        variable the feature uses).
      </p>
    </>
  );
}
