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
      <p>Client-side navigation with hover-intent prefetch and optional view transitions. See <a href="/docs/linking-and-navigating">Linking &amp; Navigating</a>.</p>
      <CodeBlock lang="tsx" code={`<GioLink href="/about" prefetch="hover" transition="fade">About</GioLink>`} />
      <table>
        <thead><tr><th>Prop</th><th>Default</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>href</code></td><td>-</td><td>A path (<code>/about</code>, or built with <code>href()</code>) or a same-page <code>#hash</code>. Other hrefs are plain links.</td></tr>
          <tr><td><code>prefetch</code></td><td><code>&quot;hover&quot;</code></td><td><code>&quot;hover&quot;</code>, <code>&quot;viewport&quot;</code> or <code>false</code>.</td></tr>
          <tr><td><code>replace</code></td><td><code>false</code></td><td>Replace the current history entry instead of adding one.</td></tr>
          <tr><td><code>scroll</code></td><td><code>true</code></td><td>Scroll to the top (or the <code>#hash</code> target) after navigating; <code>false</code> keeps the position.</td></tr>
          <tr><td><code>transition</code></td><td><code>false</code></td><td>View transition preset: <code>fade</code>, <code>slide-left</code>, <code>slide-up</code>, <code>scale</code>.</td></tr>
        </tbody>
      </table>
      <p>
        <code>className</code>, <code>target</code>, <code>download</code> and{' '}
        <code>aria-current</code> pass through to the <code>&lt;a&gt;</code>. Clicks with a
        modifier key, a non-left button, a <code>target</code> or <code>download</code> are
        left to the browser.
      </p>
      <h2>LocaleLink</h2>
      <p>
        A GioLink that prefixes <code>href</code> with the current locale when it is not{' '}
        <code>defaultLocale</code> (default <code>&quot;en&quot;</code>). The locale comes from{' '}
        <code>useLocale()</code>, so the prefixed href is already in the server HTML.
      </p>
      <CodeBlock lang="tsx" code={`<LocaleLink href="/pricing" defaultLocale="en">Pricing</LocaleLink>   // /fr/pricing on a French page`} />
      <h2>GioImage</h2>
      <p>Optimized images via the Rust /_gio/image endpoint, with a srcset built from gio.toml&apos;s [images] allowed_widths. Requires width and height; takes sizes, fill, quality, priority (preloads the image) and unoptimized (plain src - also automatic in a static export). See <a href="/docs/image-optimization">Image Optimization</a>.</p>
      <CodeBlock lang="tsx" code={`<GioImage src="/photo.jpg" alt="" width={800} height={600} priority />`} />
      <h2>GioFont</h2>
      <p>Self-hosts a font and injects preload + stylesheet links.</p>
    </>
  );
}
