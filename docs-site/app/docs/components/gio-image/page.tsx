import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '<GioImage>',
  description:
    'An <img> served through the built-in image optimizer, with a srcset of the widths gio.toml allows, lazy loading, and a preload for the hero image.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>&lt;GioImage&gt;</h1>
      <p className="page-subtitle">
        An <code>&lt;img&gt;</code> served through the built-in image optimizer, with a{' '}
        <code>srcset</code> of the widths <code>gio.toml</code> allows, lazy loading, and a
        preload for the hero image.
      </p>
      <CodeBlock lang="tsx" title="app/page.tsx" code={`import { GioImage } from '@gio.js/react';

export default function Home() {
  // public/hero.jpg, served at /hero.jpg
  return <GioImage src="/hero.jpg" alt="The harbor at dawn" width={1200} height={630} priority />;
}`} />
      <p>
        The Rust server resizes and re-encodes the image on its first request at{' '}
        <code>/_gio/image</code> (AVIF or WebP when the browser accepts them) and caches the
        result. <code>GioImage</code> builds the URLs; how the optimizer works is in{' '}
        <a href="/docs/image-optimization">Image Optimization</a>.
      </p>

      <h2 id="reference">Reference</h2>
      <PropsTable rows={[
        {
          name: 'src',
          type: 'string',
          required: true,
          description: <>A file in <code>public/</code> (<code>/hero.jpg</code> or <code>/public/hero.jpg</code>), or a remote URL that <code>[[images.remote_patterns]]</code> allows.</>,
        },
        {
          name: 'alt',
          type: 'string',
          required: true,
          description: <>The text alternative. Use <code>&quot;&quot;</code> for a decorative image.</>,
        },
        {
          name: 'width',
          type: 'number',
          required: true,
          description: <>The rendered width in CSS pixels. Sets the <code>width</code> attribute and picks the <code>1x</code>/<code>2x</code> candidates. Not used with <code>fill</code>.</>,
        },
        {
          name: 'height',
          type: 'number',
          required: true,
          description: <>The rendered height in CSS pixels, for the <code>height</code> attribute, so the browser reserves the space before the image loads. Not used with <code>fill</code>.</>,
        },
        {
          name: 'priority',
          type: 'boolean',
          default: 'false',
          description: <>Load eagerly with <code>fetchpriority=&quot;high&quot;</code> and preload the image in the document head. For the largest image above the fold.</>,
        },
        {
          name: 'quality',
          type: 'number',
          default: '[images] quality (75)',
          description: <>Encoder quality, rounded and clamped to 1-100.</>,
        },
        {
          name: 'sizes',
          type: 'string',
          description: <>How wide the image renders per breakpoint (<code>&quot;(max-width: 768px) 100vw, 50vw&quot;</code>). Switches the <code>srcset</code> to every allowed width.</>,
        },
        {
          name: 'fill',
          type: 'boolean',
          default: 'false',
          description: <>Fill the parent: no <code>width</code>/<code>height</code> attributes, <code>width: 100%; height: 100%; object-fit: cover</code>, and <code>sizes</code> defaulting to <code>100vw</code>.</>,
        },
        {
          name: 'placeholder',
          type: "'blur' | 'empty'",
          description: <>With <code>&apos;blur&apos;</code> and a <code>blurDataURL</code>, show that image behind this one while it loads. <code>&apos;empty&apos;</code> or no value shows nothing.</>,
        },
        {
          name: 'blurDataURL',
          type: 'string',
          description: <>The placeholder image, usually a tiny base64 <code>data:</code> URL. Used only with <code>placeholder=&quot;blur&quot;</code>.</>,
        },
        {
          name: 'unoptimized',
          type: 'boolean',
          default: 'false',
          description: <>Skip the optimizer and render <code>src</code> as is.</>,
        },
        {
          name: 'className',
          type: 'string',
          description: <>Passed to the <code>&lt;img&gt;</code>.</>,
        },
      ]} />
      <p>
        <code>GioImage</code> takes only these props: <code>id</code>, <code>style</code>,{' '}
        <code>onLoad</code>, <code>decoding</code> and other <code>&lt;img&gt;</code> attributes
        are not forwarded. Style it through <code>className</code>.
      </p>

      <h3 id="how-the-srcset-is-built">How the srcset is built</h3>
      <p>
        Every URL is <code>/_gio/image?src=&lt;encoded src&gt;&amp;w=&lt;width&gt;&amp;q=&lt;quality&gt;</code>.
        The optimizer answers <code>400</code> for any width outside{' '}
        <code>[images] allowed_widths</code>, so the widths come from exactly that list - the
        server hands it to the renderer, and the page carries it to the browser, so the hydrated
        markup matches the server&apos;s.
      </p>
      <ul>
        <li>
          <strong>Fixed size</strong> (no <code>sizes</code>, no <code>fill</code>): a{' '}
          <code>1x</code> candidate at the smallest allowed width that covers{' '}
          <code>width</code>, and a <code>2x</code> one covering twice that (left out when it is
          the same width). <code>src</code> is the <code>2x</code> URL. A width above every
          allowed width uses the largest.
        </li>
        <li>
          <strong>With <code>sizes</code> or <code>fill</code></strong>: every allowed width as a{' '}
          <code>w</code> descriptor, <code>src</code> at the largest, and the{' '}
          <code>sizes</code> attribute (<code>100vw</code> when only <code>fill</code> is set).
          The browser picks by layout width and screen density.
        </li>
        <li>
          An empty <code>allowed_widths</code> list, or a <code>width</code> of <code>0</code>{' '}
          without <code>sizes</code>, requests no width at all: one URL, converted but not
          resized.
        </li>
      </ul>
      <p>
        With the default <code>allowed_widths</code>,{' '}
        <code>{'<GioImage src="/hero.png" alt="Hero" width={400} height={300} />'}</code>{' '}
        renders (line breaks added):
      </p>
      <CodeBlock lang="text" code={`<img src="/_gio/image?src=%2Fhero.png&amp;w=828&amp;q=75"
     srcSet="/_gio/image?src=%2Fhero.png&amp;w=640&amp;q=75 1x, /_gio/image?src=%2Fhero.png&amp;w=828&amp;q=75 2x"
     width="400" height="300" alt="Hero" loading="lazy"/>`} />

      <h3 id="plain-src">Plain src</h3>
      <p>
        <code>GioImage</code> renders <code>src</code> untouched, with no <code>srcset</code>,
        when:
      </p>
      <ul>
        <li><code>unoptimized</code> is set;</li>
        <li>the source is an SVG (a path ending in <code>.svg</code>, any case, before <code>?</code> or <code>#</code>), a <code>data:</code> URL or a <code>blob:</code> URL;</li>
        <li>the page comes from <code>gio export</code> - a static host has no optimizer;</li>
        <li><code>gio.toml</code> turns the optimizer off with <code>[images] enabled = false</code> (<code>/_gio/image</code> then answers <code>404</code>).</li>
      </ul>

      <h3 id="placeholder"><code>placeholder</code> and <code>blurDataURL</code></h3>
      <p>
        <code>placeholder=&quot;blur&quot;</code> with a <code>blurDataURL</code> sets that URL as
        the <code>&lt;img&gt;</code>&apos;s CSS background (<code>background-size: cover</code>),
        so a blurred preview fills the box until the real image paints over it. GioJS does not
        generate the preview: produce a tiny image (10-20 pixels wide) when you store the
        original, and pass it as a base64 <code>data:</code> URL. Without a{' '}
        <code>blurDataURL</code>, <code>placeholder=&quot;blur&quot;</code> does nothing.
      </p>

      <h3 id="priority"><code>priority</code></h3>
      <p>
        A <code>priority</code> image renders with <code>loading=&quot;eager&quot;</code> and{' '}
        <code>fetchpriority=&quot;high&quot;</code>, and React&apos;s server renderer adds a{' '}
        <code>&lt;link rel=&quot;preload&quot; as=&quot;image&quot;&gt;</code> with the same{' '}
        <code>imagesrcset</code> and <code>imagesizes</code> to the head, so the browser starts
        the download before it reaches the <code>&lt;img&gt;</code>. Every other image is{' '}
        <code>loading=&quot;lazy&quot;</code>.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="a-responsive-hero-image">A responsive hero image</h3>
      <CodeBlock lang="tsx" title="app/page.tsx" code={`import { GioImage } from '@gio.js/react';

export default function Home() {
  return (
    <GioImage
      src="/hero.jpg"
      alt="The harbor at dawn"
      width={1600}
      height={900}
      sizes="(max-width: 768px) 100vw, 60vw"
      priority
    />
  );
}`} />

      <h3 id="filling-a-container">Filling a container</h3>
      <p>
        With <code>fill</code> the parent decides the size. <code>GioImage</code> sets no
        positioning, so give the parent a size, for example with <code>aspect-ratio</code>.
      </p>
      <CodeBlock lang="tsx" title="app/blog/[slug]/cover.tsx" code={`import { GioImage } from '@gio.js/react';
import styles from './cover.module.css';

export function Cover({ src, alt }: { src: string; alt: string }) {
  return (
    <div className={styles.cover}>
      <GioImage src={src} alt={alt} width={0} height={0} fill sizes="(max-width: 960px) 100vw, 960px" />
    </div>
  );
}`} />
      <CodeBlock lang="css" title="app/blog/[slug]/cover.module.css" code={`.cover {
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 12px;
}`} />

      <h3 id="a-blurred-preview">A blurred preview</h3>
      <CodeBlock lang="tsx" title="app/gallery/[id]/page.tsx" code={`import { GioImage } from '@gio.js/react';

interface Photo {
  url: string;
  alt: string;
  width: number;
  height: number;
  preview: string; // 'data:image/webp;base64,...', made when the photo was uploaded
}

export default function PhotoPage({ photo }: { photo: Photo }) {
  return (
    <GioImage
      src={photo.url}
      alt={photo.alt}
      width={photo.width}
      height={photo.height}
      sizes="100vw"
      placeholder="blur"
      blurDataURL={photo.preview}
    />
  );
}`} />

      <h3 id="a-remote-image">A remote image</h3>
      <p>Allow the host in <code>gio.toml</code>; anything not on the list is refused.</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[images.remote_patterns]]
protocol = "https"
hostname = "images.example.com"
pathname = "/uploads/*"`} />
      <CodeBlock lang="tsx" code={`<GioImage src="https://images.example.com/uploads/team.jpg" alt="The team" width={800} height={533} />`} />

      <h3 id="an-animated-gif">An animated GIF</h3>
      <CodeBlock lang="tsx" code={`<GioImage src="/loading.gif" alt="" width={64} height={64} unoptimized />`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The blur preview stays behind the image after it loads: transparent areas of a PNG or
          WebP show it. Use <code>placeholder=&quot;blur&quot;</code> for opaque photos.
        </li>
        <li>
          <code>fill</code> and <code>placeholder=&quot;blur&quot;</code> render a{' '}
          <code>style</code> attribute. Under a <a href="/docs/guides/content-security-policy">Content Security Policy</a>,{' '}
          <code>style-src</code> must allow <code>&apos;unsafe-inline&apos;</code> for them.
        </li>
        <li>
          The optimizer caches each width under a name that ignores the source&apos;s content:
          replacing <code>public/hero.jpg</code> keeps serving the old resized copies. Give a
          changed image a new file name.
        </li>
        <li>
          A <code>quality</code> per image adds new URLs to the optimizer&apos;s cache; keep to
          a few values.
        </li>
        <li>
          Prefer pre-sized files in a <a href="/docs/static-export">static export</a>: every
          image is served as is.
        </li>
        <li>
          Path traversal, redirects on remote sources and guard checks on <code>public/</code>{' '}
          files are enforced by the optimizer and cannot be turned off; the size and time limits
          can (see <a href="/docs/configuration/images"><code>[images]</code></a>).
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/image-optimization">Image Optimization</a> - formats, caching, remote images and limits.</li>
        <li><a href="/docs/configuration/images"><code>[images]</code></a> - <code>allowed_widths</code>, <code>quality</code>, <code>formats</code>, <code>enabled</code>.</li>
        <li><a href="/docs/file-conventions/public-folder"><code>public</code> folder</a> - where local images live.</li>
        <li><a href="/docs/static-export">Static Export</a> - images without a server.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Requests only the widths in <code>[images] allowed_widths</code>, with <code>[images] quality</code> as the default. <code>priority</code> preloads the image. Added <code>unoptimized</code>; SVG, <code>data:</code> and <code>blob:</code> sources, static exports and <code>[images] enabled = false</code> render the plain <code>src</code>.</>,
        },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
