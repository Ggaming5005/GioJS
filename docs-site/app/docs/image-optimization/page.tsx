import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Image Optimization</h1>
      <p className="page-subtitle">Automatic AVIF/WebP conversion and resizing — no sharp, no CDN.</p>
      <p>Use GioImage. It points at the Rust /_gio/image endpoint, which converts and resizes on demand through an AVIF → WebP → JPEG pipeline with a two-layer cache.</p>
      <CodeBlock lang="tsx" code={`import { GioImage } from '@gio.js/react';

<GioImage src="/public/hero.png" alt="" width={1200} height={630} />`} />
      <h2>Remote images</h2>
      <p>Allow remote sources explicitly in gio.toml with remotePatterns — anything not on the allowlist is rejected.</p>
    </>
  );
}
