import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'createSessionStorage',
  description:
    'Create encrypted cookie sessions: the data lives in an AES-256-GCM encrypted, signed cookie that Rust guards can verify.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>createSessionStorage</h1>
      <p className="page-subtitle">
        Create encrypted cookie sessions: the data lives in an AES-256-GCM encrypted, signed
        cookie that Rust guards can verify.
      </p>
      <CodeBlock lang="ts" title="lib/session.server.ts" code={`import { createSessionStorage } from '@gio.js/core';

interface UserSession {
  userId: string;
  flash: string;
}

export const sessions = createSessionStorage<UserSession>();`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>{'createSessionStorage<Data>(options?)'}</code>. <code>Data</code> is the shape
        of the session (default <code>{'Record<string, unknown>'}</code>); its values must be
        JSON-serializable.
      </p>
      <PropsTable kind="Option" rows={[
        {
          name: 'cookieName',
          type: 'string',
          default: "'gio_session'",
          description: (
            <>
              The cookie that holds the session - also the one <code>require_session</code>{' '}
              guards read unless they name another. Must be a valid RFC 6265 cookie name.
            </>
          ),
        },
        {
          name: 'secrets',
          type: 'string | string[]',
          default: 'GIO_SESSION_SECRET',
          description: (
            <>
              The keys. The first encrypts and signs; all of them are accepted when reading.
              Each must be at least 32 bytes. Leave it unset for a storage a guard checks:
              guards verify with <code>GIO_SESSION_SECRET</code> only.
            </>
          ),
        },
        {
          name: 'maxAge',
          type: 'number',
          default: '604800',
          description: (
            <>
              Lifetime in whole seconds (7 days), written into the token and into the
              cookie&apos;s <code>Max-Age</code>. Must be a positive integer.
            </>
          ),
        },
        {
          name: 'cookie',
          type: "Omit<CookieOptions, 'maxAge' | 'expires'>",
          default: '{}',
          description: (
            <>
              Cookie attributes, with the defaults of{' '}
              <a href="/docs/functions/cookies#serializecookie">serializeCookie</a>:{' '}
              <code>HttpOnly</code>, <code>SameSite=Lax</code>, <code>Path=/</code>,{' '}
              <code>Secure</code> in production.
            </>
          ),
        },
      ]} />

      <h3 id="returns">Returns</h3>
      <p>A <code>{'SessionStorage<Data>'}</code>:</p>
      <PropsTable kind="Field" rows={[
        { name: 'cookieName', type: 'string', description: <>The cookie name in use.</> },
        {
          name: 'getSession(source)',
          type: 'Session<Data>',
          description: (
            <>
              Reads the request&apos;s session. <code>source</code> is a{' '}
              <code>getServerSideProps</code> context, a <code>route.ts</code> or action
              request, a <code>GioSocket</code>, a plugin&apos;s <code>IPCRequest</code>, a
              web <code>Request</code>, or the raw <code>Cookie</code> header. A missing,
              expired or tampered cookie gives an empty session with <code>isNew: true</code>{' '}
              - it never throws.
            </>
          ),
        },
        {
          name: 'commitSession(session, options?)',
          type: 'string',
          description: (
            <>
              Encrypts the session into a <code>Set-Cookie</code> value with a fresh expiry.{' '}
              <code>options.maxAge</code> overrides the lifetime for this cookie. Throws when
              the cookie would exceed 4096 bytes.
            </>
          ),
        },
        {
          name: 'destroySession()',
          type: 'string',
          description: <>A <code>Set-Cookie</code> value that deletes the session cookie.</>,
        },
      ]} />
      <h3 id="session">Session</h3>
      <PropsTable kind="Field" rows={[
        { name: 'isNew', type: 'boolean', description: <>True when the request carried no valid session.</> },
        { name: 'data', type: 'Partial<Data>', description: <>A shallow copy of the current values.</> },
        { name: 'get(key)', type: 'Data[K] | undefined', description: <>One value.</> },
        { name: 'set(key, value)', type: 'void', description: <>Sets a value; <code>undefined</code> removes the key.</> },
        { name: 'unset(key)', type: 'void', description: <>Removes a key.</> },
        { name: 'has(key)', type: 'boolean', description: <>Whether the key is set.</> },
      ]} />
      <p>
        Changes live only in the <code>Session</code> object until you send{' '}
        <code>commitSession(session)</code> as a <code>Set-Cookie</code> header.
      </p>

      <h3 id="secrets-and-modes">Secrets and modes</h3>
      <ul>
        <li>
          <code>GIO_SESSION_SECRET</code> holds one secret or several, comma-separated. Each is
          at least 32 bytes; generate one with{' '}
          <code>{`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`}</code>.
        </li>
        <li>
          <strong>Production</strong> refuses to create a storage without a secret: the call
          throws <code>GIO_SESSION_SECRET is not set...</code>. A module that creates its
          storage at the top level therefore fails to load, and a <code>route.ts</code> that
          imports it answers <code>500</code>.
        </li>
        <li>
          <strong>Development</strong> (<code>NODE_ENV=development</code>) without a secret
          uses an ephemeral one - generated by the dev server, which also hands it to{' '}
          <code>require_session</code> guards, or by the worker process itself when it runs
          without one - and logs a warning: sessions reset when it restarts.
        </li>
        <li>
          A <code>secrets</code> option whose first secret is not in a set{' '}
          <code>GIO_SESSION_SECRET</code> logs a warning, since a guard on that cookie would
          reject every session.
        </li>
      </ul>

      <h3 id="errors">Errors</h3>
      <p>
        Bad configuration throws at creation, not on the first login: a missing secret in
        production, a secret under 32 bytes, an invalid <code>cookieName</code>, a{' '}
        <code>maxAge</code> that is not a positive integer, and cookie options browsers would
        reject (for example <code>{"sameSite: 'none'"}</code> with <code>secure: false</code>).
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="log-in">Log in</h3>
      <CodeBlock lang="ts" title="app/api/login/route.ts" code={`import type { GioRequest } from '@gio.js/core';
import { sessions } from '../../../lib/session.server.ts';

export async function POST(req: GioRequest) {
  const form = await req.formData();
  const user = await verifyPassword(String(form.get('email')), String(form.get('password')));
  if (user === null) return new Response('Wrong email or password', { status: 401 });

  const session = sessions.getSession(req);
  session.set('userId', user.id);
  return new Response(null, {
    status: 303,
    headers: { Location: '/dashboard', 'Set-Cookie': sessions.commitSession(session) },
  });
}`} />
      <h3 id="read-it-in-a-page">Read it in a page</h3>
      <CodeBlock lang="tsx" title="app/dashboard/page.tsx" code={`import { redirect, type GetServerSideProps } from '@gio.js/core';
import { sessions } from '../../lib/session.server.ts';

export const getServerSideProps = (async (ctx) => {
  const userId = sessions.getSession(ctx).get('userId');
  if (userId === undefined) throw redirect('/login');
  return { props: { user: await db.users.find(userId) } };
}) satisfies GetServerSideProps;`} />
      <h3 id="log-out">Log out</h3>
      <CodeBlock lang="ts" title="app/api/logout/route.ts" code={`import { sessions } from '../../../lib/session.server.ts';

export function POST() {
  return new Response(null, {
    status: 303,
    headers: { Location: '/', 'Set-Cookie': sessions.destroySession() },
  });
}`} />
      <h3 id="protect-a-section-in-rust">Protect a section in Rust</h3>
      <p>
        A guard checks the session cookie&apos;s signature and expiry before any Node code
        runs, with <code>GIO_SESSION_SECRET</code>:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[guards]]
path = "/dashboard/*rest"
require_session = true
redirect_to = "/login"`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Reading a session makes the page personal.</strong> Reading{' '}
          <code>ctx.cookies</code> (which <code>getSession(ctx)</code> does) keeps the render
          out of the shared page cache.
        </li>
        <li>
          <strong>Stateless.</strong> Logging out deletes the browser&apos;s cookie, but a
          copied cookie stays valid until it expires. Keep <code>maxAge</code> short, or store
          a per-user session version server-side and compare it, when logout must end every
          copy.
        </li>
        <li>
          <strong>Not rolling.</strong> The expiry is set when you commit. To extend a session
          on activity, commit it again.
        </li>
        <li>
          <strong>Size.</strong> Keep ids and small flags in the session; the whole cookie must
          stay under 4096 bytes.
        </li>
        <li>
          <strong>The cookie name is bound into the token.</strong> Changing{' '}
          <code>cookieName</code> logs everyone out, and a token cannot be replayed under
          another cookie that shares the secret.
        </li>
        <li>
          <strong>Rotation.</strong> Prepend a new secret (<code>GIO_SESSION_SECRET=new,old</code>),
          restart, and remove the old one after <code>maxAge</code>. Removing a secret
          invalidates every session it signed at once.
        </li>
        <li>
          <strong>Tests.</strong> <code>renderPage</code> and <code>callRoute</code> set a
          random secret for the test process when none is configured, so session modules load
          there.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/authentication">Authentication</a> - the full login flow, guards and rotation</li>
        <li><a href="/docs/guides/authentication-example">Authentication Example</a></li>
        <li><a href="/docs/functions/cookies">Cookie helpers</a></li>
        <li><a href="/docs/configuration/guards">[[guards]]</a></li>
        <li><a href="/docs/env-vars">Environment variables</a> - <code>GIO_SESSION_SECRET</code></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
