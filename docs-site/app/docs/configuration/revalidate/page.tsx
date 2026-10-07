import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[revalidate]',
  description:
    'The token that turns on POST /_gio/revalidate, the endpoint CMS webhooks and scripts use to purge ' +
    'cached pages by tag or path.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[revalidate]</h1>
      <p className="page-subtitle">
        The token that turns on <code>POST /_gio/revalidate</code>, the endpoint CMS webhooks and
        scripts use to purge cached pages by tag or path.
      </p>
      <CodeBlock lang="bash" code={`# preferred: keep the token out of gio.toml
export GIO_REVALIDATE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")`} />
      <CodeBlock lang="toml" title="gio.toml" code={`[revalidate]
token = "replace-with-at-least-32-random-bytes-of-secret"`} />
      <p>
        Without a token the endpoint does not exist. Inside the app,{' '}
        <a href="/docs/functions/revalidate-tag"><code>revalidateTag</code></a> and{' '}
        <a href="/docs/functions/revalidate-path"><code>revalidatePath</code></a> purge the cache
        with no token at all.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'token', type: 'string', default: '""', zero: <>Empty: the endpoint is not routed (<code>404</code>)</>, env: 'GIO_REVALIDATE_TOKEN', description: <>The bearer token <code>POST /_gio/revalidate</code> requires, at least 32 bytes after trimming. <code>GIO_REVALIDATE_TOKEN</code> wins when it is set and not empty. A shorter token stops startup.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        The endpoint takes a JSON body with <code>tags</code> and/or <code>paths</code> (up to 64
        each) and <code>prefix</code> (<code>true</code> purges every path and everything below
        it). Matching pages are dropped from memory and disk, so the next request renders fresh.
      </p>
      <table>
        <thead>
          <tr><th>Status</th><th>When</th></tr>
        </thead>
        <tbody>
          <tr><td><code>200</code></td><td><code>{'{"ok":true,"purged":7}'}</code></td></tr>
          <tr><td><code>400</code></td><td>A malformed body, an unknown field, nothing to purge, too many or invalid tags or paths.</td></tr>
          <tr><td><code>401</code></td><td>A missing or wrong token, with <code>WWW-Authenticate: Bearer</code>.</td></tr>
          <tr><td><code>408</code></td><td>The body took longer than <code>[server] request_body_timeout_secs</code>.</td></tr>
          <tr><td><code>413</code></td><td>A body over 64 KiB.</td></tr>
          <tr><td><code>429</code></td><td>The client sent 10 wrong tokens within a minute: refused for the rest of it, right token or not, with <code>Retry-After</code>.</td></tr>
        </tbody>
      </table>

      <h3 id="errors">Errors</h3>
      <p>
        <code>the revalidation token ([revalidate] token) is 5 bytes; at least 32 are required</code>{' '}
        (or <code>(GIO_REVALIDATE_TOKEN)</code>) stops startup and fails <code>--check-config</code>.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="purge-from-a-cms-webhook">Purge from a CMS webhook</h3>
      <CodeBlock lang="bash" code={`curl -X POST https://example.com/_gio/revalidate \\
  -H "Authorization: Bearer $GIO_REVALIDATE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "tags": ["post:42"], "paths": ["/blog"], "prefix": true }'`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The endpoint is authenticated by its token, not by cookies, so{' '}
          <a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a> does not apply
          to it. Call it over HTTPS.
        </li>
        <li>
          Each instance has its own cache: with several instances, call every one of them, by its
          own address.
        </li>
        <li>
          Behind a reverse proxy, list it in <code>[server] trusted_proxies</code>: otherwise the
          failed-attempt limit counts every client as the proxy.
        </li>
        <li>With i18n on, a leading locale segment is dropped from a path, so the purge reaches every locale of the page.</li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>
          <strong>The 32-byte minimum.</strong> The endpoint is public, so the token is the only
          thing between it and a purge flood.
        </li>
        <li>The failed-attempt limit (10 per minute per client) and the 64 tags / 64 paths per request.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/caching#from-outside-post-giorevalidate">Caching: From outside</a></li>
        <li><a href="/docs/configuration/cache"><code>[cache]</code></a></li>
        <li><a href="/docs/page-exports/tags"><code>tags</code></a></li>
        <li><a href="/docs/env-vars">Environment variables</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced, with <code>GIO_REVALIDATE_TOKEN</code>.</> },
      ]} />
    </>
  );
}
