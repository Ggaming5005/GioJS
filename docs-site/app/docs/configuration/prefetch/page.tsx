import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[prefetch]',
  description: 'Per-client budgets for the prefetch requests <GioLink> sends, and the site-wide switch for prefetching.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[prefetch]</h1>
      <p className="page-subtitle">
        Per-client budgets for the prefetch requests <code>&lt;GioLink&gt;</code> sends, and the
        site-wide switch for prefetching.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[prefetch]
max_concurrent = 5
max_per_second = 20`} />
      <p>
        Which links prefetch, and when, is chosen per link with{' '}
        <a href="/docs/components/gio-link"><code>&lt;GioLink prefetch&gt;</code></a>. This section
        bounds what one client&apos;s prefetches may cost the server.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <>Every prefetch is answered <code>429</code></>, description: <>Answer prefetch requests. <code>false</code> refuses each one with <code>429</code> before anything renders, which turns prefetching off site-wide: links still navigate, they just load on click.</> },
        { key: 'max_concurrent', type: 'integer', default: '5', zero: 'Unlimited', description: <>Prefetches one client may have in flight at once. Past it the server answers <code>429</code>, which the client treats as &quot;not prefetched&quot;.</> },
        { key: 'max_per_second', type: 'integer', default: '20', zero: 'Unlimited', description: <>Prefetches one client may start per second.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          A request is a prefetch when it carries <code>Purpose: prefetch</code> or{' '}
          <code>Sec-Purpose: prefetch</code>. Everything else is never counted.
        </li>
        <li>
          A client is its IP address after{' '}
          <a href="/docs/configuration/server"><code>[server] trusted_proxies</code></a> resolution.
          Clients idle for a minute are forgotten.
        </li>
        <li>
          An over-budget prefetch is logged at <code>warn</code> (<code>prefetch budget exceeded</code>);
          one refused because prefetching is off is not. Both count in the metrics.
        </li>
        <li>
          A slot is released when its response is ready or when the client gives up, so cancelled
          prefetches never use up the budget.
        </li>
        <li>
          An admitted prefetch is an ordinary request: a page with{' '}
          <a href="/docs/page-exports/revalidate"><code>revalidate</code></a> is served from
          the <a href="/docs/caching">page cache</a> and stored in it like any other{' '}
          <code>GET</code>, with the same <code>Cache-Control</code>: prefetching a cached
          page costs no render, and a prefetch can fill the cache for the next visitor.
        </li>
      </ul>
      <p>No key in this section logs a startup warning, <code>0</code> included.</p>

      <h2 id="examples">Examples</h2>
      <h3 id="turn-prefetching-off">Turn prefetching off</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[prefetch]
enabled = false`} />

      <h3 id="a-docs-site-with-many-viewport-links">A docs site with many viewport links</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[prefetch]
max_concurrent = 10
max_per_second = 50`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>0</code> lifts a budget; it does not refuse prefetches. Use{' '}
          <code>enabled = false</code> for that.
        </li>
        <li>
          <code>[prefetch] strategy</code> from earlier docs is refused with a hint: the strategy is
          chosen per link (<code>&lt;GioLink prefetch=&quot;hover&quot; | &quot;viewport&quot; | {'{false}'}&gt;</code>).
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/linking-and-navigating#prefetching">Linking &amp; Navigating: Prefetching</a></li>
        <li><a href="/docs/components/gio-link"><code>&lt;GioLink&gt;</code></a></li>
        <li><a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced as a gio.toml section with <code>enabled</code>, <code>max_concurrent</code> and <code>max_per_second</code>; <code>0</code> means unlimited. <code>strategy</code> is rejected.</> },
        { version: 'v0.1.0-beta.1', changes: 'Fixed per-client prefetch budgets (5 in flight, 20 per second).' },
      ]} />
    </>
  );
}
