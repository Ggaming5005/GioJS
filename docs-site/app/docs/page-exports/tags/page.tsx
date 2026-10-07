import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'tags',
  description: 'Label the cached renders of a page, so revalidateTag() can purge every page that shows some data.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>tags</h1>
      <p className="page-subtitle">
        Label the cached renders of a page, so <code>revalidateTag()</code> can purge every
        page that shows some data.
      </p>
      <CodeBlock lang="tsx" title="app/posts/page.tsx" code={`export const revalidate = 3600;
export const tags = ['posts'];          // await revalidateTag('posts') purges this page`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        { name: 'tags', type: 'readonly string[]', default: '[]', description: <>Cache tags stored with every cached render of the page. <code>getServerSideProps</code> can add more per render by returning <code>{'{ props, tags }'}</code>.</> },
      ]} />

      <h3 id="rules">Rules</h3>
      <ul>
        <li>A tag is a non-empty string of at most 256 bytes (UTF-8), without control characters, and well-formed Unicode (no unpaired surrogate).</li>
        <li>Tags starting with <code>_gio:</code> are reserved for the server&apos;s own per-path tag.</li>
        <li>
          A render keeps at most 64 tags: the static ones first, then those{' '}
          <code>getServerSideProps</code> returned. Duplicates are dropped.
        </li>
        <li>
          An invalid tag, a <code>tags</code> value that is not an array, or a tag past the
          64th is ignored with a warning (once per route and problem), such as{' '}
          <code>cache tags ignored: export const tags: tags must not be empty</code>. The page
          still renders and is still cached, with its valid tags.
        </li>
      </ul>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Tags are stored only with a render the server caches: a page with{' '}
          <code>revalidate</code> whose render is shareable. On an uncached page they are
          not read at all.
        </li>
        <li>
          <code>revalidateTag(tag)</code> from server code, or{' '}
          <code>POST /_gio/revalidate</code> with <code>{'{ "tags": [...] }'}</code>, purges
          every cached entry carrying the tag - every query string and locale variant, from
          memory and disk, <a href="/docs/page-exports/shell">PPR shells</a> included. The next
          request renders fresh.
        </li>
        <li>
          Every cached page can also be purged by its path with{' '}
          <code>revalidatePath()</code>, with no tag at all.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="tags-from-the-data-a-render-used">Tags from the data a render used</h3>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import { notFound, type GetServerSideProps, type InferPageProps } from '@gio.js/core';
import { db, type Post } from '../../../lib/db.server.ts';

export const revalidate = 3600;
export const tags = ['posts'];

export const getServerSideProps: GetServerSideProps<{ post: Post }, '/posts/:id'> = async (ctx) => {
  const post = await db.posts.find(ctx.params.id);
  if (post === null) notFound();
  return { props: { post }, tags: [\`post:\${post.id}\`, \`author:\${post.authorId}\`] };
};

export default function PostPage({ post }: InferPageProps<typeof getServerSideProps>) {
  return <article><h1>{post.title}</h1><p>{post.body}</p></article>;
}`} />

      <h3 id="purge-after-a-write">Purge after a write</h3>
      <CodeBlock lang="ts" title="app/api/posts/[id]/route.ts" code={`import { revalidateTag, type RouteHandler } from '@gio.js/core';
import { db } from '../../../../lib/db.server.ts';

export const PUT: RouteHandler<'/api/posts/:id'> = async (req) => {
  const post = await db.posts.update(req.params.id, req.json());
  await revalidateTag(\`post:\${post.id}\`);       // this post's page
  await revalidateTag(\`author:\${post.authorId}\`); // pages listing the author's posts
  return post;
};`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Name tags after data, not pages (<code>post:42</code>, <code>author:ada</code>): one
          write can then purge every page that showed it.
        </li>
        <li>
          <code>revalidateTag()</code> with an invalid tag rejects with a{' '}
          <code>TypeError</code>; an invalid tag a page declares is only a warning.
        </li>
        <li>
          Purges reach the server instance whose worker runs them. With several instances,
          call <code>POST /_gio/revalidate</code> on each.
        </li>
        <li><code>tags</code> is read from <code>page.tsx</code> only.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/caching#on-demand-revalidation">On-demand revalidation</a> - the guide</li>
        <li><a href="/docs/functions/revalidate-tag"><code>revalidateTag</code></a> and <a href="/docs/functions/revalidate-path"><code>revalidatePath</code></a></li>
        <li><a href="/docs/page-exports/revalidate"><code>revalidate</code></a></li>
        <li><a href="/docs/page-exports/get-server-side-props#returns"><code>getServerSideProps</code> results</a></li>
        <li><a href="/docs/endpoints"><code>/_gio</code> endpoints</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: 'Introduced.' },
      ]} />
    </>
  );
}
