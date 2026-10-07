import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'revalidateTag',
  description:
    'Purge every cached page that carries a cache tag, from server code, so the next request for each renders fresh.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>revalidateTag</h1>
      <p className="page-subtitle">
        Purge every cached page that carries a cache tag, from server code, so the next
        request for each renders fresh.
      </p>
      <CodeBlock lang="ts" code={`import { revalidateTag } from '@gio.js/core';

await revalidateTag('posts');`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'tag',
          type: 'string',
          required: true,
          description: (
            <>
              A tag pages declared with <code>{"export const tags = ['posts']"}</code> or
              returned from <code>getServerSideProps</code> as{' '}
              <code>{"{ props, tags: ['post:42'] }"}</code>.
            </>
          ),
        },
      ]} />

      <h3 id="returns">Returns</h3>
      <p>
        A <code>{'Promise<RevalidateResult>'}</code>: <code>{'{ ok, purged, error? }'}</code>,
        the same as <a href="/docs/functions/revalidate-path#returns">revalidatePath</a>.{' '}
        <code>purged</code> counts the cache entries removed - each query-string and locale
        variant of a page is one entry.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Every cached page stored under the tag is dropped from memory and disk, PPR shells
          included, and the promise resolves once the server confirms it. The next request
          for each of those pages renders fresh.
        </li>
        <li>
          A page is stored under the tags of the render that produced it: its{' '}
          <code>export const tags</code> plus the <code>tags</code> its{' '}
          <code>getServerSideProps</code> returned for that render.
        </li>
        <li>
          Unconfirmed purges resolve <code>{'{ ok: false, purged: 0, error }'}</code> after 5
          seconds (or when the server connection drops) and log a warning - they never throw.
          At most 16 calls are in flight per worker; the rest wait their turn.
        </li>
      </ul>

      <h3 id="tag-rules">Tag rules</h3>
      <p>
        The same rules apply to the tags pages declare. <code>revalidateTag()</code> rejects
        with a <code>TypeError</code> for a tag that breaks one; a page&apos;s invalid tags are
        dropped with a warning (logged once per route and problem) instead of failing the
        render.
      </p>
      <ul>
        <li>A non-empty string of at most 256 bytes (UTF-8).</li>
        <li>No control characters and no unpaired UTF-16 surrogates.</li>
        <li>Not starting with <code>_gio:</code> - that prefix is the server&apos;s own (it tags every page with its path, for <code>revalidatePath</code>).</li>
        <li>A page keeps at most 64 tags; duplicates count once, and the rest are dropped with a warning.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="tag-a-list-and-its-items">Tag a list and its items</h3>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import { notFound, type GetServerSideProps, type InferPageProps } from '@gio.js/core';

export const revalidate = 60;
export const tags = ['posts'];          // every render of this page

export const getServerSideProps = (async (ctx) => {
  const post = await db.posts.find(ctx.params.id);
  if (post === null) notFound();
  return { props: { post }, tags: [\`post:\${post.id}\`] };   // this render only
}) satisfies GetServerSideProps<{ post: Post }, '/posts/:id'>;

export default function PostPage({ post }: InferPageProps<typeof getServerSideProps>) {
  return <article><h1>{post.title}</h1></article>;
}`} />
      <CodeBlock lang="ts" title="app/api/posts/[id]/route.ts" code={`import { notFound, revalidateTag, type GioRequest } from '@gio.js/core';

export async function PUT(req: GioRequest<'/api/posts/:id'>) {
  const { title } = req.json<{ title: string }>();
  const post = await db.posts.update(req.params.id, title);
  if (post === null) notFound();
  const result = await revalidateTag(\`post:\${post.id}\`);
  return { post, purged: result.purged };
}`} />
      <p>
        With <code>/posts/1</code> cached, the <code>PUT</code> answers{' '}
        <code>{'"purged": 1'}</code>, and the next <code>GET /posts/1</code> is a{' '}
        <code>miss</code> in <code>X-Gio-Cache</code> that shows the new title.
      </p>
      <h3 id="purge-a-batch">Purge a batch</h3>
      <CodeBlock lang="ts" code={`const results = await Promise.all(changedIds.map((id) => revalidateTag(\`post:\${id}\`)));
const failed = results.filter((r) => !r.ok);`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Tags apply to cached pages only</strong> - pages with{' '}
          <code>revalidate</code> set. A personalized render (one that read cookies, or sent
          its own <code>set-cookie</code>) is never stored, so it carries no tags.{' '}
          <code>renderPage()</code> in tests shows the tags a render would be stored under in{' '}
          <code>cacheTags</code>.
        </li>
        <li>
          <strong>One server instance.</strong> Other instances need{' '}
          <code>POST /_gio/revalidate</code> with <code>{'{ "tags": [...] }'}</code> - see{' '}
          <a href="/docs/caching#from-outside-post-giorevalidate">Caching</a>.
        </li>
        <li>
          <strong>Outside the server</strong> (<code>gio export</code>, unit tests) it
          resolves <code>ok: false</code> and warns once.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/caching#tagging-pages">Caching: Tagging pages</a></li>
        <li><a href="/docs/page-exports/tags">export const tags</a></li>
        <li><a href="/docs/functions/revalidate-path">revalidatePath</a></li>
        <li><a href="/docs/functions/render-page">renderPage</a> - assert a page&apos;s <code>cacheTags</code></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
