import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'revalidatePath',
  description:
    'Purge the cached page at a URL path - or everything below it - from server code, so the next request renders it fresh.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>revalidatePath</h1>
      <p className="page-subtitle">
        Purge the cached page at a URL path - or everything below it - from server code, so
        the next request renders it fresh.
      </p>
      <CodeBlock lang="ts" code={`import { revalidatePath } from '@gio.js/core';

await revalidatePath('/blog/hello-world');
await revalidatePath('/blog', { type: 'prefix' });`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'path',
          type: 'string',
          required: true,
          description: (
            <>
              The URL path the page is served at, starting with <code>/</code>. Decoded (
              <code>/blog/café</code>) and percent-encoded (<code>/blog/caf%C3%A9</code>)
              spellings purge the same page. A query string or fragment is ignored.
            </>
          ),
        },
        {
          name: 'options.type',
          type: "'page' | 'prefix'",
          default: "'page'",
          description: (
            <>
              <code>&apos;page&apos;</code>: only the page at exactly this path.{' '}
              <code>&apos;prefix&apos;</code>: the path and every page below it, at segment
              boundaries - <code>/blog</code> covers <code>/blog/a</code> but not{' '}
              <code>/blogger</code>.
            </>
          ),
        },
      ]} />

      <h3 id="returns">Returns</h3>
      <p>A <code>{'Promise<RevalidateResult>'}</code>:</p>
      <PropsTable kind="Field" rows={[
        { name: 'ok', type: 'boolean', description: <>True once the server confirmed the purge.</> },
        {
          name: 'purged',
          type: 'number',
          description: (
            <>
              Cache entries removed. Every query-string and locale variant of a page is its
              own entry; <code>0</code> means nothing was cached there.
            </>
          ),
        },
        {
          name: 'error',
          type: 'string | undefined',
          description: <>Why the purge was not confirmed, when <code>ok</code> is false.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The worker sends the purge to the Rust server over its IPC connection, and the
          promise resolves when the server has dropped the entries from memory and disk,
          partial-prerendering shells included. The next request for each page is a cache
          miss: nobody is served the old page while a refresh runs.
        </li>
        <li>
          Every variant of the page goes: all query strings and all locales. A leading locale
          segment in <code>path</code> is dropped, because pages are cached under their
          locale-free path - <code>/fr/about</code> purges <code>/about</code> in every
          locale, and a bare <code>/fr</code> prefix purges the whole site.
        </li>
        <li>
          The path is the one the page renders at, after any rewrite rule.
        </li>
        <li>
          A render that was already running when the purge landed still answers the requests
          waiting for it, but its result is not stored: it may have read the old data.
        </li>
        <li>
          It never throws for a purge that could not be confirmed. After 5 seconds without
          the server&apos;s answer, or when the connection drops, it resolves{' '}
          <code>{'{ ok: false, purged: 0, error }'}</code> and logs a warning, so a write that
          already succeeded is not failed over its cache refresh.
        </li>
        <li>
          Calls run at most 16 at a time per worker; the rest wait their turn within the same
          5 seconds, so <code>Promise.all</code> over many paths is safe.
        </li>
      </ul>

      <h3 id="errors">Errors</h3>
      <p>
        An invalid argument is a programming error: the promise rejects with a{' '}
        <code>TypeError</code> naming the path and the problem, and nothing is sent.
      </p>
      <ul>
        <li>The path does not start with <code>/</code>, or is not a string.</li>
        <li>It is longer than 2048 bytes, or contains a control character or an unpaired UTF-16 surrogate.</li>
        <li>A <code>%</code> that does not start an escape (write a literal <code>%</code> as <code>%25</code>).</li>
        <li>A <code>.</code> or <code>..</code> segment.</li>
        <li>A path under <code>/_gio</code>, which is the server&apos;s own and never cached.</li>
        <li><code>type</code> other than <code>&apos;page&apos;</code> or <code>&apos;prefix&apos;</code>.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="after-an-update-in-a-route-handler">After an update in a route handler</h3>
      <CodeBlock lang="ts" title="app/api/posts/[id]/route.ts" code={`import { notFound, revalidatePath, type GioRequest } from '@gio.js/core';

export async function PUT(req: GioRequest<'/api/posts/:id'>) {
  const { title } = req.json<{ title: string }>();
  const post = await db.posts.update(req.params.id, title);
  if (post === null) notFound();
  await revalidatePath(\`/blog/\${post.slug}\`);   // the post itself
  await revalidatePath('/');                     // the home page lists it
  return post;
}`} />
      <h3 id="after-a-page-action">After a page action</h3>
      <CodeBlock lang="tsx" title="app/admin/menu/page.tsx" code={`import { redirect, revalidatePath, type ActionArgs } from '@gio.js/core';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  await db.menu.save(String(form.get('items')));
  // Every page under /menu shows the menu.
  const result = await revalidatePath('/menu', { type: 'prefix' });
  if (!result.ok) console.warn('menu cache not purged:', result.error);
  return redirect('/admin/menu');
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>One server instance.</strong> The cache belongs to the server the worker
          runs behind. With several instances, call{' '}
          <code>POST /_gio/revalidate</code> on each of the others (see{' '}
          <a href="/docs/caching#from-outside-post-giorevalidate">Caching</a>).
        </li>
        <li>
          <strong>Outside the server</strong> - <code>gio export</code>,{' '}
          <code>renderPage</code>/<code>callRoute</code> in unit tests - there is no cache:
          it resolves <code>{"{ ok: false, error: 'not running behind the GioJS server' }"}</code>{' '}
          and warns once per process.
        </li>
        <li>
          <strong>Uncached pages need nothing.</strong> Only pages that export{' '}
          <code>revalidate</code> are stored; a page that renders on every request is always
          fresh.
        </li>
        <li>
          <strong>Many pages, one tag.</strong> When one change affects pages at unrelated
          paths, tag them and use <a href="/docs/functions/revalidate-tag">revalidateTag</a>{' '}
          instead of listing paths.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/caching#revalidatetag-and-revalidatepath">Caching &amp; Revalidating</a></li>
        <li><a href="/docs/functions/revalidate-tag">revalidateTag</a></li>
        <li><a href="/docs/page-exports/revalidate">export const revalidate</a></li>
        <li><a href="/docs/configuration/revalidate">[revalidate]</a> - the token for <code>POST /_gio/revalidate</code></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
