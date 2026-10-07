import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio cache explain',
  description:
    'Request a URL from a running GioJS server and explain, in plain words, what its ' +
    'X-Gio-Cache header says the cache did.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio cache explain</h1>
      <p className="page-subtitle">
        Request a URL from a running GioJS server and explain, in plain words, what its{' '}
        <code>X-Gio-Cache</code> header says the cache did.
      </p>
      <PmTabs command={`npx gio cache explain /posts/1`} />
      <CodeBlock lang="bash" code={`gio cache explain <url-or-path> [--base <url>]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: '<url-or-path>',
          type: 'string',
          required: true,
          description: <>An absolute URL (<code>https://example.com/blog</code>) is requested as given. A path (<code>/posts/1</code>) is requested from <code>--base</code>, else from the local server.</>,
        },
        {
          name: '--base <url>',
          type: 'string',
          default: 'local server',
          description: <>The server a path is requested from, such as <code>https://staging.example.com</code>.</>,
        },
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the help and exit with <code>0</code>.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        The local server is the address it would listen on, resolved like{' '}
        <code>gio dev</code> resolves it: <code>GIO_PORT</code> / <code>PORT</code> /{' '}
        <code>GIO_HOST</code>, the <code>.env</code> files, then <code>gio.toml</code>, with
        a wildcard host (<code>0.0.0.0</code>, <code>::</code>) reached on loopback and{' '}
        <code>https</code> when <code>[server.tls]</code> is enabled.
      </p>
      <p>
        <code>gio cache explain</code> sends one <code>GET</code> without following
        redirects, prints the status and the <code>X-Gio-Cache</code> value, and explains it:
      </p>
      <table>
        <thead>
          <tr><th><code>X-Gio-Cache</code></th><th>What happened</th></tr>
        </thead>
        <tbody>
          <tr><td><code>hit; ttl=N</code></td><td>Served from the Rust page cache without touching Node. <code>ttl</code> is the seconds until the entry goes stale.</td></tr>
          <tr><td><code>stale; age=N; revalidating</code></td><td>Served from the cache past its TTL while one background render refreshes it. <code>age</code> is the seconds since it was rendered.</td></tr>
          <tr><td><code>miss; stored</code></td><td>Rendered by the Node worker and stored; the next request is a hit.</td></tr>
          <tr><td><code>bypass</code></td><td>Not served from the cache. Either rendered and not stored - the page has no <code>revalidate</code>, the request was not <code>GET</code> / <code>HEAD</code>, the render was personalized (cookies, credentials, client address), it set per-request headers, or <code>[cache] enabled = false</code> - or refused by the server itself before Node (a rate-limit <code>429</code>, a skew <code>409</code>, a CSRF <code>403</code>).</td></tr>
          <tr><td><code>static</code></td><td>A file from <code>public/</code>, a hashed chunk under <code>/_next/static/</code> or a self-hosted font under <code>/_gio/fonts/</code>, served by Rust without the cache or Node.</td></tr>
          <tr><td><code>ppr; ...</code></td><td>Partial prerendering: the shared shell came from (or went into) the cache and the Suspense holes rendered for this request.</td></tr>
          <tr><td>(absent)</td><td>An internal <code>/_gio</code> endpoint, or a server older than <code>X-Gio-Cache</code>. The image optimizer, <code>/_gio/image</code>, answers <code>HIT</code> or <code>MISS</code> for its own cache instead; the command prints that value as it is.</td></tr>
        </tbody>
      </table>

      <h2 id="examples">Examples</h2>
      <h3 id="watch-a-page-get-cached">Watch a page get cached</h3>
      <CodeBlock lang="text" code={`$ npx gio cache explain /blog
GET http://127.0.0.1:3000/blog
  status       200
  x-gio-cache  miss; stored
  → Rendered by the Node worker and stored in the cache - the next
    request for this key is a hit. Pages opt in via \`export const revalidate\`.
$ npx gio cache explain /blog
GET http://127.0.0.1:3000/blog
  status       200
  x-gio-cache  hit; ttl=60
  → Served from the Rust page cache without touching Node. "ttl" is the
    seconds until this entry goes stale.`} />
      <p>With <code>app/blog/page.tsx</code> exporting <code>revalidate = 60</code>.</p>

      <h3 id="a-page-that-is-not-cached">A page that is not cached</h3>
      <CodeBlock lang="text" code={`$ npx gio cache explain /about
GET http://127.0.0.1:3000/about
  status       200
  x-gio-cache  bypass
  → NOT served from the cache. Either rendered by the Node worker but not
    stored - the page cache is off (\`[cache] enabled = false\`), the page did
    not declare \`revalidate\`, the request was not GET/HEAD, the response
    varies per user, or it set per-request headers - or refused by the
    server itself before Node (a rate-limit 429, a skew 409, a CSRF 403).`} />
      <p>
        When a page declares <code>revalidate</code> but its render is personalized (it
        read cookies or credentials, or set a cookie), the server logs a warning naming the
        route.
      </p>

      <h3 id="ask-a-deployed-server">Ask a deployed server</h3>
      <CodeBlock lang="bash" code={`npx gio cache explain /pricing --base https://staging.example.com
npx gio cache explain https://example.com/pricing`} />

      <h3 id="a-server-on-another-port">A local server on another port</h3>
      <CodeBlock lang="bash" code={`gio dev --port 4000            # one terminal
GIO_PORT=4000 gio cache explain /   # another`} />
      <p>
        <code>--port</code> applies only to the server it starts; tell{' '}
        <code>gio cache explain</code> the same port through the environment, or use{' '}
        <code>--base</code>.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The request carries no cookies, so it sees what an anonymous visitor (and a CDN)
          sees.
        </li>
        <li>
          Exit codes: <code>0</code> whenever the server answered, whatever the status;{' '}
          <code>1</code> when it could not be reached (<code>is the server running?</code>);{' '}
          <code>2</code> for a usage error.
        </li>
        <li>
          Each request counts: running it twice on a <code>miss</code> stores the entry, and a
          request past the TTL starts the background refresh.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/caching-layers#observing-the-cache-x-gio-cache">Caching Layers: observing the cache</a></li>
        <li><a href="/docs/caching">Caching &amp; Revalidating</a></li>
        <li><a href="/docs/cli/bench"><code>gio bench</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Paths go to the address the server listens on (<code>GIO_PORT</code> / <code>PORT</code>, <code>.env</code> files, <code>gio.toml</code>) instead of port 3000; <code>--base &lt;url&gt;</code>; explains <code>ppr</code> responses and names <code>[cache] enabled = false</code> and the server&apos;s own refusals as reasons for <code>bypass</code>. Self-hosted fonts answer <code>static</code>.</> },
        { version: 'v0.1.0-beta.6', changes: 'Introduced.' },
      ]} />
    </>
  );
}
