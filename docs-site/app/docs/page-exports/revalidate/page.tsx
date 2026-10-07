import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'revalidate',
  description:
    "Cache a page's rendered HTML in the Rust server for a number of seconds, or until the next deploy or purge.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>revalidate</h1>
      <p className="page-subtitle">
        Cache a page&apos;s rendered HTML in the Rust server for a number of seconds, or until
        the next deploy or purge.
      </p>
      <CodeBlock lang="tsx" title="app/blog/page.tsx" code={`export const revalidate = 60;   // fresh for 60 seconds, then refreshed in the background`} />
      <p>
        A page without <code>revalidate</code> renders on every request. With it, the first
        request renders the page in the Node worker and the Rust server stores the HTML; later
        requests for the same URL are answered from memory (or the disk tier) without running
        any JavaScript.
      </p>

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        { name: 'revalidate', type: 'number | false', default: '(not set)', description: <>Seconds the cached page stays fresh, or <code>false</code> to keep it until a purge or a deploy. Not set: the page is rendered per request and never stored.</> },
      ]} />
      <table>
        <thead><tr><th>Value</th><th>Effect</th></tr></thead>
        <tbody>
          <tr><td>not exported</td><td>Rendered per request and streamed. <code>Cache-Control: private, no-cache</code>, <code>X-Gio-Cache: bypass</code>.</td></tr>
          <tr><td><code>N</code> (a whole number above 0)</td><td>Cached and fresh for <code>N</code> seconds, then served stale while one background render refreshes it.</td></tr>
          <tr><td><code>false</code></td><td>Cached for one year (<code>31536000</code> seconds): in practice until a purge, or a deploy that changes the deployment ID.</td></tr>
          <tr><td><code>0</code></td><td>Not cached - the same as leaving it out.</td></tr>
          <tr><td>anything else</td><td>An error naming the file: at startup when written as a literal, at render otherwise (see below).</td></tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Freshness and stale-while-revalidate.</strong> For <code>N</code> seconds a
          request is a hit (<code>X-Gio-Cache: hit; ttl=...</code>). After that, until the page
          is <code>[cache] swr_multiplier</code> times <code>N</code> old (10 by default), the
          stale copy is served at once (<code>stale; age=...; revalidating</code>) while one
          background render replaces it. Past that window the next request renders
          synchronously. <code>swr_multiplier = 0</code> never serves stale.
        </li>
        <li>
          <strong>The cache key</strong> is the method (<code>GET</code> or <code>HEAD</code>),
          the path and the query string, so <code>/blog?page=2</code> is its own entry. With
          i18n, each locale is its own entry. Concurrent misses for the same key share one
          render.
        </li>
        <li>
          <strong>HTTP caching.</strong> A cached page is sent with{' '}
          <code>Cache-Control: public, max-age=0, s-maxage=&lt;seconds left&gt;, stale-while-revalidate=&lt;rest of the window&gt;</code>{' '}
          and a weak <code>ETag</code>; a matching <code>If-None-Match</code> gets a{' '}
          <code>304</code>. A <code>Cache-Control</code> set by the app or a{' '}
          <code>[[headers]]</code> rule wins. See{' '}
          <a href="/docs/caching#browser-and-cdn-caching">Browser and CDN caching</a>.
        </li>
        <li>
          <strong>Purging.</strong> <code>revalidateTag()</code>, <code>revalidatePath()</code>{' '}
          and <code>POST /_gio/revalidate</code> remove entries at once; the next request
          renders fresh. A new deployment ID (any change to the app&apos;s code) drops every
          entry the previous build stored.
        </li>
      </ul>

      <h3 id="what-is-never-cached">What is never cached</h3>
      <p>Even with <code>revalidate</code> set, these renders are answered but not stored:</p>
      <ul>
        <li>
          A render whose <code>getServerSideProps</code> or <code>generateMetadata</code> read
          the visitor&apos;s cookies, IP, host or scheme, or a credential header - see{' '}
          <a href="/docs/page-exports/get-server-side-props#personalized-renders">personalized renders</a>.
          A warning names the route.
        </li>
        <li>A page whose <code>getServerSideProps</code> returned response <code>headers</code>, or any response that sets a cookie.</li>
        <li>Redirects, 404s and error pages; a render that recovered from an error inside a Suspense boundary.</li>
        <li>Requests other than <code>GET</code> and <code>HEAD</code>, including a page action&apos;s re-render.</li>
        <li>A render an <code>onRequest</code> plugin rewrote (path, query or locale) after reading credentials.</li>
        <li>Everything, with <code>[cache] enabled = false</code>.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-page-that-changes-every-few-minutes">A page that changes every few minutes</h3>
      <CodeBlock lang="tsx" title="app/page.tsx" code={`import type { GetServerSideProps, InferPageProps } from '@gio.js/core';
import { db, type Post } from '../lib/db.server.ts';

export const revalidate = 300;

export const getServerSideProps: GetServerSideProps<{ posts: Post[] }> = async () => {
  return { props: { posts: await db.posts.latest(10) } };
};

export default function Home({ posts }: InferPageProps<typeof getServerSideProps>) {
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}`} />

      <h3 id="cache-until-the-content-changes">Cache until the content changes</h3>
      <p>
        Keep the page until you purge it, and purge it where the data changes:
      </p>
      <CodeBlock lang="tsx" title="app/docs/[slug]/page.tsx" code={`import type { PageProps } from '@gio.js/core';

export const revalidate = false;
export const tags = ['docs'];

export default function Doc({ params }: PageProps<'/docs/:slug'>) {
  return <h1>{params.slug}</h1>;
}`} />
      <CodeBlock lang="ts" title="app/api/cms-webhook/route.ts" code={`import { revalidateTag, type GioRequest } from '@gio.js/core';
import { verifySignature } from '../../../lib/cms.server.ts';

export async function POST(req: GioRequest) {
  await verifySignature(req);
  const result = await revalidateTag('docs');   // { ok, purged }
  return { purged: result.purged };
}`} />

      <h3 id="check-what-the-cache-did">Check what the cache did</h3>
      <CodeBlock lang="bash" code={`curl -sI http://localhost:3000/blog | grep -i -e x-gio-cache -e cache-control
# x-gio-cache: miss; stored
# cache-control: public, max-age=0, s-maxage=60, stale-while-revalidate=540`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Use a whole number of seconds or <code>false</code>. A negative or fractional number,{' '}
          <code>NaN</code>, or a string such as <code>&apos;60&apos;</code> is an error naming
          the file. Written as a literal (<code>export const revalidate = 1.5</code>), it is read
          from the source when the routes are discovered and stops the worker at boot (see{' '}
          <a href="/docs/cli/giojs-server#worker-boot-errors">worker boot errors</a>) and{' '}
          <code>gio build standalone</code>. Any other expression (<code>60 * 60</code>, an
          imported constant) is checked when the page is requested, since page modules load on
          first use: development shows it in the error overlay, production logs it and answers{' '}
          <code>500</code> with a digest.
          <CodeBlock lang="text" code={`app/blog/page.tsx: export const revalidate must be a whole number of seconds (0 or more) or false - got 1.5`} />
        </li>
        <li>
          <code>revalidate</code> is read from <code>page.tsx</code> only. In a{' '}
          <code>layout.tsx</code> or a <code>route.ts</code> it has no effect: route handler
          responses are never cached, so set <code>Cache-Control</code> on the{' '}
          <code>Response</code> for browsers and CDNs.
        </li>
        <li>
          <code>app/sitemap.ts</code>, <code>app/robots.ts</code> and{' '}
          <code>app/manifest.ts</code> also read <code>revalidate</code>. There it defaults to{' '}
          <code>3600</code>, a fraction is rounded down, and <code>0</code> or less turns
          caching off.
        </li>
        <li>
          The cache belongs to one server instance. Behind a load balancer, purge each
          instance (<code>POST /_gio/revalidate</code> on its own address).
        </li>
        <li>
          Data your page reads at runtime (a database, files, <code>.env</code> values) is not
          part of the deployment ID: after changing it, purge.
        </li>
        <li>
          <code>gio export</code> ignores <code>revalidate</code>: every exported page is
          static HTML.
        </li>
        <li>
          Next.js&apos;s <code>dynamic = &apos;force-static&apos;</code> has no effect in GioJS;{' '}
          <code>gio migrate</code> turns it into <code>revalidate = false</code> on pages.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/caching">Caching &amp; Revalidating</a> - the guide</li>
        <li><a href="/docs/caching-layers">Caching layers</a> - the tiers and <code>X-Gio-Cache</code></li>
        <li><a href="/docs/page-exports/tags"><code>tags</code></a> and <a href="/docs/page-exports/shell"><code>shell</code></a></li>
        <li><a href="/docs/functions/revalidate-tag"><code>revalidateTag</code></a>, <a href="/docs/functions/revalidate-path"><code>revalidatePath</code></a></li>
        <li><a href="/docs/configuration/cache"><code>[cache]</code></a> and <a href="/docs/configuration/revalidate"><code>[revalidate]</code></a> in gio.toml</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>An invalid value (negative, fractional, a string, <code>NaN</code>) stops the worker at boot when written as a literal, and is a render error naming the file otherwise; it used to answer a bare <code>500</code> because the server could not parse the response. Cached pages send <code>Cache-Control</code> and a weak <code>ETag</code>; renders that read credentials, set cookies or return headers are no longer stored; purges with <code>revalidateTag()</code>, <code>revalidatePath()</code> and <code>POST /_gio/revalidate</code>.</> },
        { version: 'v0.1.0-beta.1', changes: 'Introduced, with stale-while-revalidate.' },
      ]} />
    </>
  );
}
