import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Linking & Navigating</h1>
      <p className="page-subtitle">Client-side navigation with hover-intent prefetch and view transitions.</p>
      <p>Use GioLink for internal navigation. It prefetches on hover intent by default and swaps content without a full reload. Set <code>prefetch=&quot;viewport&quot;</code> to instead prefetch once when the link scrolls into view (via IntersectionObserver), or <code>prefetch={'{false}'}</code> to disable prefetching.</p>
      <CodeBlock lang="tsx" code={`import { GioLink } from '@gio.js/react';

<GioLink href="/about">About</GioLink>
<GioLink href="/posts/1" prefetch="viewport">First post</GioLink>`} />
      <h2>View transitions</h2>
      <p>Set a transition preset to animate between pages using the View Transitions API.</p>
      <CodeBlock lang="tsx" code={`<GioLink href="/about" transition="fade">About</GioLink>`} />
      <div className="callout">Prefetching is budgeted by the Rust prefetch manager, so a page full of links will not flood your server.</div>
      <h2>Typed routes</h2>
      <p>
        The <code>href()</code> helper builds URLs from your route patterns with full
        type checking. At every server start GioJS generates{' '}
        <code>.gio/routes.d.ts</code> from the discovered routes; the file augments{' '}
        <code>@gio.js/react</code> (its <code>GioRegisteredRoutes</code> interface, via
        declaration merging), so patterns autocomplete and params typecheck with zero
        annotations in your code.
      </p>
      <CodeBlock lang="tsx" code={`import { GioLink, href } from '@gio.js/react';

// '/posts/:id' autocompletes from your app/ directory.
// A wrong pattern or a missing/misspelled param is a type error.
<GioLink href={href('/posts/:id', { id: post.id })}>{post.title}</GioLink>

href('/about');                        // static routes take no params
href('/docs/*rest', { rest: 'a/b' });  // catch-all keeps its slashes`} />
      <p>
        Param values are URL-encoded per segment (a catch-all value keeps its{' '}
        <code>/</code> separators). Projects scaffolded by <code>create-giojs</code>{' '}
        already include the generated file in their tsconfig; in an existing project,
        add <code>&quot;.gio/routes.d.ts&quot;</code> to the <code>include</code> array
        of <code>tsconfig.json</code>.</p>
    </>
  );
}
