import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'callRoute',
  description:
    'Call a route handler or a page action in your test process, with any method and body, and read the answer like a fetch Response.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>callRoute</h1>
      <p className="page-subtitle">
        Call a route handler or a page action in your test process, with any method and body,
        and read the answer like a fetch <code>Response</code>.
      </p>
      <CodeBlock lang="ts" code={`import { callRoute } from '@gio.js/core/testing';

const res = await callRoute('/api/notes', { method: 'POST', body: { text: 'hi' } });`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>callRoute(path, options?)</code>. It takes every option of{' '}
        <a href="/docs/functions/render-page#reference">renderPage</a> (<code>appDir</code>,{' '}
        <code>headers</code>, <code>cookies</code>, <code>query</code>, <code>locale</code>),
        plus:
      </p>
      <PropsTable kind="Option" rows={[
        { name: 'method', type: 'string', default: "'GET'", description: <>Any HTTP method; upper-cased for you.</> },
        {
          name: 'body',
          type: 'string | Uint8Array | URLSearchParams | object | unknown[] | null',
          description: (
            <>
              How it is sent, unless <code>headers</code> sets a <code>content-type</code>:
              a string as <code>text/plain;charset=UTF-8</code>; <code>URLSearchParams</code>{' '}
              as <code>application/x-www-form-urlencoded</code>; a <code>Uint8Array</code> as
              raw bytes with no content type; any other value as JSON with{' '}
              <code>application/json</code>.
            </>
          ),
        },
      ]} />
      <h3 id="returns">Returns</h3>
      <p>A <code>{'Promise<RouteResponse>'}</code>:</p>
      <PropsTable kind="Field" rows={[
        { name: 'status', type: 'number', description: <>The response status.</> },
        { name: 'headers', type: 'Record<string, string>', description: <>Response headers, lowercase - without the ones the Rust server adds.</> },
        { name: 'setCookies', type: 'string[]', description: <>Every <code>Set-Cookie</code> value, in order.</> },
        { name: 'text()', type: 'Promise<string>', description: <>The body as text. For an event stream, it resolves once the handler closes the stream.</> },
        { name: 'json()', type: 'Promise<T>', description: <>The body parsed as JSON.</> },
        { name: 'bytes()', type: 'Promise<Uint8Array>', description: <>The raw body.</> },
        { name: 'stream', type: 'ReadableStream<Uint8Array> | null', description: <>Event streams only: the events as a client receives them. <code>null</code> otherwise.</> },
        { name: 'error', type: '{ message, digest?, stack? } | undefined', description: <>Set when a page render failed and no <code>error.tsx</code> answered.</> },
      ]} />
      <h3 id="behavior">Behavior</h3>
      <p>The request goes through the same code as on the server, so the answers match:</p>
      <ul>
        <li>A returned value is JSON <code>200</code>; <code>null</code> or <code>undefined</code> is <code>204</code>; a <code>Response</code> passes through.</li>
        <li><code>notFound()</code> is a JSON <code>404</code>; a throw is a JSON <code>500</code> with a <code>digest</code>; a method the file does not export is <code>405</code>.</li>
        <li><code>req.json()</code> on a non-JSON body is <code>415</code>; a broken form body is <code>400</code>.</li>
        <li>A <code>POST</code> to a page runs its <code>action</code>: you get the redirect, or the re-rendered page as HTML.</li>
        <li>A <code>GET</code> to a page renders it, like <code>renderPage</code>.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="json-and-form-bodies">JSON and form bodies</h3>
      <CodeBlock lang="ts" title="tests/notes.test.ts" code={`import { expect, it } from 'vitest';
import { callRoute } from '@gio.js/core/testing';

it('accepts JSON and form posts', async () => {
  const json = await callRoute('/api/notes', { method: 'POST', body: { text: 'hi' } });
  expect(json.status).toBe(201);
  expect(await json.json()).toEqual({ saved: 'hi' });

  const form = await callRoute('/api/notes', { method: 'POST', body: new URLSearchParams({ text: 'form' }) });
  expect(form.status).toBe(201);
});

it('refuses a text/plain body', async () => {
  const res = await callRoute('/api/notes', { method: 'POST', body: 'plain' });
  expect(res.status).toBe(415);
});`} />
      <h3 id="a-page-action">A page action</h3>
      <CodeBlock lang="ts" code={`it('redirects after a valid contact form', async () => {
  const res = await callRoute('/contact', {
    method: 'POST',
    body: new URLSearchParams({ email: 'ada@example.com' }),
  });
  expect(res.status).toBe(303);
  expect(res.headers.location).toBe('/contact/thanks');
  expect(res.setCookies[0]).toMatch(/^gio_session=/);
});

it('re-renders with a 422 for an invalid email', async () => {
  const res = await callRoute('/contact', { method: 'POST', body: new URLSearchParams({ email: 'nope' }) });
  expect(res.status).toBe(422);
  expect(await res.text()).toContain('Enter a valid email address.');
});`} />
      <h3 id="event-streams">Event streams</h3>
      <p>
        For a handler that returns a <code>GioEventStream</code>, read <code>stream</code>{' '}
        piece by piece, or <code>text()</code> for a stream the handler closes. Cancelling the
        reader runs the handler&apos;s cleanup function, like a client disconnecting.
      </p>
      <CodeBlock lang="ts" code={`it('ticks', async () => {
  const res = await callRoute('/api/clock');
  expect(res.headers['content-type']).toBe('text/event-stream');
  const reader = res.stream!.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain('event: tick');
  await reader.cancel();   // runs the cleanup
});`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>No Rust in between.</strong> CSRF checks, rules, guards, rate limits and{' '}
          <code>[server] max_body_bytes</code> are not applied - so a cross-site{' '}
          <code>POST</code> succeeds here. Use{' '}
          <a href="/docs/functions/create-test-server">createTestServer</a> to test them.
        </li>
        <li>
          <strong>No cache, no WebSocket server.</strong> <code>revalidateTag</code> and{' '}
          <code>revalidatePath</code> resolve <code>ok: false</code>, and{' '}
          <code>broadcast</code> returns <code>false</code>.
        </li>
        <li>
          <strong>Sessions work.</strong> Without a configured secret, a random{' '}
          <code>GIO_SESSION_SECRET</code> is set for the test process; pass the cookie back
          with <code>cookies</code> to act as the signed-in user.
        </li>
        <li>
          <strong>A <code>route.ts</code> that throws on import</strong> answers{' '}
          <code>500</code> for every method, as on the server.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/testing#route-handlers-callroute">Testing: Route handlers</a></li>
        <li><a href="/docs/functions/render-page">renderPage</a>, <a href="/docs/functions/create-test-server">createTestServer</a></li>
        <li><a href="/docs/route-handlers">Route Handlers</a></li>
        <li><a href="/docs/functions/gio-event-stream">GioEventStream</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
