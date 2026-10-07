import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[logging]',
  description: "The Rust server's log format: human-readable text, or one JSON object per line for log shippers.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[logging]</h1>
      <p className="page-subtitle">
        The Rust server&apos;s log format: human-readable text, or one JSON object per line for log
        shippers.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[logging]
format = "json"`} />

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'format', type: '"text" | "json"', default: '"text"', env: 'GIO_LOG_FORMAT', description: <><code>&quot;text&quot;</code>: human-readable lines with colors. <code>&quot;json&quot;</code>: one object per line with <code>ts</code> (RFC 3339, UTC), <code>level</code>, <code>msg</code> and <code>target</code>, plus the event&apos;s fields and those of its spans - every line logged for a request carries <code>request_id</code>. Any other value stops startup.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <code>GIO_LOG_FORMAT</code> (<code>json</code> or <code>text</code>, any case) wins over the
          file, so one build can log text locally and JSON in its container. An invalid value is
          ignored with a warning: <code>ignoring GIO_LOG_FORMAT=&quot;logfmt&quot;: expected &quot;json&quot; or &quot;text&quot;</code>.
        </li>
        <li>
          The Node worker always writes JSON lines with the same core keys and the request id as{' '}
          <code>requestId</code>; this key only switches the server&apos;s own lines.
        </li>
        <li>
          Levels are filtered with <code>RUST_LOG</code> for the server (default <code>info</code>)
          and <code>GIO_LOG_LEVEL</code> for the worker.
        </li>
      </ul>
      <CodeBlock lang="text" code={`{"ts":"2026-10-06T12:00:01.204518Z","level":"info","msg":"request completed","target":"giojs_server","cache":"miss","method":"GET","path":"/posts/7","request_id":"0b8e3c52-7a1d-4f0e-9c3b-5d2a6e8f1a47","status":"200"}`} />

      <h2 id="examples">Examples</h2>
      <h3 id="json-in-production-text-locally">JSON in production, text locally</h3>
      <p>Leave <code>gio.toml</code> at the default and set the variable where the logs are shipped:</p>
      <CodeBlock lang="dockerfile" title="Dockerfile" code={`ENV GIO_LOG_FORMAT=json`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li><code>format = &quot;logfmt&quot;</code> stops startup: <code>invalid `logging.format`: unknown variant `logfmt`, expected `text` or `json`</code>.</li>
        <li>Event or span fields named <code>ts</code>, <code>level</code>, <code>msg</code> or <code>target</code> are written as <code>field.&lt;name&gt;</code> instead of overwriting the core keys.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/observability#json-logs">Observability: JSON logs</a></li>
        <li><a href="/docs/configuration#request-ids">Request IDs</a></li>
        <li><a href="/docs/env-vars">Environment variables</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced, with <code>GIO_LOG_FORMAT</code>.</> },
      ]} />
    </>
  );
}
