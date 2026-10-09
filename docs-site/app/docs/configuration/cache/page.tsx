import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[cache]',
  description:
    'The page cache: a memory LRU in front of a disk directory for pages that export revalidate, ' +
    'with page ETags and stale-while-revalidate.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[cache]</h1>
      <p className="page-subtitle">
        The page cache: a memory LRU in front of a disk directory for pages that export{' '}
        <code>revalidate</code>, with page ETags and stale-while-revalidate.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[cache]
memory_max_entries = 5000
disk_max_bytes = 1073741824     # 1 GiB`} />
      <p>
        Which pages are cached is decided per page, with the{' '}
        <a href="/docs/page-exports/revalidate"><code>revalidate</code></a> export; this section
        sizes the cache and switches its parts. <a href="/docs/caching">Caching &amp; Revalidating</a>{' '}
        explains the model.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <>Nothing is stored; every request renders</>, description: <>Store and serve pages that export <code>revalidate</code>. With <code>false</code> every response answers <code>X-Gio-Cache: bypass</code> and every request costs a render, but pages still send the <code>Cache-Control</code> their <code>revalidate</code> asks for, so a CDN in front can keep caching them.</> },
        { key: 'memory_max_entries', type: 'integer', default: '1000', zero: <>Not allowed: <code>0</code> is a startup error</>, description: <>Pages kept in the in-memory LRU. Pages pushed out of memory are still served from the disk tier. At least 1; <code>enabled = false</code> is the off switch.</> },
        { key: 'disk_enabled', type: 'boolean', default: 'true', zero: <>Memory only</>, description: <>Keep a disk tier behind the memory LRU. It holds what memory drops and outlives restarts. <code>false</code> writes no files: a page the LRU drops renders again, and the cache starts empty after every restart.</> },
        { key: 'disk_path', type: 'string', default: '".gio/cache/pages"', env: 'GIO_CACHE_DIR', description: <>The disk tier&apos;s directory, relative to the project root and below it (not <code>.</code>, not absolute). It must not be, contain or sit inside <code>app/</code> or <code>public/</code>. <code>GIO_CACHE_DIR</code> overrides it, may be absolute, and is held to the same placement rule.</> },
        { key: 'disk_max_bytes', type: 'integer', default: '536870912', zero: <>No size bound</>, description: <>Size cap of the disk tier (512 MiB); past it the oldest entries are deleted.</> },
        { key: 'etag', type: 'boolean', default: 'true', zero: <>No page ETags, no <code>304</code></>, description: <>Send a weak <code>ETag</code> with pages and answer a matching <code>If-None-Match</code> with <code>304 Not Modified</code>. Turn it off for a CDN that mishandles weak validators, or when the app sets its own.</> },
        { key: 'swr_multiplier', type: 'integer', default: '10', zero: <>Never serve stale; no <code>stale-while-revalidate</code></>, description: <>A page stays servable stale (while one background render refreshes it) until it is this many times its <code>revalidate</code> old. The same window sizes the <code>stale-while-revalidate</code> directive CDNs read.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        <code>X-Gio-Cache</code> on every page response says what happened:{' '}
        <code>miss; stored</code>, <code>hit; ttl=&lt;seconds&gt;</code>,{' '}
        <code>stale; age=&lt;seconds&gt;; revalidating</code> (served stale while one render
        refreshes it), or <code>bypass</code> (not cacheable, or the cache is off). A page with a
        cached <a href="/docs/page-exports/shell">PPR shell</a> reports <code>ppr; shell=stored</code>,{' '}
        <code>ppr; shell=hit</code> or <code>ppr; shell=stale; age=&lt;seconds&gt;; revalidating</code>.
        A cached page carries, with <code>revalidate = 60</code> and the default multiplier:
      </p>
      <CodeBlock lang="text" code={`cache-control: public, max-age=0, s-maxage=60, stale-while-revalidate=540
etag: W/"50b12c1658e2f16a5b78a9b93c564426"`} />
      <ul>
        <li>
          <code>s-maxage</code> is what is left of the page&apos;s <code>revalidate</code> window;{' '}
          <code>stale-while-revalidate</code> is what is left of{' '}
          <code>revalidate &times; swr_multiplier</code> after that. Browsers always revalidate (
          <code>max-age=0</code>).
        </li>
        <li>
          A render that read cookies, the <code>Authorization</code> header, the client address,
          host or scheme (<code>ctx.ip</code>, <code>ctx.host</code>, <code>ctx.scheme</code>), or
          that sets a cookie, is personal: it is sent <code>private, no-cache</code> and never
          stored.
        </li>
        <li>
          A page answered to a request with an <code>Authorization</code> header, through a guard,
          or in a locale negotiated from request headers goes out <code>private, no-cache</code>{' '}
          without an ETag, even when the page cache served it: one URL serves several audiences
          there.
        </li>
        <li>
          A <code>Cache-Control</code> the app or a <code>[[headers]]</code> rule sets always wins.
        </li>
        <li>
          Entries are keyed by the deployment id: a new build or a change to the settings pages
          render with drops what an earlier one stored on disk.
        </li>
      </ul>
      <p>
        Startup logs <code>page cache disabled ([cache] enabled = false): every request renders</code>{' '}
        or <code>page cache is memory only ([cache] disk_enabled = false)</code> when you turn a part
        off. None of these keys logs a warning.
      </p>

      <h3 id="errors">Errors</h3>
      <ul>
        <li><code>invalid `cache.memory_max_entries`: invalid value: integer `0`, expected a nonzero usize</code></li>
        <li><code>invalid `cache.disk_path`: expected a directory inside the project, relative to its root (&quot;.gio/cache/pages&quot;); use GIO_CACHE_DIR for a path outside it</code></li>
        <li><code>[cache] disk_path: the page cache directory ./public/cache is inside the public/ directory (...) - give the cache a directory of its own, such as .gio/cache/pages</code></li>
        <li>
          <code>unknown key `cache.memory_mb` - the memory cache is bounded by entry count: use memory_max_entries (default 1000)</code>,
          and <code>[cache.redis]</code>, which is refused: there is no Redis backend yet.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-cdn-does-the-caching">A CDN does the caching</h3>
      <p>Render every request at the origin and let the CDN keep pages for their <code>revalidate</code>:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[cache]
enabled = false`} />

      <h3 id="read-only-filesystem">Read-only filesystem</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[cache]
disk_enabled = false        # memory only: nothing is written under .gio/cache/pages
memory_max_entries = 2000`} />
      <p>
        Without the disk tier (or with <code>enabled = false</code>) the page cache directory is
        not even created. The server still creates <code>.gio/fonts</code>{' '}
        (<code>GIO_FONTS_DIR</code>) and, with the image optimizer on,{' '}
        <code>.gio/cache/images</code> (<code>GIO_IMAGE_CACHE_DIR</code>): create them before
        deploying or point those variables at a writable path. A directory that cannot be created
        stops startup with its path and the setting that placed it.
      </p>

      <h3 id="never-serve-stale-pages">Never serve stale pages</h3>
      <p>A page past its <code>revalidate</code> window renders before it is served:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[cache]
swr_multiplier = 0`} />

      <h3 id="cache-outside-the-project">Cache outside the project</h3>
      <CodeBlock lang="bash" code={`GIO_CACHE_DIR=/var/cache/my-app npm start`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Each server instance has its own cache. Instances that share a disk directory serve the
          pages each other stored, but each keeps its own memory LRU - purge every instance.
        </li>
        <li>
          GioJS only ever deletes its own entry files (<code>&lt;sha256&gt;.json</code>) in the disk
          directory, but give it a directory of its own.
        </li>
        <li>
          In development the cache is cleared each time a source change restarts the worker, and
          cached pages get no ETag.
        </li>
        <li>
          <code>export const revalidate = false</code> caches a page for a year (31536000 seconds).
        </li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>
          <strong>Personalized renders bypass the cache.</strong> There is no switch to store a page
          that read cookies or the client address: it would be served to everyone. Cache the shell
          with <a href="/docs/page-exports/shell"><code>shell = &apos;cache&apos;</code></a> and
          personalize inside Suspense holes instead.
        </li>
        <li>
          <code>Set-Cookie</code> and hop-by-hop headers are never stored with a page.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/caching">Caching &amp; Revalidating</a></li>
        <li><a href="/docs/page-exports/revalidate"><code>revalidate</code></a> and <a href="/docs/page-exports/tags"><code>tags</code></a></li>
        <li><a href="/docs/functions/revalidate-path"><code>revalidatePath</code></a>, <a href="/docs/functions/revalidate-tag"><code>revalidateTag</code></a> and <a href="/docs/configuration/revalidate"><code>[revalidate]</code></a></li>
        <li><a href="/docs/caching-layers">Caching Layers</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced as a gio.toml section: <code>memory_max_entries</code>, <code>disk_path</code> and <code>disk_max_bytes</code> are honored, and <code>enabled</code>, <code>disk_enabled</code>, <code>etag</code> and <code>swr_multiplier</code> added. <code>memory_mb</code> and <code>[cache.redis]</code> are rejected with a hint. The disk directory may not overlap <code>app/</code> or <code>public/</code>.</> },
      ]} />
    </>
  );
}
