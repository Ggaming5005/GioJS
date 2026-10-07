import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Deployment helpers',
  description:
    'getDeploymentId, isHardReloadResponse, handleHardReload and initDeploymentId: detect that a tab runs an older build than the server, and reload it.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Deployment helpers</h1>
      <p className="page-subtitle">
        <code>getDeploymentId</code>, <code>isHardReloadResponse</code>,{' '}
        <code>handleHardReload</code> and <code>initDeploymentId</code>: detect that a tab
        runs an older build than the server, and reload it.
      </p>
      <CodeBlock lang="ts" code={`import {
  getDeploymentId,
  handleHardReload,
  initDeploymentId,
  isHardReloadResponse,
} from '@gio.js/react';`} />
      <p>
        The client router already uses them: every navigation, prefetch, refresh and{' '}
        <code>{'<GioForm>'}</code> post sends the tab&apos;s deployment id, and a tab on an old
        build loads the new one in full. You need them only for your own{' '}
        <code>fetch()</code> calls.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="how-skew-detection-works">How skew detection works</h3>
      <ol>
        <li>
          Every server-rendered page carries an inline script setting{' '}
          <code>window.__GIO_DEPLOYMENT_ID__</code> to the server&apos;s deployment id - a
          hash of the build, or <code>GIO_DEPLOYMENT_ID</code> when you pin one.
        </li>
        <li>A request from the tab sends it back as the <code>x-deployment-id</code> header.</li>
        <li>
          When the id differs from the server&apos;s, the server answers <code>409</code> with{' '}
          <code>x-gio-action: hard-reload</code> before any handler runs - for pages and
          route handlers alike. A request without the header is never refused.
        </li>
      </ol>
      <p>
        <code>[server] skew_protection = false</code> makes the server ignore the header (no{' '}
        <code>409</code>s); it logs a startup warning.
      </p>

      <h2 id="getdeploymentid">getDeploymentId</h2>
      <CodeBlock lang="ts" code={`getDeploymentId(): string | undefined`} />
      <p>
        <code>getDeploymentId()</code> returns the id of the build that served this document, read from <code>window.__GIO_DEPLOYMENT_ID__</code> on first
        use. Soft navigations never run the fetched page&apos;s scripts, so it keeps naming the
        build whose code runs in the tab. It is <code>undefined</code> on the server and on a
        page without the script (a static export).
      </p>

      <h2 id="ishardreloadresponse">isHardReloadResponse</h2>
      <CodeBlock lang="ts" code={`isHardReloadResponse(response: Response): boolean`} />
      <p>
        <code>isHardReloadResponse()</code> is <code>true</code> when <code>response.status</code> is <code>409</code> and its{' '}
        <code>x-gio-action</code> header is <code>hard-reload</code>. A <code>409</code> your
        own handler returns does not match.
      </p>

      <h2 id="handlehardreload">handleHardReload</h2>
      <CodeBlock lang="ts" code={`handleHardReload(): void`} />
      <p>
        <code>handleHardReload()</code> reloads the page (
        <code>window.location.reload()</code>), so the tab fetches the new build&apos;s HTML and
        scripts. Browser only: unlike the other helpers it has no server-side guard, so
        calling it during server rendering throws (there is no <code>window</code>).
      </p>

      <h2 id="initdeploymentid">initDeploymentId</h2>
      <CodeBlock lang="ts" code={`initDeploymentId(): void`} />
      <p>
        <code>initDeploymentId()</code> re-reads <code>window.__GIO_DEPLOYMENT_ID__</code>{' '}
        into the value the getter above returns. Nothing needs to call it, since the getter
        reads the value on first use; it is kept for compatibility.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-fetch-wrapper-for-your-api">A fetch wrapper for your API</h3>
      <CodeBlock lang="ts" title="lib/api-client.ts" code={`import { getDeploymentId, handleHardReload, isHardReloadResponse } from '@gio.js/react';

/** fetch() for this app's API that reloads the tab when a new build is live. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const id = getDeploymentId();
  if (id !== undefined) headers.set('x-deployment-id', id);
  const res = await fetch(input, { ...init, headers });
  if (isHardReloadResponse(res)) handleHardReload();
  return res;
}`} />
      <p>
        After a deploy, the next <code>apiFetch</code> from a tab on the old build gets the{' '}
        <code>409</code> before your handler runs - so a <code>POST</code> changed nothing -
        and the tab reloads onto the new build.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Opt-in for your requests.</strong> Plain <code>fetch()</code> calls do not
          send <code>x-deployment-id</code>, so an old tab keeps talking to the new server -
          fine for an API that stays compatible across deploys.
        </li>
        <li>
          <strong>Reloading loses unsaved state</strong> on the page (form input, scroll in
          nested views). For a request the user cannot afford to lose, save a draft before
          calling <code>handleHardReload()</code>.
        </li>
        <li>
          <strong>Pin the id across instances.</strong> Instances that run the same build
          compute the same id. If yours could differ (different build hosts), set the same{' '}
          <code>GIO_DEPLOYMENT_ID</code> on all of them and change it with every deploy;
          otherwise a load balancer alternating between them causes reloads.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration/server">[server]</a> - <code>skew_protection</code></li>
        <li><a href="/docs/headers">Headers</a> - <code>x-deployment-id</code> and <code>x-gio-action</code></li>
        <li><a href="/docs/env-vars">Environment variables</a> - <code>GIO_DEPLOYMENT_ID</code></li>
        <li><a href="/docs/functions/navigate">navigate</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              The router sends the id on navigations, prefetches, refreshes and{' '}
              <code>{'<GioForm>'}</code> posts, and <code>getDeploymentId()</code> reads it on
              first use - <code>initDeploymentId()</code> is no longer needed.{' '}
              <code>[server] skew_protection</code> can turn the <code>409</code> off.
            </>
          ),
        },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
