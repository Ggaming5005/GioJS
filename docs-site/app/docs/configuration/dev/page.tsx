import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[dev]',
  description:
    'Development-only settings: which hosts the dev endpoints answer, the devtools, and the file ' +
    'watcher that restarts the worker.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[dev]</h1>
      <p className="page-subtitle">
        Development-only settings: which hosts the dev endpoints answer, the devtools, and the file
        watcher that restarts the worker.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[dev]
allowed_hosts = ["192.168.1.20", "myvm.local"]
watch_ignore = ["data/**", "*.db.json"]`} />
      <p>
        The section only takes effect when the server runs with <code>NODE_ENV=development</code>{' '}
        (<code>gio dev</code>, <code>npm run dev</code>). In production the dev endpoints do not
        exist and there is no watcher, whatever it says.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'allowed_hosts', type: 'string[]', default: '[]', zero: <>Empty: only the hosts named above</>, description: <>Extra <code>Host</code> names the <code>/_gio/devtools*</code> endpoints and render error details answer to, besides <code>localhost</code>, <code>*.localhost</code> and loopback IPs (from this machine) and a specific <code>[server] host</code>. Hostnames or IPs; a leading <code>.</code> or <code>*.</code> matches subdomains; a pasted <code>http(s)://</code> and port are ignored. An entry that is not a host is skipped with a warning. <code>[&quot;*&quot;]</code> answers any <code>Host</code> from any machine and warns; open-in-editor never follows it (see <a href="#not-configurable">Not configurable</a>).</> },
        { key: 'devtools', type: 'boolean', default: 'true', zero: <><code>/_gio/devtools*</code> answers <code>404</code></>, description: <>Route the dev endpoints: the dashboard, its state and event stream (which drives live reload), error-overlay codeframes and open-in-editor. Off, the error overlay still shows the message and stack, without codeframes, editor links or live reload.</> },
        { key: 'watch', type: 'boolean', default: 'true', zero: <>No watcher; restart by hand</>, description: <>Restart the worker when a source file changes (and reload open tabs). Turn it off in a huge monorepo, on a network filesystem or when the machine runs out of inotify watches.</> },
        { key: 'watch_ignore', type: 'string[]', default: '[]', description: <>Globs, relative to the project root, the watcher never restarts for: data files the app writes. <code>*</code> stays within a segment, <code>**</code> spans segments, and a pattern without <code>/</code> matches a name at any depth. See <a href="/docs/configuration#dev-watcher">Dev watcher</a>.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>DNS rebinding protection.</strong> A request whose <code>Host</code> is not
          allowed gets <code>403</code> from the dev endpoints, and a failed render shows a generic
          message instead of its error and stack. <code>localhost</code> names count only on a
          connection from this machine. See{' '}
          <a href="/docs/configuration#dev-endpoints-allowed-hosts">Dev endpoints &amp; allowed hosts</a>.
        </li>
        <li>
          Startup logs the extra hosts it answers to, and reminds you when the server binds{' '}
          <code>0.0.0.0</code> with no <code>allowed_hosts</code>. <code>devtools = false</code> and{' '}
          <code>watch = false</code> each log an <code>info</code> line.
        </li>
        <li>
          <code>node_modules</code>, hidden directories (<code>.git</code>, <code>.gio</code>) and
          build output are never watched; neither are the page cache&apos;s own files.
        </li>
      </ul>

      <h3 id="startup-warnings">Startup warnings</h3>
      <StartupWarnings rows={[
        { when: <><code>allowed_hosts</code> contains <code>&quot;*&quot;</code></>, text: '[dev] allowed_hosts = ["*"]: in dev mode the /_gio/devtools endpoints (source codeframes, live server state) and render error details answer any Host from any machine, so DNS rebinding is no longer blocked - list the hostnames you browse from instead' },
        { when: <>An entry that is not a hostname or IP</>, text: 'ignoring [dev] allowed_hosts entry "bad host!" in gio.toml: expected a hostname or IP such as "myvm.local", "192.168.1.20" or "*.tunnel.example", or "*" for any host' },
      ]} />
      <p>
        The <code>&quot;*&quot;</code> warning is logged in every mode, since the file is the same;{' '}
        <code>--check-config</code> reports both.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="open-the-dev-server-from-your-phone">Open the dev server from your phone</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[dev]
allowed_hosts = ["192.168.1.20"]     # the address you type on the phone`} />

      <h3 id="a-tunnel">A tunnel</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[dev]
allowed_hosts = ["*.trycloudflare.com"]`} />

      <h3 id="an-app-that-writes-json-files">An app that writes JSON files</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[dev]
watch_ignore = ["data/**"]           # lowdb, uploads, caches the app writes`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          An <code>allowed_hosts</code> entry opens the dev endpoints - project source included - to
          every client that can reach the port and sends that host. On an untrusted network, bind{' '}
          <code>127.0.0.1</code> instead.
        </li>
        <li>A malformed <code>watch_ignore</code> pattern (<code>..</code>, a backslash) stops startup.</li>
        <li>Development always runs one render worker, whatever <code>[server] workers</code> says.</li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>
          <strong>open-in-editor stays same-origin and ignores <code>&quot;*&quot;</code>.</strong>{' '}
          It accepts <code>POST</code> only and refuses anything but a same-origin request (or{' '}
          <code>Sec-Fetch-Site: none</code>), so a link or form on another site cannot launch your
          editor. A DNS-rebound page is same-origin with its own <code>Host</code>, so{' '}
          <code>allowed_hosts = [&quot;*&quot;]</code> never covers it: open-in-editor answers only
          localhost hosts from this machine, a specific <code>[server] host</code> and the hosts{' '}
          <code>allowed_hosts</code> names explicitly (<code>[&quot;*&quot;, &quot;myvm.local&quot;]</code>).
        </li>
        <li>
          <strong><code>/_gio/devtools*</code> is a <code>404</code> in production.</strong>
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration#dev-endpoints-allowed-hosts">Dev endpoints &amp; allowed hosts</a> and <a href="/docs/configuration#dev-watcher">Dev watcher</a></li>
        <li><a href="/docs/cli/dev"><code>gio dev</code></a></li>
        <li><a href="/docs/observability#dev-dashboard">Dev dashboard</a></li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced with <code>allowed_hosts</code> (<code>[&quot;*&quot;]</code> answers any host, with a warning), <code>devtools</code>, <code>watch</code> and <code>watch_ignore</code>.</> },
      ]} />
    </>
  );
}
