import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[images]',
  description:
    'The /_gio/image optimizer behind <GioImage>: widths, quality, output formats, remote sources ' +
    'and the limits on what one image may cost.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[images]</h1>
      <p className="page-subtitle">
        The <code>/_gio/image</code> optimizer behind <code>&lt;GioImage&gt;</code>: widths,
        quality, output formats, remote sources and the limits on what one image may cost.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[images]
allowed_widths = [640, 828, 1080, 1200, 1920]
quality = 80
formats = ["webp"]

[[images.remote_patterns]]
hostname = "images.example.com"
pathname = "/uploads/*"`} />
      <p>
        <a href="/docs/image-optimization">Image Optimization</a> shows how{' '}
        <a href="/docs/components/gio-image"><code>&lt;GioImage&gt;</code></a> uses these settings.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <><code>/_gio/image</code> is a <code>404</code>; <code>&lt;GioImage&gt;</code> renders its plain <code>src</code></>, description: <>Run the optimizer. Turn it off behind an image CDN, or to have no CPU-heavy endpoint: every image is then served as the file it names, at full size, without a <code>srcset</code>.</> },
        { key: 'allowed_widths', type: 'integer[]', default: '[16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]', description: <>The only widths the optimizer resizes to (any other <code>w</code> is a <code>400</code>), and the <code>&lt;GioImage&gt;</code> srcset candidates. Order does not matter; <code>0</code> entries are ignored for srcsets.</> },
        { key: 'quality', type: 'integer', default: '75', description: <>Default output quality, 1 to 100. <code>0</code> is used as 1 and 101 to 255 as 100; a larger number is a startup error (<code>invalid value: integer `300`, expected u8</code>).<code>&lt;GioImage quality&gt;</code> and the <code>q</code> parameter override it per image.</> },
        { key: 'formats', type: 'string[]', default: '["avif", "webp"]', zero: <><code>[]</code>: always JPEG</>, description: <>Modern formats to serve when the browser&apos;s <code>Accept</code> names them, in order of preference: <code>&quot;avif&quot;</code>, <code>&quot;webp&quot;</code> (or <code>&quot;image/avif&quot;</code>, <code>&quot;image/webp&quot;</code>). Everything else gets JPEG. AVIF is several times slower to encode than WebP; leave it out to save CPU.</> },
        { key: 'remote_patterns', type: 'table[]', default: '[]', description: <>Remote sources the optimizer may fetch, one <code>[[images.remote_patterns]]</code> table each (keys below). None by default: a remote <code>src</code> is a <code>403</code>.</> },
        { key: 'disk_max_bytes', type: 'integer', default: '536870912', zero: <>No size bound</>, description: <>Size cap of the optimized-image disk cache (512 MiB) under <code>.gio/cache/images</code>; past it the oldest files are deleted. <code>GIO_IMAGE_CACHE_DIR</code> moves the directory.</> },
        { key: 'max_remote_bytes', type: 'integer', default: '20971520', zero: <>Unlimited. Warns.</>, description: <>Largest remote source downloaded, in bytes (20 MiB). A bigger one is a <code>400</code>.</> },
        { key: 'remote_timeout_secs', type: 'integer', default: '30', zero: <>No deadline. Warns.</>, description: <>Deadline for downloading a whole remote source. The 5-second connect timeout applies either way.</> },
        { key: 'max_source_dimension', type: 'integer', default: '10000', zero: <>Unlimited. Warns.</>, description: <>Largest source width or height decoded, in pixels. A larger source is a <code>500</code>: a small file can declare huge dimensions.</> },
        { key: 'max_decode_bytes', type: 'integer', default: '268435456', zero: <>Unlimited. Warns.</>, description: <>Most memory decoding one source may allocate (256 MiB).</> },
      ]} />

      <h3 id="remote-patterns">remote_patterns</h3>
      <ConfigKeyTable rows={[
        { key: 'protocol', type: 'string', default: '"https"', description: <><code>&quot;https&quot;</code> or <code>&quot;http&quot;</code>; must equal the source&apos;s scheme.</> },
        { key: 'hostname', type: 'string', required: true, description: <>An exact host (<code>images.example.com</code>), <code>*.example.com</code> (exactly one more label), or <code>**.example.com</code> (any depth, <code>example.com</code> itself included). An IP address only matches an exact entry, never a wildcard.</> },
        { key: 'pathname', type: 'string', description: <>An exact path, or a prefix with a trailing <code>*</code> (<code>/uploads/*</code>). Unset: any path.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        <code>/_gio/image</code> takes <code>src</code> (a <code>public/</code> file as served,{' '}
        <code>/hero.png</code> or <code>/public/hero.png</code>, or an allowed remote URL),{' '}
        <code>w</code> (an allowed width), <code>q</code> (1-100) and <code>f</code> (
        <code>avif</code>, <code>webp</code>, <code>jpeg</code>, <code>png</code>; a modern format
        not in <code>formats</code> falls back to negotiation).
      </p>
      <table>
        <thead>
          <tr><th>Status</th><th>When</th></tr>
        </thead>
        <tbody>
          <tr><td><code>200</code></td><td>The image, <code>Cache-Control: public, max-age=31536000, immutable</code>, <code>Vary: Accept</code> (<code>private, no-cache</code> for a file a guard admitted this visitor to).</td></tr>
          <tr><td><code>400</code></td><td>A width not in <code>allowed_widths</code>, a <code>q</code> outside 1-100, a remote source over <code>max_remote_bytes</code>.</td></tr>
          <tr><td><code>403</code></td><td>A remote source no pattern allows, a redirect from a remote source, a path outside <code>public/</code>, a file a guard denies this visitor.</td></tr>
          <tr><td><code>404</code></td><td>No <code>src</code>, a missing file, or the optimizer is off.</td></tr>
          <tr><td><code>500</code></td><td>A source that fails to download or decode, or exceeds the decode limits.</td></tr>
        </tbody>
      </table>
      <p>
        The server hands <code>enabled</code>, the sorted widths and the quality to the worker in{' '}
        <code>GIO_IMAGE_CONFIG</code>, so <code>&lt;GioImage&gt;</code> renders only srcsets the
        optimizer accepts. Those settings are part of the deployment id: changing them drops
        persisted pages. <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a>{' '}
        rules apply to <code>/_gio/image</code>, the only built-in endpoint they cover.
      </p>

      <h3 id="startup-warnings">Startup warnings</h3>
      <p>While the optimizer is on, each limit lifted to <code>0</code> logs one line:</p>
      <StartupWarnings rows={[
        { when: <><code>max_remote_bytes = 0</code></>, text: '[images] max_remote_bytes = 0: remote sources of any size are downloaded into memory' },
        { when: <><code>remote_timeout_secs = 0</code></>, text: '[images] remote_timeout_secs = 0: a slow remote source holds its request open indefinitely' },
        { when: <><code>max_source_dimension = 0</code></>, text: '[images] max_source_dimension = 0: a small file declaring huge dimensions can exhaust memory and CPU' },
        { when: <><code>max_decode_bytes = 0</code></>, text: '[images] max_decode_bytes = 0: decoding one source may allocate any amount of memory' },
      ]} />
      <p>
        <code>enabled = false</code> logs{' '}
        <code>image optimizer disabled ([images] enabled = false): /_gio/image is not routed</code>{' '}
        at <code>info</code> level.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="images-from-a-cms">Images from a CMS</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[images.remote_patterns]]
hostname = "**.ctfassets.net"

[[images.remote_patterns]]
hostname = "cdn.sanity.io"
pathname = "/images/*"`} />

      <h3 id="webp-only-to-save-cpu">WebP only, to save CPU</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[images]
formats = ["webp"]`} />

      <h3 id="an-image-cdn-in-front">An image CDN in front</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[images]
enabled = false        # <GioImage> renders plain src; the CDN resizes`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Optimized images are cached in memory and on disk by source, width, quality and format; a
          changed source file under the same URL keeps its old variants until they are evicted.
          Give edited images new names.
        </li>
        <li>
          Unknown <code>formats</code> are a startup error (
          <code>unknown variant `png`, expected one of `avif`, `image/avif`, `image/webp`, `webp`</code>
          ): PNG and JPEG are always available through <code>f=</code>.
        </li>
        <li>
          A <code>remote_patterns</code> entry that could never match is a startup error naming
          its line: a <code>protocol</code> other than <code>&quot;https&quot;</code> or{' '}
          <code>&quot;http&quot;</code> (lowercase), an empty <code>hostname</code> or one with a
          scheme, path, port or uppercase letters, and a <code>pathname</code> that does not
          start with <code>/</code> (
          <code>pathname &quot;uploads/*&quot; must start with &apos;/&apos;, or it matches no path - did you mean &quot;/uploads/*&quot;?</code>
          ).
        </li>
        <li>In a static export there is no optimizer: every image renders its plain <code>src</code>.</li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>
          <strong>Path traversal checks.</strong> A local <code>src</code> must resolve (symlinks
          included) to a file inside <code>public/</code>.
        </li>
        <li>
          <strong>Redirect blocking.</strong> A remote source that answers with a redirect is refused
          (<code>403</code>): the redirect target was never checked against{' '}
          <code>remote_patterns</code>.
        </li>
        <li>
          <strong>Guard enforcement.</strong> A local file is held to the{' '}
          <a href="/docs/configuration/guards"><code>[[guards]]</code></a> of both URLs it is served
          at, so the optimizer cannot be used to read a guarded file.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/image-optimization">Image Optimization</a></li>
        <li><a href="/docs/components/gio-image"><code>&lt;GioImage&gt;</code></a></li>
        <li><a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a></li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Added <code>enabled</code>, <code>remote_timeout_secs</code>, <code>max_source_dimension</code> and <code>max_decode_bytes</code>; <code>formats</code> is honored (it also bounds <code>f=</code>). <code>max_remote_bytes = 0</code> means unlimited (it used to reject every remote image). Lifted limits log a startup warning.</> },
        { version: 'v0.1.0-beta.6', changes: <><code>remote_patterns</code> are matched on the parsed URL, wildcards match only domains, and <code>pathname</code> is enforced. Fixed decode limits (10000 px, 256 MB).</> },
        { version: 'v0.1.0-beta.5', changes: <>Added <code>disk_max_bytes</code> and <code>max_remote_bytes</code>.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>allowed_widths</code>, <code>quality</code> and <code>remote_patterns</code>.</> },
      ]} />
    </>
  );
}
