import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Linking & Navigating</h1>
      <p className="page-subtitle">Client-side navigation with hover-intent prefetch and view transitions.</p>
      <p>Use GioLink for internal navigation. It prefetches on hover intent and swaps content without a full reload.</p>
      <CodeBlock lang="tsx" code={`import { GioLink } from '@gio.js/react';

<GioLink href="/about">About</GioLink>
<GioLink href="/posts/1" prefetch="viewport">First post</GioLink>`} />
      <h2>View transitions</h2>
      <p>Set a transition preset to animate between pages using the View Transitions API.</p>
      <CodeBlock lang="tsx" code={`<GioLink href="/about" transition="fade">About</GioLink>`} />
      <div className="callout">Prefetching is budgeted by the Rust prefetch manager, so a page full of links will not flood your server.</div>
    </>
  );
}
