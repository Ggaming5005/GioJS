import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Caching & Revalidating</h1>
      <p className="page-subtitle">Incremental Static Regeneration with stale-while-revalidate semantics and on-demand purges.</p>
      <p>Export revalidate from a page to control how long its rendered HTML is cached by the Rust layer.</p>
      <CodeBlock lang="tsx" code={`// cache for 60s, then revalidate in the background
export const revalidate = 60;

// cache indefinitely
export const revalidate = false;

// never cache (default)
// (omit the export)`} />
      <h2>How it works</h2>
      <p>Cached pages are served from memory in microseconds. When a page is stale, GioJS serves the stale copy immediately and revalidates in the background - visitors never wait.</p>
      <div className="callout">Cache keys are deployment-ID aware, so a redeploy automatically invalidates stale entries.</div>

      <h2>On-demand revalidation</h2>
      <p>
        <code>revalidate</code> bounds how long a page can be out of date. When you know the
        moment its data changed - a post was published, a price edited in the CMS - purge it
        right away instead. A purge removes the matching pages from the cache (memory and
        disk, <a href="/docs/caching-layers">PPR shells</a> included): the next request for
        each is a miss and renders fresh, so nobody is served the old page after the purge
        returns. That is unlike the stale-while-revalidate refresh, which serves the stale
        copy one more time.
      </p>

      <h3>Tagging pages</h3>
      <p>
        Give a page tags to purge it by. Static tags apply to every render of the page;
        tags returned next to <code>props</code> from <code>getServerSideProps</code> are
        added per render:
      </p>
      <CodeBlock lang="tsx" code={`// app/posts/[id]/page.tsx
export const revalidate = 3600;
export const tags = ['posts'];            // every post page

export async function getServerSideProps(ctx) {
  const post = await db.posts.find(ctx.params.id);
  return {
    props: { post },
    tags: [\`post:\${post.id}\`, \`author:\${post.authorId}\`],
  };
}`} />
      <p>
        A tag is a string of 1-256 bytes without control characters; a render keeps at
        most 64 (duplicates are dropped), and tags starting with <code>_gio:</code> are
        reserved. Invalid tags are ignored with a warning in the log rather than failing the
        render. Tags only matter on pages that are cached (<code>revalidate</code> set).
        Every cached page is also purgeable by its path - no tag needed.
      </p>

      <h3>revalidateTag() and revalidatePath()</h3>
      <p>
        Call them from server code - route handlers, <code>getServerSideProps</code>,
        anything the worker runs - after the data changed:
      </p>
      <CodeBlock lang="ts" code={`// app/api/posts/[id]/route.ts
import { revalidatePath, revalidateTag } from '@gio.js/core';

export async function PUT(req) {
  await db.posts.update(req.params.id, req.json());
  await revalidateTag(\`post:\${req.params.id}\`);     // pages tagged post:<id>
  await revalidatePath('/');                           // the home page
  await revalidatePath('/blog', { type: 'prefix' });   // /blog and everything below it
  return { ok: true };
}`} />
      <ul>
        <li><code>revalidateTag(tag)</code> purges every cached page carrying the tag.</li>
        <li>
          <code>revalidatePath(path)</code> purges the page at that URL path - all of its
          query strings and locales. With <code>{"{ type: 'prefix' }"}</code> it purges the
          path and everything below it, at segment boundaries (<code>/blog</code> covers{' '}
          <code>/blog/a</code>, not <code>/blogger</code>). A query or fragment in the path is
          ignored, and so is a leading locale segment (<code>/fr/about</code> purges{' '}
          <code>/about</code> in every locale). The path is the one the page renders at -
          after any <code>[[rewrites]]</code>.
        </li>
      </ul>
      <p>
        Both resolve once the server confirmed the purge, with{' '}
        <code>{'{ ok: true, purged }'}</code> (the number of cache entries removed - each
        query-string and locale variant counts). If the confirmation does not arrive within
        5 seconds, or the server connection drops, they resolve with <code>ok: false</code>{' '}
        and an <code>error</code>, and log a warning - they do not throw, so a write that
        already succeeded is not failed over its cache refresh. An invalid tag or path is a
        programming error and rejects with a <code>TypeError</code>. Under{' '}
        <code>gio export</code> (and in unit tests) there is no cache to purge: they do
        nothing and warn once.
      </p>
      <p>
        A render that was already running when the purge happened (a cache miss or a
        background refresh) is still answered, but its result is not cached - it may have
        read the old data - so the purge always wins.
      </p>

      <h3>From outside: POST /_gio/revalidate</h3>
      <p>
        External systems - a CMS webhook, a deploy script - purge through an HTTP endpoint.
        It exists only when you configure a token of at least 32 bytes, in the environment
        (wins) or in <code>gio.toml</code>; without one, <code>/_gio/revalidate</code> is a
        404:
      </p>
      <CodeBlock lang="bash" code={`# generate a token
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export GIO_REVALIDATE_TOKEN=<token>     # or [revalidate] token = "..." in gio.toml`} />
      <CodeBlock lang="bash" code={`curl -X POST https://example.com/_gio/revalidate \\
  -H "Authorization: Bearer $GIO_REVALIDATE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "tags": ["post:42"], "paths": ["/blog"], "prefix": true }'
# {"ok":true,"purged":7}`} />
      <p>
        The JSON body takes <code>tags</code> and/or <code>paths</code> (up to 64 each, same
        rules as above) and <code>prefix</code> (<code>true</code> purges every path as a
        prefix). The answer is <code>200</code> with the number of purged entries,{' '}
        <code>400</code> for a malformed body (unknown fields included, so a misspelled{' '}
        <code>tag</code> is an error, not a silent no-op), and <code>401</code> for a
        missing or wrong token. The token is compared in constant time, and a client that
        sends 10 wrong tokens within a minute gets <code>429</code> for the rest of that
        minute - even with the right token (behind a reverse proxy, list it in{' '}
        <code>[server] trusted_proxies</code> so clients are told apart by their own
        address, not the proxy&apos;s). The endpoint is authenticated by its bearer
        token, not by cookies, so the cross-site request checks of{' '}
        <a href="/docs/security">[security.csrf]</a> do not apply to it; call it over HTTPS.
      </p>
      <div className="callout">
        The cache belongs to each server instance - there is no shared cache backend yet.
        With several instances behind a load balancer, call the endpoint on every instance
        (by its own address, not through the balancer); <code>revalidateTag()</code> and{' '}
        <code>revalidatePath()</code> only purge the instance whose worker runs them.
      </div>

      <h2>Personalized pages are never shared</h2>
      <p>
        A cached page is served to everyone, so it must not depend on who is asking. When{' '}
        <code>getServerSideProps</code> reads the visitor&apos;s credentials - any access to{' '}
        <code>ctx.cookies</code>, <code>ctx.ip</code>, <code>ctx.host</code> or{' '}
        <code>ctx.scheme</code>, or reading the <code>cookie</code>,{' '}
        <code>authorization</code>, a client-address (<code>x-forwarded-for</code>,{' '}
        <code>forwarded</code>, <code>x-real-ip</code>) or a host (<code>host</code>,{' '}
        <code>x-forwarded-host</code>, <code>x-forwarded-proto</code>) entry of{' '}
        <code>ctx.headers</code> (including spreading or
        enumerating the headers) - GioJS marks that render personalized and does not cache it,
        even though the page exports <code>revalidate</code>. A warning is logged once per
        route. Headers an <code>onRequest</code> plugin added, changed or removed count as
        credentials too; other headers (<code>accept-language</code>, <code>user-agent</code>, ...) do not.
      </p>
      <p>
        To keep a personalized page fast, either drop <code>revalidate</code> (it renders per
        request, streamed) or cache the shared part with{' '}
        <a href="/docs/caching-layers">partial prerendering</a>:{' '}
        <code>shell = &apos;cache&apos;</code> plus <code>&lt;Suspense&gt;</code> holes for the
        personalized parts.
      </p>
    </>
  );
}
