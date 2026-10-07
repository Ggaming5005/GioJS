import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[security.websocket]',
  description:
    'The Origin check on WebSocket upgrades, which stops other websites from opening sockets with ' +
    "your visitors' cookies.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[security.websocket]</h1>
      <p className="page-subtitle">
        The Origin check on WebSocket upgrades, which stops other websites from opening sockets
        with your visitors&apos; cookies.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security.websocket]
check_origin = true      # the default`} />
      <p>
        Browsers let any page open a WebSocket to any server and send that server&apos;s cookies
        with it (cross-site WebSocket hijacking). The upgrade is a <code>GET</code>, so CSRF
        protection alone would not cover it: GioJS judges every upgrade like an unsafe request
        instead.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'check_origin', type: 'boolean', default: 'true', zero: <>Upgrades from any website are accepted. Warns.</>, description: <>Check the <code>Origin</code> (and <code>Sec-Fetch-Site</code>) of every WebSocket upgrade with the rules of <a href="/docs/configuration/security-csrf#behavior"><code>[security.csrf]</code></a>: your own host, an origin in <code>[security.csrf] trusted_origins</code>, or a client with neither header (not a browser) is accepted; anything else gets <code>403</code> before the connection is upgraded.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Independent of <code>[security.csrf] enabled</code>: turning CSRF protection off because
          your forms carry tokens leaves this check on, since form tokens do nothing for WebSockets.
        </li>
        <li>
          It shares the CSRF lists: <code>trusted_origins</code> are accepted here too, and{' '}
          <code>exempt</code> paths skip this check as well - exempt a public WebSocket API meant to
          be used from any site.
        </li>
        <li>
          A refusal is a <code>403</code> with a plain-text body naming the setting to change (
          <code>cross-site WebSocket upgrade blocked by CSRF protection - ...</code>).
        </li>
      </ul>

      <h3 id="startup-warnings">Startup warnings</h3>
      <StartupWarnings rows={[
        { when: <><code>check_origin = false</code></>, text: "[security.websocket] check_origin = false: any website can open WebSockets to this server with your visitors' cookies - prefer listing origins in [security.csrf] trusted_origins, or public endpoints in [security.csrf] exempt" },
      ]} />

      <h2 id="examples">Examples</h2>
      <h3 id="a-public-websocket-api">A public WebSocket API</h3>
      <p>Keep the check for the app&apos;s own sockets and open one path to every site:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security.csrf]
exempt = ["/api/public-feed"]`} />

      <h3 id="a-client-on-another-origin">A client on another origin</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[security.csrf]
trusted_origins = ["https://dashboard.example.com"]`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A socket accepted here still has to pass its route&apos;s <code>wsHandler</code>, which can
          check the session and refuse it. See{' '}
          <a href="/docs/websockets#authenticating-connections">Authenticating connections</a>.
        </li>
        <li>
          With <a href="/docs/configuration/websocket"><code>[websocket] enabled = false</code></a>{' '}
          upgrades are answered <code>501</code>. This check still runs before that, so a
          cross-site upgrade gets <code>403</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/security#websocket-origin-checks">Security guide: WebSocket origin checks</a></li>
        <li><a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a></li>
        <li><a href="/docs/configuration/websocket"><code>[websocket]</code></a></li>
        <li><a href="/docs/websockets">WebSockets</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: 'Introduced, on by default; turning it off logs a startup warning.' },
      ]} />
    </>
  );
}
