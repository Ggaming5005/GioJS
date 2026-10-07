import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Private Folders',
  description:
    'A folder under app/ whose name starts with an underscore is never routed, so components and helpers can live next to the routes that use them.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Private Folders</h1>
      <p className="page-subtitle">
        A folder under <code>app/</code> whose name starts with an underscore is never routed,
        so components and helpers can live next to the routes that use them.
      </p>
      <CodeBlock lang="text" code={`app/
  blog/
    _components/
      PostCard.tsx      # imported by blog/page.tsx, never a URL
      page.tsx          # ignored: no /blog/_components route
    _lib/
      format-date.ts
    page.tsx            # /blog`} />

      <h2 id="reference">Reference</h2>
      <h3 id="convention">Convention</h3>
      <p>
        Any folder whose name begins with <code>_</code>, at any depth:{' '}
        <code>_components</code>, <code>_lib</code>, <code>_utils</code>.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Route discovery skips the folder and everything below it. Nothing inside becomes a
          page, a <code>route.ts</code> handler, a layout, or a <code>loading</code>,{' '}
          <code>error</code> or <code>not-found</code> file, even if it has one of those
          names.
        </li>
        <li>
          Its modules work like any other module: pages, layouts and route handlers import
          them normally.
        </li>
        <li>
          <code>gio routes</code> and <code>.gio/routes.d.ts</code> leave them out.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="colocate-a-component">Colocate a component</h3>
      <CodeBlock lang="tsx" title="app/blog/_components/PostCard.tsx" code={`import React from 'react';
import { GioLink } from '@gio.js/react';

export function PostCard({ slug, title }: { slug: string; title: string }) {
  return (
    <GioLink href={\`/blog/\${slug}\`} className="post-card">
      {title}
    </GioLink>
  );
}`} />
      <CodeBlock lang="tsx" title="app/blog/page.tsx" code={`import React from 'react';
import { PostCard } from './_components/PostCard';

const POSTS = [
  { slug: 'hello-world', title: 'Hello, world' },
  { slug: 'routing', title: 'How routing works' },
];

export default function Blog() {
  return (
    <ul>
      {POSTS.map((post) => (
        <li key={post.slug}>
          <PostCard {...post} />
        </li>
      ))}
    </ul>
  );
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A folder is enough to keep a file out of routing only for the special names: a{' '}
          <code>Button.tsx</code> next to a <code>page.tsx</code> is never a route anyway.
          Private folders are for grouping, and for keeping a file named{' '}
          <code>page.tsx</code> or <code>route.ts</code> from being routed.
        </li>
        <li>
          No URL segment can start with <code>_</code> through a folder name. When you need
          one, answer it with a <a href="/docs/configuration/rewrites">rewrite</a> to a route
          without the underscore.
        </li>
        <li>
          The rule also keeps app routes out of <code>/_gio</code>, which the server reserves
          for its own endpoints.
        </li>
        <li>
          Plain <code>.css</code> files in a private folder are still served by their path (
          <code>app/_styles/x.css</code> at <code>/_styles/x.css</code>) unless{' '}
          <code>[css] enabled = false</code>. See{' '}
          <a href="/docs/file-conventions/css">CSS files</a>.
        </li>
        <li>
          Files in private folders are part of <code>app/</code>, so in development editing
          them restarts the worker like any other change there.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/layouts-and-pages#private-folders">Layouts &amp; Pages: Private folders</a></li>
        <li><a href="/docs/file-conventions/route-groups">Route Groups</a>, <a href="/docs/project-structure">Project Structure</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: <code>_private</code> folders are never routed.</> },
      ]} />
    </>
  );
}
