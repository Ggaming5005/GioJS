import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'navigate',
  description:
    'Soft-navigate to a URL from any client code - outside components, where useRouter() is not available.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>navigate</h1>
      <p className="page-subtitle">
        Soft-navigate to a URL from any client code - outside components, where{' '}
        <code>useRouter()</code> is not available.
      </p>
      <CodeBlock lang="ts" code={`import { navigate } from '@gio.js/react';

await navigate('/login', { replace: true });`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'href',
          type: 'string',
          required: true,
          description: (
            <>
              Where to go: a path, a query (<code>?page=2</code>), a hash, or an absolute URL.
              Build typed paths with <a href="/docs/functions/href">href()</a>.
            </>
          ),
        },
        {
          name: 'options.replace',
          type: 'boolean',
          default: 'false',
          description: <>Replace the current history entry instead of adding one.</>,
        },
        {
          name: 'options.scroll',
          type: 'boolean',
          default: 'true',
          description: (
            <>
              Scroll to the top of the new page, or to the element its <code>#hash</code>{' '}
              names. <code>false</code> keeps the scroll position.
            </>
          ),
        },
        {
          name: 'options.transition',
          type: "'fade' | 'slide-left' | 'slide-up' | 'scale' | false",
          default: 'false',
          description: <>A view transition preset for the swap, where the browser supports <code>document.startViewTransition</code>.</>,
        },
      ]} />

      <h3 id="returns">Returns</h3>
      <p>
        A <code>{'Promise<void>'}</code> that resolves once the new page is on screen (or,
        for a full page load, once the browser has been told to load it).
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Same origin:</strong> the page is fetched (or taken from a fresh prefetch),
          its stylesheets loaded, and it is rendered into the running React root - shared
          layouts keep their state. History is updated, then the page scrolls and focus moves
          to the new <code>{'<main>'}</code>, with the title announced to screen readers.
        </li>
        <li>
          <strong>Only a hash changes</strong> on the current page: no fetch, just a history
          entry and a scroll.
        </li>
        <li>
          <strong>Full page loads instead:</strong> another origin, an answer that is not a
          GioJS page (JSON, a static host&apos;s <code>404.html</code>, a server error page),
          a redirect that lands on another origin, or a network error.
        </li>
        <li>
          <strong>A new deployment</strong> (the server answers <code>409</code> with{' '}
          <code>x-gio-action: hard-reload</code>) loads the target in full, so the tab picks up
          the new build - see <a href="/docs/functions/deployment-helpers">deployment helpers</a>.
        </li>
        <li>
          After a redirect, history records the URL the redirect landed on, not{' '}
          <code>href</code>.
        </li>
        <li>
          A later navigation supersedes an earlier one that has not finished; the earlier
          promise resolves without showing its page.
        </li>
        <li>On the server it does nothing and resolves at once.</li>
      </ul>
      <h3 id="errors">Errors</h3>
      <p>
        It rejects with a <code>TypeError</code> for an <code>href</code> that is not a valid
        URL, and for any scheme other than <code>http:</code> and <code>https:</code> -{' '}
        <code>{"navigate('javascript:alert(1)')"}</code> never runs script, so passing user
        input to it is not an XSS sink.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="after-a-logout-request">After a logout request</h3>
      <CodeBlock lang="ts" title="lib/session-client.ts" code={`import { navigate } from '@gio.js/react';

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
  await navigate('/', { replace: true });
}`} />
      <h3 id="from-a-websocket-message">From a WebSocket message</h3>
      <CodeBlock lang="ts" code={`socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'game-started') void navigate(\`/games/\${message.id}\`);
});`} />
      <h3 id="inside-components">Inside components</h3>
      <p>
        In a component, prefer <code>useRouter()</code>: <code>router.push(href)</code> and{' '}
        <code>router.replace(href)</code> do the same as <code>navigate</code>, and the router
        adds <code>back</code>, <code>forward</code>, <code>refresh</code> and{' '}
        <code>prefetch</code>.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Navigating to the URL already shown</strong> replaces its history entry, as a
          browser does for a link to the current page.
        </li>
        <li>
          <strong>Fresh data after a mutation.</strong> Any same-origin <code>fetch()</code>{' '}
          with a method other than <code>GET</code>, <code>HEAD</code> or{' '}
          <code>OPTIONS</code> clears the prefetch cache, so a navigation
          after it never shows a page prefetched before the change.
        </li>
        <li>
          <strong>Static export.</strong> Soft navigation works on any static host; pages that
          are not GioJS pages load in full.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/linking-and-navigating#navigating-from-code">Linking &amp; Navigating: Navigating from code</a></li>
        <li><a href="/docs/hooks/use-router">useRouter</a></li>
        <li><a href="/docs/components/gio-link">GioLink</a></li>
        <li><a href="/docs/functions/href">href</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced, with the router hooks.' }]} />
    </>
  );
}
