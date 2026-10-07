import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[compression]',
  description: 'Brotli and gzip compression of responses, negotiated from Accept-Encoding.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[compression]</h1>
      <p className="page-subtitle">
        Brotli and gzip compression of responses, negotiated from <code>Accept-Encoding</code>.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[compression]
enabled = true
min_size_bytes = 1024
prefer_brotli = true`} />

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <>Every response is sent uncompressed</>, description: <>Compress responses for clients that accept it. Turn it off when a proxy or CDN in front compresses: compressing twice only costs CPU.</> },
        { key: 'min_size_bytes', type: 'integer', default: '1024', description: <>Responses with a known length below this many bytes are sent as-is - compressing them costs more than it saves. Streamed responses have no known length and are always compressed. At most 65535; a larger value is a startup error.</> },
        { key: 'prefer_brotli', type: 'boolean', default: 'true', zero: <>gzip only</>, description: <><code>true</code>: Brotli for clients that accept it, gzip otherwise. <code>false</code>: gzip only, which costs less CPU per response (every client that accepts Brotli also accepts gzip).</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Brotli (<code>br</code>) and gzip are the only encodings; a client that accepts neither gets
          the plain body.
        </li>
        <li>
          Never compressed: images (<code>image/*</code>), server-sent events (
          <code>text/event-stream</code>), gRPC, responses that already carry a{' '}
          <code>Content-Encoding</code>, and partial (<code>Content-Range</code>) responses.
        </li>
        <li>
          Every response the layer could compress carries <code>Vary: accept-encoding</code>, so
          caches keep one copy per encoding. With <code>enabled = false</code> no response gets it.
        </li>
        <li>
          Compression is the outermost response step: it runs after the security headers, CSP
          nonces and <code>&lt;html lang&gt;</code> have been written into the body.
        </li>
      </ul>
      <p>
        Startup logs <code>response compression disabled ([compression] enabled = false)</code>{' '}
        when it is off. No key in this section logs a warning.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="behind-a-compressing-cdn">Behind a compressing CDN</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[compression]
enabled = false`} />

      <h3 id="save-cpu-on-a-small-instance">Save CPU on a small instance</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[compression]
prefer_brotli = false       # gzip is cheaper to produce
min_size_bytes = 4096`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A cached page&apos;s weak <code>ETag</code> stands for all of its encodings, and a{' '}
          <code>304</code> keeps the <code>Vary</code> its <code>200</code> would carry.
        </li>
        <li>
          While CSP nonces are on, a route handler must not compress its own body: a response with
          its own <code>Content-Encoding</code> is refused with <code>500</code>. Leave compression
          to the server.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration/cache"><code>[cache]</code></a> - ETags and Cache-Control</li>
        <li><a href="/docs/deployment">Proxies, Sizing &amp; Scaling</a></li>
        <li><a href="/docs/configuration">gio.toml overview</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced as a gio.toml section: <code>enabled</code>, <code>min_size_bytes</code> and <code>prefer_brotli</code> are honored.</> },
        { version: 'v0.1.0-beta.1', changes: 'Brotli and gzip compression of responses of 1 KB and more, not configurable.' },
      ]} />
    </>
  );
}
