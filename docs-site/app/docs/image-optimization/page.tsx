import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Image Optimization</h1>
      <p className="page-subtitle">Automatic AVIF/WebP conversion and resizing - no sharp, no CDN.</p>
      <p>Use GioImage. It points at the Rust /_gio/image endpoint, which converts and resizes on demand through an AVIF → WebP → JPEG pipeline with a two-layer cache.</p>
      <CodeBlock lang="tsx" code={`import { GioImage } from '@gio.js/react';

// public/hero.png - served at /hero.png (and /public/hero.png)
<GioImage src="/hero.png" alt="" width={1200} height={630} />`} />

      <h2>Widths and quality come from gio.toml</h2>
      <p>
        The optimizer only resizes to the widths listed in <code>[images] allowed_widths</code>{' '}
        (any other width is a 400), so GioImage builds its <code>srcset</code> from exactly that
        list and uses <code>quality</code> as the default. The server hands both to the renderer,
        and the page carries them to the browser, so the hydrated <code>srcset</code> is
        identical to the server&apos;s.
      </p>
      <CodeBlock lang="toml" code={`[images]
allowed_widths = [640, 828, 1080, 1200, 1920]
quality        = 80`} />
      <ul>
        <li>
          Fixed size (no <code>sizes</code>): a <code>1x</code> and a <code>2x</code> candidate,
          each the smallest allowed width that covers it (with the config above,{' '}
          <code>width={'{500}'}</code> → 640 and 1080).
        </li>
        <li>
          <code>sizes</code> (or <code>fill</code>, which defaults it to <code>100vw</code>): every
          allowed width as a <code>w</code> descriptor; the browser picks by layout width.
        </li>
        <li>
          <code>quality</code> overrides the default per image (clamped to 1-100).
        </li>
      </ul>
      <CodeBlock lang="tsx" code={`<GioImage src="/hero.png" alt="" width={1200} height={630}
  sizes="(max-width: 768px) 100vw, 50vw" />`} />

      <h2>Above the fold: priority</h2>
      <p>
        <code>priority</code> loads the image eagerly with <code>fetchpriority=&quot;high&quot;</code> and
        preloads it: the server render adds a{' '}
        <code>{'<link rel="preload" as="image">'}</code> (with the same <code>imagesrcset</code>/
        <code>imagesizes</code>) to the document head. Use it for the LCP image; everything else
        lazy-loads.
      </p>
      <CodeBlock lang="tsx" code={`<GioImage src="/hero.png" alt="" width={1200} height={630} priority />`} />

      <h2>Plain src</h2>
      <p>
        <code>unoptimized</code> skips the optimizer and renders <code>src</code> as-is. SVGs,{' '}
        <code>data:</code> and <code>blob:</code> URLs always do - there is nothing to resize. In a{' '}
        <a href="/docs/static-export">static export</a> every image renders its plain{' '}
        <code>src</code>: a static host has no <code>/_gio/image</code>, so ship pre-sized files.
      </p>
      <CodeBlock lang="tsx" code={`<GioImage src="/avatar.gif" alt="" width={64} height={64} unoptimized />`} />

      <h2>Remote images</h2>
      <p>Allow remote sources explicitly in gio.toml with remote_patterns - anything not on the allowlist is rejected.</p>
      <CodeBlock lang="toml" code={`[[images.remote_patterns]]
protocol = "https"
hostname = "images.example.com"
pathname = "/uploads/*"`} />
    </>
  );
}
