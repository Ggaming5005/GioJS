import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'action',
  description:
    "Handle a form POST to a page's own URL on the server, then redirect or re-render the page with the result.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>action</h1>
      <p className="page-subtitle">
        Handle a form <code>POST</code> to a page&apos;s own URL on the server, then redirect
        or re-render the page with the result.
      </p>
      <CodeBlock lang="tsx" title="app/contact/page.tsx" code={`import { redirect, type ActionArgs, type WithActionData } from '@gio.js/core';
import { GioForm } from '@gio.js/react';
import { db } from '../../lib/db.server.ts';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim();
  if (!email.includes('@')) {
    return { status: 422, data: { error: 'Enter a valid email', email } };
  }
  await db.messages.insert({ email });
  return redirect('/contact/thanks');                  // 303 See Other
}

export default function Contact({ actionData }: WithActionData<typeof action>) {
  return (
    <GioForm>
      <input name="email" defaultValue={actionData?.email} aria-invalid={actionData ? true : undefined} />
      {actionData && <p role="alert">{actionData.error}</p>}
      <button type="submit">Send</button>
    </GioForm>
  );
}`} />
      <p>
        A page that exports <code>action</code> answers <code>POST</code> requests to its URL
        by running it. A plain <code>&lt;form method=&quot;post&quot;&gt;</code> posts there
        without any JavaScript, and <code>&lt;GioForm&gt;</code> does the same through the
        client router once the page has hydrated. The function runs only on the server and is
        not part of the browser bundle.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <p>
        <code>req</code> (<code>{'ActionArgs<Route>'}</code>) is the request a{' '}
        <a href="/docs/page-exports/http-methods">route handler</a> receives, with{' '}
        <code>params</code> typed by <code>Route</code>:
      </p>
      <PropsTable kind="Field" rows={[
        { name: 'formData()', type: 'Promise<FormData>', description: <>Parses an <code>application/x-www-form-urlencoded</code> or <code>multipart/form-data</code> body. File fields are <code>File</code> objects. Any other content type throws <code>UnsupportedMediaTypeError</code> (<code>415</code> unless caught), a body that does not parse throws <code>MalformedBodyError</code> (<code>400</code>).</> },
        { name: 'json()', type: 'T', description: <>Parses a body sent as <code>application/json</code> or <code>application/*+json</code>; anything else throws <code>UnsupportedMediaTypeError</code> (<code>415</code>).</> },
        { name: 'body', type: 'string | null', description: <>The raw body: UTF-8 text, or base64 when <code>bodyBase64</code> is <code>true</code>.</> },
        { name: 'params', type: 'ParamsOf<Route>', description: 'The dynamic segments of the page.' },
        { name: 'query', type: 'Record<string, string>', description: 'The query string, one value per name: the last one when a name repeats.' },
        { name: 'headers', type: 'Record<string, string>', description: 'The request headers, names lowercase.' },
        { name: 'cookies', type: 'Record<string, string>', description: <>The <code>Cookie</code> header, parsed (<code>sessions.getSession(req)</code> reads it).</> },
        { name: 'method, path', type: 'string', description: <><code>method</code> is always <code>&apos;POST&apos;</code>; <code>path</code> is the routed path.</> },
        { name: 'locale, ip, scheme, host, requestId', type: 'string | undefined', description: <>As on a <a href="/docs/page-exports/http-methods#parameters">route handler&apos;s request</a>.</> },
      ]} />

      <h3 id="returns">Returns</h3>
      <table>
        <thead><tr><th>Return value</th><th>Answer</th></tr></thead>
        <tbody>
          <tr><td><code>redirect(url, init?)</code></td><td><code>303 See Other</code> to <code>url</code> (or <code>301</code>, <code>302</code>, <code>307</code>, <code>308</code>), with <code>init.headers</code>. May also be thrown, from the action or anything it calls.</td></tr>
          <tr><td><code>{'{ data, status?, headers? }'}</code></td><td>Re-renders the page with <code>data</code> as its <code>actionData</code> prop, answering <code>status</code> (default <code>200</code>) with <code>headers</code>. Only an object whose keys are <code>data</code> plus at most <code>status</code> and <code>headers</code> counts as this form.</td></tr>
          <tr><td>Any other value</td><td>Re-renders the page with that value as <code>actionData</code>, status <code>200</code>. <code>undefined</code> and <code>null</code> give <code>actionData: null</code>.</td></tr>
          <tr><td>A web <code>Response</code></td><td>Sent as it is: status, headers and body (binary bodies included). The page does not render. Without a <code>Content-Type</code> it is sent as <code>text/plain; charset=utf-8</code>.</td></tr>
        </tbody>
      </table>
      <p>
        A re-render&apos;s <code>status</code> must be a <code>2xx</code> other than{' '}
        <code>204</code>/<code>205</code>, or a <code>4xx</code>/<code>5xx</code>. Anything else
        is a programming error that answers <code>500</code> and logs{' '}
        <code>action returned status 302 - a re-render answers 2xx (not 204/205) or 4xx/5xx; use redirect() for 3xx, or return a Response</code>.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>POST only.</strong> <code>PUT</code>, <code>PATCH</code> and{' '}
          <code>DELETE</code> to the page answer <code>405</code> with{' '}
          <code>Allow: GET, HEAD, POST</code> (a page without an action allows{' '}
          <code>GET, HEAD</code>). A <code>route.ts</code> in the same folder that exports{' '}
          <code>POST</code> takes the request instead; one that does not passes it on to the
          action, and a <code>405</code> from that folder lists both files&apos; methods.
        </li>
        <li>
          <strong>The re-render.</strong> <code>getServerSideProps</code> runs for it with the
          result in <code>ctx.actionData</code> and <code>ctx.method</code> set to{' '}
          <code>&apos;POST&apos;</code>. The page receives an <code>actionData</code> prop, unless{' '}
          <code>getServerSideProps</code> returned a prop of that name itself. Metadata,
          layouts and boundaries render as for a <code>GET</code>.
        </li>
        <li>
          <strong>Headers carry through.</strong> Headers the action returns with its data (a
          session cookie, a flash message) are sent with whatever answers in the end: the
          re-rendered page, or a redirect, 404 or error page from{' '}
          <code>getServerSideProps</code>. Headers the page returns win a clash; cookies add up.
        </li>
        <li>
          <strong>Errors.</strong> <code>notFound()</code> answers <code>404</code> with the
          nearest <code>not-found.tsx</code>; any other thrown error answers <code>500</code>{' '}
          with the nearest <code>error.tsx</code>, as during a render.
        </li>
        <li>
          <strong>Never cached.</strong> Neither the action&apos;s answer nor the page it
          re-renders is stored, even when the page exports <code>revalidate</code>.
        </li>
        <li>
          <strong>GioForm redirects.</strong> A <code>POST</code> from <code>&lt;GioForm&gt;</code>{' '}
          carries <code>x-gio-form: 1</code>, and the server answers its <code>301</code>,{' '}
          <code>302</code> and <code>303</code> redirects with a <code>204</code> that names the
          target in <code>x-gio-redirect</code>, cookies kept, so <code>fetch</code> does not
          follow a redirect to another site itself. A plain form post gets the real redirect.
        </li>
        <li>
          <strong>Checks before it runs.</strong> The Rust server refuses a cross-site{' '}
          <code>POST</code> with <code>403</code> (<a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a>),
          a body over <code>[server] max_body_bytes</code> with <code>413</code>, and a request
          over a rate limit with <code>429</code>, before the action runs.
        </li>
      </ul>

      <h3 id="types">Types</h3>
      <table>
        <thead><tr><th>Type</th><th>What it types</th></tr></thead>
        <tbody>
          <tr><td><code>ActionArgs</code></td><td><code>{'ActionArgs<Route>'}</code>: the request. <code>Route</code> is a pattern of your app (<code>{"'/posts/:id'"}</code>) or a params shape.</td></tr>
          <tr><td><code>ActionResult</code></td><td><code>{'ActionResult<Data>'}</code>: everything an action may return.</td></tr>
          <tr><td><code>ActionDataResult</code></td><td><code>{'ActionDataResult<Data>'}</code>: the <code>{'{ data, status?, headers? }'}</code> form.</td></tr>
          <tr><td><code>ActionData</code></td><td><code>{'ActionData<typeof action>'}</code>: the <code>actionData</code> the page receives. <code>Response</code> and <code>redirect()</code> results never re-render, so they are left out.</td></tr>
          <tr><td><code>WithActionData</code></td><td><code>{'WithActionData<typeof action, Props>'}</code>: <code>Props</code> plus an optional, typed <code>actionData</code>.</td></tr>
        </tbody>
      </table>

      <h2 id="examples">Examples</h2>
      <h3 id="several-buttons-in-one-form">Several buttons in one form</h3>
      <p>The clicked button&apos;s <code>name</code> and <code>value</code> are part of the form data:</p>
      <CodeBlock lang="tsx" title="app/lists/[id]/page.tsx" code={`import { redirect, type ActionArgs, type GetServerSideProps, type InferPageProps } from '@gio.js/core';
import { GioForm } from '@gio.js/react';
import { db, type Todo } from '../../../lib/db.server.ts';

export async function action(req: ActionArgs<'/lists/:id'>) {
  const form = await req.formData();
  const deleteId = form.get('delete');                 // sent only by a Delete button
  if (deleteId !== null) {
    await db.todos.delete(String(deleteId));
  } else {
    await db.todos.insert({ list: req.params.id, title: String(form.get('title') ?? '') });
  }
  return redirect(\`/lists/\${req.params.id}\`);         // reload-safe: the browser GETs the list
}

export const getServerSideProps: GetServerSideProps<{ todos: Todo[] }, '/lists/:id'> = async (ctx) => ({
  props: { todos: await db.todos.inList(ctx.params.id) },
});

export default function List({ todos }: InferPageProps<typeof getServerSideProps>) {
  return (
    <GioForm>
      <input name="title" aria-label="New todo" />
      <button>Add</button>{/* first in the form: Enter in the field adds */}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            {todo.title} <button name="delete" value={todo.id}>Delete</button>
          </li>
        ))}
      </ul>
    </GioForm>
  );
}`} />

      <h3 id="set-a-cookie-on-the-way-out">Set a cookie on the way out</h3>
      <CodeBlock lang="tsx" title="app/login/page.tsx" code={`import { redirect, type ActionArgs, type WithActionData } from '@gio.js/core';
import { GioForm } from '@gio.js/react';
import { sessions } from '../../lib/session.server.ts';
import { verifyPassword } from '../../lib/users.server.ts';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const user = await verifyPassword(String(form.get('email')), String(form.get('password')));
  if (user === null) return { status: 401, data: { error: 'Wrong email or password' } };

  const session = sessions.getSession(req);
  session.set('userId', user.id);
  return redirect('/dashboard', { headers: { 'set-cookie': sessions.commitSession(session) } });
}

export default function Login({ actionData }: WithActionData<typeof action>) {
  return (
    <GioForm>
      <input name="email" type="email" autoComplete="username" aria-label="Email" />
      <input name="password" type="password" autoComplete="current-password" aria-label="Password" />
      {actionData && <p role="alert">{actionData.error}</p>}
      <button>Sign in</button>
    </GioForm>
  );
}`} />

      <h3 id="answer-with-your-own-response">Answer with your own Response</h3>
      <CodeBlock lang="tsx" title="app/export/page.tsx" code={`import { buildReport } from '../../lib/reports.server.ts';

export async function action() {
  const csv = await buildReport();
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="report.csv"',
    },
  });
}

// A plain form: the browser saves the file and stays on the page.
export default function ExportPage() {
  return (
    <form method="post">
      <button>Download the report</button>
    </form>
  );
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A URL from user input (a <code>?next=</code> parameter) must be checked before you
          redirect to it, or the action is an open redirect.
        </li>
        <li>
          Return the submitted values with a validation error and use them as{' '}
          <code>defaultValue</code>s: without JavaScript the browser shows a fresh form.
        </li>
        <li>
          After a failed submission <code>&lt;GioForm&gt;</code> moves focus to the first field
          marked <code>aria-invalid=&quot;true&quot;</code>.
        </li>
        <li>
          A static export has no server to run actions: <code>gio export</code> writes the
          page&apos;s <code>GET</code> render, and a form on it posts to the static host. Point
          such forms at an external endpoint instead.
        </li>
        <li>
          GioJS has no Server Actions (<code>&apos;use server&apos;</code>): an action belongs to
          one page and answers that page&apos;s URL. <code>gio migrate</code> turns Server
          Action forms into a <code>&lt;GioForm&gt;</code> posting to the page&apos;s action.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/forms">Forms and Mutations</a> - the guide</li>
        <li><a href="/docs/components/gio-form"><code>&lt;GioForm&gt;</code></a> and <a href="/docs/hooks/use-gio-form-state"><code>useGioFormState</code></a></li>
        <li><a href="/docs/functions/redirect"><code>redirect</code></a>, <a href="/docs/functions/not-found"><code>notFound</code></a>, <a href="/docs/functions/request-errors">request body errors</a></li>
        <li><a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a></li>
        <li><a href="/docs/page-exports/http-methods">Route handler methods</a> - for <code>PUT</code>, <code>PATCH</code> and <code>DELETE</code></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: 'Introduced.' },
      ]} />
    </>
  );
}
