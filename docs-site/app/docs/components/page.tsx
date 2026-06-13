import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">API Reference</div>
      <h1>Components</h1>
      <p className="page-subtitle">The React components exported from @gio.js/react.</p>
      <h2>GioLink</h2>
      <p>Client-side navigation with hover-intent prefetch and optional view transitions.</p>
      <CodeBlock lang="tsx" code={`<GioLink href="/about" prefetch="hover" transition="fade">About</GioLink>`} />
      <h2>GioImage</h2>
      <p>Optimized images via the Rust /_gio/image endpoint. Requires width and height.</p>
      <CodeBlock lang="tsx" code={`<GioImage src="/public/photo.jpg" alt="" width={800} height={600} priority />`} />
      <h2>GioFont</h2>
      <p>Self-hosts a font and injects preload + stylesheet links.</p>
    </>
  );
}
