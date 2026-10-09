import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Cookie helpers',
  description:
    'parseCookies, serializeCookie, signValue and unsignValue: read the Cookie header, write Set-Cookie values with secure defaults, and sign values against tampering.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Cookie helpers</h1>
      <p className="page-subtitle">
        <code>parseCookies</code>, <code>serializeCookie</code>, <code>signValue</code> and{' '}
        <code>unsignValue</code>: read the <code>Cookie</code> header, write{' '}
        <code>Set-Cookie</code> values with secure defaults, and sign values against
        tampering.
      </p>
      <CodeBlock lang="ts" code={`import { parseCookies, serializeCookie, signValue, unsignValue } from '@gio.js/core';`} />
      <p>
        All four are server-side (they use <code>node:crypto</code>). For encrypted sessions,
        use <a href="/docs/functions/create-session-storage">createSessionStorage</a>, which is
        built on them.
      </p>

      <h2 id="reference">Reference</h2>

      <h3 id="parsecookies">parseCookies</h3>
      <CodeBlock lang="ts" code={`parseCookies(header: string | undefined): Record<string, string>`} />
      <p>
        <code>parseCookies()</code> parses a <code>Cookie</code> request header into name and
        value. It is the parser
        behind <code>ctx.cookies</code>, <code>req.cookies</code> and{' '}
        <code>socket.cookies</code>, so you need it only for a raw header - in a plugin, or a
        header you received elsewhere.
      </p>
      <ul>
        <li>The first occurrence of a name wins.</li>
        <li>Names and values are trimmed. Values are not decoded: <code>%20</code> stays <code>%20</code>.</li>
        <li>Parts without <code>=</code> or with an empty name are skipped, and a cookie named <code>__proto__</code> is never stored.</li>
        <li>
          Read the result by own property (<code>Object.hasOwn(cookies, name)</code>) when the
          name comes from elsewhere: a plain object also &quot;has&quot;{' '}
          <code>constructor</code> through its prototype.
        </li>
      </ul>
      <CodeBlock lang="ts" code={`parseCookies('theme=dark; lang = fr ; theme=light; q=a%20b');
// { theme: 'dark', lang: 'fr', q: 'a%20b' }`} />

      <h3 id="serializecookie">serializeCookie</h3>
      <CodeBlock lang="ts" code={`serializeCookie(name: string, value: string, options?: CookieOptions): string`} />
      <p>
        <code>serializeCookie()</code> returns one <code>Set-Cookie</code> header value. Values are written as given: encode free text
        yourself, for example with <code>encodeURIComponent</code>.
      </p>
      <PropsTable kind="Option" rows={[
        { name: 'path', type: 'string', default: "'/'", description: <>Must start with <code>/</code>; no control characters or <code>;</code>.</> },
        { name: 'domain', type: 'string', description: <>Omitted by default: a host-only cookie.</> },
        { name: 'maxAge', type: 'number', description: <>Lifetime in whole seconds; <code>0</code> deletes the cookie. Without <code>maxAge</code> or <code>expires</code>, it is a browser-session cookie.</> },
        { name: 'expires', type: 'Date', description: <>An absolute expiry; must be a valid <code>Date</code>.</> },
        { name: 'httpOnly', type: 'boolean', default: 'true', description: <>Page scripts cannot read the cookie. Set <code>false</code> for a value client code reads.</> },
        {
          name: 'secure',
          type: 'boolean',
          default: 'true in production',
          description: (
            <>
              Off in development - except for <code>__Secure-</code> and{' '}
              <code>__Host-</code> names, <code>{"sameSite: 'none'"}</code> and{' '}
              <code>partitioned</code>, which browsers accept only with it. Pass{' '}
              <code>false</code> explicitly to serve a production build over plain http.
            </>
          ),
        },
        { name: 'sameSite', type: "'lax' | 'strict' | 'none'", default: "'lax'", description: <><code>&apos;none&apos;</code> requires <code>secure</code>.</> },
        { name: 'partitioned', type: 'boolean', default: 'false', description: <>A CHIPS partitioned cookie; requires <code>secure</code>.</> },
      ]} />
      <p>
        Attributes come out in a fixed order: <code>Max-Age</code>, <code>Expires</code>,{' '}
        <code>Domain</code>, <code>Path</code>, <code>HttpOnly</code>, <code>Secure</code>,{' '}
        <code>SameSite</code>, <code>Partitioned</code>.
      </p>
      <CodeBlock lang="ts" code={`serializeCookie('theme', 'dark');
// production: 'theme=dark; Path=/; HttpOnly; Secure; SameSite=Lax'
// development: 'theme=dark; Path=/; HttpOnly; SameSite=Lax'`} />
      <p>
        It throws a <code>TypeError</code> instead of writing a header a browser would
        misread or drop:
      </p>
      <ul>
        <li>a name that is not an RFC 6265 token, or a value with whitespace, quotes, commas, semicolons, backslashes or control characters;</li>
        <li>a <code>maxAge</code> that is not a whole number, or an invalid <code>expires</code>, <code>path</code>, <code>domain</code> or <code>sameSite</code>;</li>
        <li>an explicit <code>secure: false</code> with <code>{"sameSite: 'none'"}</code>, <code>partitioned</code> or a <code>__Secure-</code> name;</li>
        <li>a <code>__Host-</code> cookie that is not secure, has a <code>domain</code>, or a <code>path</code> other than <code>/</code>.</li>
      </ul>

      <h3 id="signvalue">signValue</h3>
      <CodeBlock lang="ts" code={`signValue(value: string, secrets: string | readonly string[]): string`} />
      <p>
        <code>signValue()</code> returns <code>{'<value>.<signature>'}</code>: an HMAC-SHA256 of the value, base64url-encoded,
        with a key derived from the first secret. Signing proves the value was not changed;
        it does not hide it. <code>secrets</code> is a string or an array of strings, each at
        least 32 bytes - shorter ones throw.
      </p>

      <h3 id="unsignvalue">unsignValue</h3>
      <CodeBlock lang="ts" code={`unsignValue(signed: string, secrets: string | readonly string[]): string | null`} />
      <p>
        <code>unsignValue()</code> returns the original value when the signature matches any
        of <code>secrets</code>, and <code>null</code> otherwise
        (tampered, signed with another key, or not a signed value at all). Every secret is
        tried and signatures are compared in constant time, so the time taken does not tell
        an attacker which part was wrong. Keeping an old secret in the list lets values
        signed before a rotation keep verifying.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="set-and-clear-cookies-in-a-route-handler">Set and clear cookies in a route handler</h3>
      <p>
        Append one <code>Set-Cookie</code> per cookie; each is sent as its own header.
      </p>
      <CodeBlock lang="ts" title="app/api/prefs/route.ts" code={`import { serializeCookie, signValue, unsignValue, type GioRequest } from '@gio.js/core';

const secrets = (process.env.PREFS_SECRET ?? '').split(',');   // each at least 32 bytes

export function GET(req: GioRequest) {
  const signed = req.cookies['prefs'];
  const theme = signed === undefined ? null : unsignValue(signed, secrets);
  return { theme: theme === null ? 'light' : decodeURIComponent(theme) };
}

export function POST(req: GioRequest) {
  const { theme } = req.json<{ theme: string }>();
  const headers = new Headers();
  // Encode first: a signed value is cookie-safe only when the value is.
  headers.append('Set-Cookie', serializeCookie('prefs', signValue(encodeURIComponent(theme), secrets), {
    maxAge: 60 * 60 * 24 * 365,
  }));
  // Readable by client code:
  headers.append('Set-Cookie', serializeCookie('theme', encodeURIComponent(theme), { httpOnly: false }));
  return new Response(null, { status: 204, headers });
}

export function DELETE() {
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': serializeCookie('prefs', '', { maxAge: 0 }) },
  });
}`} />
      <p>In production, <code>POST</code> with <code>{'{"theme":"dark mode"}'}</code> sends:</p>
      <CodeBlock lang="text" code={`Set-Cookie: prefs=dark%20mode.<43-character signature>; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax
Set-Cookie: theme=dark%20mode; Path=/; Secure; SameSite=Lax`} />
      <h3 id="cookies-from-getserversideprops">Cookies from getServerSideProps</h3>
      <CodeBlock lang="ts" code={`import { serializeCookie, type GetServerSidePropsContext } from '@gio.js/core';

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const seen = ctx.cookies['seen'] === '1';
  return {
    props: { firstVisit: !seen },
    headers: { 'set-cookie': [serializeCookie('seen', '1', { maxAge: 60 * 60 * 24 * 30 })] },
  };
}`} />
      <p>
        A page that sends <code>set-cookie</code> (or reads <code>ctx.cookies</code>) is never
        stored in the shared page cache.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>No encoding is done for you</strong>, in either direction: encode with{' '}
          <code>encodeURIComponent</code> before <code>serializeCookie</code>, decode after
          reading.
        </li>
        <li>
          <strong>Development vs production</strong> is the server&apos;s mode:{' '}
          <code>NODE_ENV=development</code> means development, anything else (including{' '}
          <code>test</code>) production, where <code>Secure</code> is on. Browsers accept{' '}
          <code>Secure</code> cookies from <code>http://localhost</code>.
        </li>
        <li>
          <strong>Delete with the same <code>path</code> and <code>domain</code></strong> the
          cookie was set with; a cookie set on <code>/admin</code> is not removed by one
          cleared on <code>/</code>.
        </li>
        <li>
          <strong>Secrets</strong> for <code>signValue</code> are your own; they need not be{' '}
          <code>GIO_SESSION_SECRET</code>. Generate one with{' '}
          <code>{`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`}</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/authentication#cookies">Authentication: Cookies</a> and <a href="/docs/authentication#signed-values">Signed values</a></li>
        <li><a href="/docs/route-handlers#setting-cookies">Route Handlers: Setting cookies</a></li>
        <li><a href="/docs/fetching-data#response-headers-and-cookies">Fetching Data: Response headers and cookies</a></li>
        <li><a href="/docs/functions/create-session-storage">createSessionStorage</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Introduced <code>serializeCookie</code> (secure defaults, validation),{' '}
              <code>parseCookies</code>, <code>signValue</code> and <code>unsignValue</code>.
            </>
          ),
        },
      ]} />
    </>
  );
}
