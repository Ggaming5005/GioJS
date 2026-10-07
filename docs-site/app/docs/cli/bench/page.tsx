import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio bench',
  description:
    'Load-test a running server: keep-alive connections for a fixed time, then ' +
    'throughput, latency percentiles and the X-Gio-Cache of the last response.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio bench</h1>
      <p className="page-subtitle">
        Load-test a running server: keep-alive connections for a fixed time, then
        throughput, latency percentiles and the <code>X-Gio-Cache</code> of the last
        response.
      </p>
      <PmTabs command={`npx gio bench /posts/1`} />
      <CodeBlock lang="bash" code={`gio bench <url-or-path> [--connections 32] [--duration 10] [--warmup 2]
gio bench --suite /,/posts/1 [--base <url>]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        {
          name: '<url-or-path>',
          type: 'string',
          description: <>The target: an absolute <code>http</code> or <code>https</code> URL, or a path starting with <code>/</code> requested from <code>--base</code> (default: the local server). Anything else (<code>localhost:3000</code>) is a usage error. Give either this or <code>--suite</code>.</>,
        },
        {
          name: '--connections <n>',
          type: 'number',
          default: '32',
          description: 'Concurrent keep-alive connections, each sending one request after another. A whole number above 0.',
        },
        {
          name: '--duration <s>',
          type: 'number',
          default: '10',
          description: 'Seconds to measure (per target with --suite). Must be above 0.',
        },
        {
          name: '--warmup <s>',
          type: 'number',
          default: '2',
          description: <>Seconds of load before measuring; warmup requests count in no statistic. <code>0</code> skips it.</>,
        },
        {
          name: '--suite <paths>',
          type: 'string',
          description: <>Run several paths one after another and print a table. Paths are joined to <code>--base</code>.</>,
        },
        {
          name: '--base <url>',
          type: 'string',
          default: 'local server',
          description: <>Where paths go: an <code>http</code> or <code>https</code> URL. Without it, <code>gio</code> passes the local server&apos;s address, resolved like <code>gio dev</code> resolves it (<code>GIO_PORT</code> / <code>PORT</code>, <code>.env</code> files, <code>gio.toml</code>).</>,
        },
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the help and exit with <code>0</code>.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Every connection loops for warmup plus duration, sending <code>GET</code> requests
          and reading each body to the end. Requests per second is the measured request count
          divided by the duration.
        </li>
        <li>
          <code>non-200</code> counts measured responses with another status; they still count
          as requests. <code>errors</code> counts failed requests (refused, reset). A connection
          gives up after three errors in a row.
        </li>
        <li>
          Latency is per request, from sending to the last byte: p50, p90, p99 and max.
        </li>
        <li>
          <code>x-gio-cache</code> is the header of the last response, so a run against a
          cached page says <code>hit</code> and an uncached one <code>bypass</code>: the
          numbers label themselves.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="one-target">One target</h3>
      <CodeBlock lang="text" code={`$ npx gio bench /blog --duration 5
gio bench http://127.0.0.1:3000/blog
  connections   32   duration 5s   warmup 2s

  requests/s    2077.80
  requests      10389
  non-200       0
  errors        0
  latency p50   14.81 ms
  latency p90   24.27 ms
  latency p99   37.07 ms
  latency max   72.57 ms
  bytes/s       5.35 MB/s
  x-gio-cache   hit; ttl=54   (last response)`} />

      <h3 id="a-suite">A suite</h3>
      <CodeBlock lang="text" code={`$ npx gio bench --suite /,/blog,/giojs-logo.svg --duration 5
gio bench suite against http://127.0.0.1:3000  (32 connections, 5s per target, 2s warmup)

target             req/s         p50         p90         p99         max  non-200  errors      bytes/s  x-gio-cache (last)
/                  19.00  1314.36 ms  1527.28 ms  2395.88 ms  2395.88 ms        0       0   73.23 kB/s              bypass
/blog            1679.20    16.73 ms    33.08 ms    60.03 ms    96.61 ms        0       0    4.33 MB/s         hit; ttl=39
/giojs-logo.svg   832.40    47.62 ms    56.73 ms    75.28 ms    95.05 ms        0       0  525.24 kB/s              static`} />
      <p>
        These runs used an unoptimized (debug) build of the server in a small container,
        against the starter app with a <code>/blog</code> page exporting{' '}
        <code>revalidate = 60</code>: they show the shape of the output and the gap between a
        cached page (<code>hit</code>) and a page rendered per request (<code>bypass</code>),
        not GioJS&apos;s speed. Measure with <code>gio start</code> and the published binary
        on hardware like production, and run the load generator on another machine for
        numbers you publish.
      </p>

      <h3 id="a-remote-server">A remote server</h3>
      <CodeBlock lang="bash" code={`npx gio bench https://staging.example.com/ --connections 64 --duration 30`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Flags take their value as the next argument or after <code>=</code>:{' '}
          <code>--duration 5</code> and <code>--duration=5</code> are the same.
        </li>
        <li>
          A usage error - a bad flag or value, no target, a target that is neither a path nor
          an http(s) URL, both a target and <code>--suite</code> - exits with code{' '}
          <code>2</code> before any request is sent, as every <code>gio</code> usage error
          does. A single-target run with no successful request exits with <code>1</code>{' '}
          (<code>no successful requests to ... - is the server running?</code>). A suite run
          exits <code>0</code> even when a target fails; read its <code>errors</code> column.
        </li>
        <li>
          Every request is a plain anonymous <code>GET</code>: no cookies, no request body.
          To load-test a form post or an authenticated page, use a dedicated tool.
        </li>
        <li>It has no dependencies: plain <code>node:http</code> / <code>node:https</code>.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/benchmarks#load-testing-with-gio-bench">Benchmarks: load testing with gio bench</a></li>
        <li><a href="/docs/cli/cache-explain"><code>gio cache explain</code></a></li>
        <li><a href="/docs/caching">Caching &amp; Revalidating</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Paths and <code>--suite</code> go to the address the server listens on instead of <code>http://localhost:3000</code>. Usage errors exit with <code>2</code> instead of <code>1</code>; flags also take <code>--flag=value</code>; a target that is not a path or an http(s) URL, and a fractional <code>--connections</code>, are usage errors.</> },
        { version: 'v0.1.0-beta.6', changes: 'Introduced.' },
      ]} />
    </>
  );
}
