import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '<GioForm>',
  description:
    'A form that posts to a page action, works without JavaScript, and once hydrated shows the answer through the client router without a reload.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>&lt;GioForm&gt;</h1>
      <p className="page-subtitle">
        A form that posts to a page action, works without JavaScript, and once hydrated shows
        the answer through the client router without a reload.
      </p>
      <CodeBlock lang="tsx" title="app/newsletter/page.tsx" code={`import { redirect, type ActionArgs } from '@gio.js/core';
import { GioForm } from '@gio.js/react';

export async function action(req: ActionArgs) {
  const email = String((await req.formData()).get('email') ?? '');
  await subscribers.add(email);
  return redirect('/newsletter/thanks');
}

export default function Newsletter() {
  return (
    <GioForm>
      <input type="email" name="email" required />
      <button>Subscribe</button>
    </GioForm>
  );
}`} />
      <p>
        <code>GioForm</code> renders <code>&lt;form method=&quot;post&quot;&gt;</code> with no{' '}
        <code>action</code> attribute unless you pass one, so the browser posts to the
        page&apos;s own URL, where the page&apos;s <a href="/docs/page-exports/action"><code>action</code></a>{' '}
        export runs. Before the page hydrates, that is a normal form post. After, the same
        fields are sent with <code>fetch</code> and the answer - the redirect target, or the
        page re-rendered with its <code>actionData</code> - is rendered in place like a soft
        navigation: layouts, focus and typed input survive.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="props">Props</h3>
      <PropsTable rows={[
        {
          name: 'action',
          type: 'string',
          default: 'the current URL',
          description: <>Where to post. Same-origin URLs are submitted through the router; others are left to the browser.</>,
        },
        {
          name: 'onSuccess',
          type: '(result: GioFormResult) => void',
          description: <>Called after an answer with a 2xx final status, a redirect&apos;s target included.</>,
        },
        {
          name: 'onError',
          type: '(result: GioFormResult) => void',
          description: <>Called after any other answer (a <code>422</code> re-render too) and after a failed request.</>,
        },
        {
          name: 'resetOnSuccess',
          type: 'boolean',
          default: 'false',
          description: <>Reset the fields after a successful submission that kept the form on screen.</>,
        },
        {
          name: 'reloadDocument',
          type: 'boolean',
          default: 'false',
          description: <>Never intercept: always a native, full-page post.</>,
        },
        {
          name: 'children',
          type: 'React.ReactNode | ((state: GioFormState) => React.ReactNode)',
          description: <>The fields, or a function of the <a href="#gioformstate">form state</a>.</>,
        },
        {
          name: 'onSubmit',
          type: 'React.FormEventHandler<HTMLFormElement>',
          description: <>Runs before the submission is sent. Call <code>event.preventDefault()</code> to cancel it.</>,
        },
        {
          name: 'ref',
          type: 'React.Ref<HTMLFormElement>',
          description: <>Forwarded to the <code>&lt;form&gt;</code>.</>,
        },
      ]} />
      <p>
        Every other <code>&lt;form&gt;</code> attribute passes through (<code>className</code>,{' '}
        <code>id</code>, <code>encType</code>, <code>noValidate</code>, <code>aria-*</code>, ...),
        except <code>method</code>, which is always <code>post</code>. The props type is exported
        as <code>GioFormProps</code>.
      </p>

      <h3 id="gioformstate"><code>GioFormState</code></h3>
      <p>
        <code>GioFormState</code> is what <a href="/docs/hooks/use-gio-form-state"><code>useGioFormState()</code></a> returns
        inside the form, and what function children receive.
      </p>
      <PropsTable kind="Field" rows={[
        { name: 'pending', type: 'boolean', description: 'A submission is in flight.' },
        { name: 'lastResult', type: 'GioFormResult | null', description: <>How the last finished submission ended; <code>null</code> before the first.</> },
      ]} />

      <h3 id="gioformresult"><code>GioFormResult</code></h3>
      <p><code>GioFormResult</code> is what <code>onSuccess</code> and <code>onError</code> receive, and <code>lastResult</code> holds.</p>
      <PropsTable kind="Field" rows={[
        { name: 'ok', type: 'boolean', description: <>The final status is 2xx.</> },
        { name: 'status', type: 'number', description: <>The final response&apos;s status, after redirects. <code>0</code> when the request failed. For a redirect the browser follows itself (another site), the submission&apos;s own 2xx.</> },
        { name: 'url', type: 'string', description: <>Path and query of the final response - the page now shown. A redirect to another site gives its absolute URL.</> },
        { name: 'redirected', type: 'boolean', description: 'The action answered with a redirect.' },
        { name: 'data', type: 'unknown', description: <>The <code>actionData</code> of the page the answer rendered, if any.</> },
        { name: 'response', type: 'Response', description: <>The answer when it was not a GioJS page, such as an action&apos;s <code>Response.json(...)</code>.</> },
        { name: 'error', type: 'unknown', description: <>Why the request failed (a network error, or a redirect to a URL that is not <code>http(s)</code>).</> },
      ]} />

      <h3 id="what-is-intercepted">What is intercepted</h3>
      <p>
        Once the page has hydrated, <code>GioForm</code> calls your <code>onSubmit</code>, then
        takes over the submission unless one of these leaves it to the browser:
      </p>
      <ul>
        <li><code>onSubmit</code> called <code>preventDefault()</code> (then nothing is sent at all), or <code>reloadDocument</code> is set;</li>
        <li>the form or the clicked button has a <code>target</code> other than <code>_self</code> (<code>formTarget</code> on the button);</li>
        <li>the clicked button switches the method to <code>get</code> or <code>dialog</code> (<code>formMethod</code>);</li>
        <li>the <code>action</code> (or the button&apos;s <code>formAction</code>) is on another origin.</li>
      </ul>
      <p>
        The body is what the browser would send: every field plus the clicked button&apos;s{' '}
        <code>name</code>/<code>value</code>, URL-encoded - or <code>FormData</code> when{' '}
        <code>encType</code> (or the button&apos;s <code>formEncType</code>) is{' '}
        <code>multipart/form-data</code>. The request carries <code>x-gio-form: 1</code> and the
        page&apos;s <code>x-deployment-id</code>. The server answers its 301/302/303 redirects with
        a <code>204</code> that names the target in <code>x-gio-redirect</code>, so{' '}
        <code>fetch</code> does not follow them itself.
      </p>

      <h3 id="how-answers-are-handled">How answers are handled</h3>
      <table>
        <thead><tr><th>Answer</th><th>On screen</th><th>Callback</th></tr></thead>
        <tbody>
          <tr>
            <td>The page re-rendered (data, or <code>{'{ status: 422, data }'}</code>)</td>
            <td>Swapped in; the history entry is replaced and the scroll position kept. After a non-2xx, focus moves to the first <code>[aria-invalid=&quot;true&quot;]</code> field.</td>
            <td><code>onSuccess</code> for 2xx, else <code>onError</code></td>
          </tr>
          <tr>
            <td>A redirect to a page of this app</td>
            <td>The target is fetched fresh and shown under its own URL, as a new history entry scrolled to the top.</td>
            <td>By the target&apos;s status</td>
          </tr>
          <tr>
            <td>A redirect to another site, or to something that is not a GioJS page</td>
            <td>The browser loads it (a <code>GET</code>). The form stays pending while the page unloads, unless the target is a download.</td>
            <td>By the status</td>
          </tr>
          <tr>
            <td>A 2xx that is not a page (<code>Response.json(...)</code>)</td>
            <td>Nothing changes.</td>
            <td><code>onSuccess</code>, with <code>result.response</code></td>
          </tr>
          <tr>
            <td>An error that is not a page (a <code>500</code>, a proxy&apos;s <code>504</code>, an error <code>Response</code>)</td>
            <td>Nothing changes and nothing is sent again: the action may already have run.</td>
            <td><code>onError</code>, with <code>result.response</code></td>
          </tr>
          <tr>
            <td>The server&apos;s own <code>413</code> or <code>429</code> (<code>x-gio-refused: unread</code>)</td>
            <td>Submitted again natively, so the browser shows the real response. The action never ran.</td>
            <td><code>onError</code>, first</td>
          </tr>
          <tr>
            <td>A <code>409</code> deployment-skew answer</td>
            <td>Submitted again natively, to the new build.</td>
            <td>None</td>
          </tr>
          <tr>
            <td>A network failure</td>
            <td>Nothing changes; the input stays.</td>
            <td><code>onError</code>, <code>status: 0</code></td>
          </tr>
        </tbody>
      </table>
      <p>
        While a submission is pending, further submits are dropped before your{' '}
        <code>onSubmit</code> runs, and the form carries <code>aria-busy=&quot;true&quot;</code>.
        Every submission empties the router&apos;s prefetch cache.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="validation-errors-and-a-pending-button">Validation errors and a pending button</h3>
      <CodeBlock lang="tsx" title="app/signup/page.tsx" code={`import { redirect, type ActionArgs, type WithActionData } from '@gio.js/core';
import { GioForm } from '@gio.js/react';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const name = String(form.get('name') ?? '').trim();
  if (name.length < 2) {
    return { status: 422, data: { error: 'Enter your name', name } };
  }
  await accounts.create(name);
  return redirect('/welcome');
}

export default function Signup({ actionData }: WithActionData<typeof action>) {
  return (
    <GioForm>
      {({ pending }) => (
        <>
          <input name="name" defaultValue={actionData?.name} aria-invalid={actionData?.error ? true : undefined} />
          {actionData?.error && <p role="alert">{actionData.error}</p>}
          <button disabled={pending}>{pending ? 'Creating...' : 'Create account'}</button>
        </>
      )}
    </GioForm>
  );
}`} />

      <h3 id="several-buttons-one-form">Several buttons, one form</h3>
      <p>The clicked button&apos;s <code>name</code> and <code>value</code> are sent, as in a native post.</p>
      <CodeBlock lang="tsx" title="app/todos/page.tsx" code={`import { redirect, type ActionArgs } from '@gio.js/core';
import { GioForm } from '@gio.js/react';

interface Todo {
  id: string;
  title: string;
}

export async function getServerSideProps() {
  return { props: { items: await todos.list() } };
}

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const id = String(form.get('id'));
  if (form.get('intent') === 'delete') await todos.remove(id);
  else await todos.complete(id);
  return redirect('/todos');
}

export default function Todos({ items }: { items: Todo[] }) {
  return (
    <ul>
      {items.map((todo) => (
        <li key={todo.id}>
          {todo.title}
          <GioForm>
            <input type="hidden" name="id" value={todo.id} />
            <button name="intent" value="done">Done</button>
            <button name="intent" value="delete">Delete</button>
          </GioForm>
        </li>
      ))}
    </ul>
  );
}`} />

      <h3 id="posting-to-a-route-handler">Posting to a route handler</h3>
      <p>
        An <code>action</code> prop can point at a <code>route.ts</code>. A JSON answer is not a
        page, so nothing changes on screen: read it in <code>onSuccess</code>.
      </p>
      <CodeBlock lang="tsx" title="app/feedback-form.tsx" code={`import { useState } from 'react';
import { GioForm } from '@gio.js/react';

export function FeedbackForm() {
  const [ticket, setTicket] = useState<string | null>(null);
  return (
    <GioForm
      action="/api/feedback"
      resetOnSuccess
      onSuccess={async (result) => {
        const body = (await result.response?.json()) as { ticket: string } | undefined;
        setTicket(body?.ticket ?? null);
      }}
      onError={(result) => console.error('feedback failed', result.status)}
    >
      <textarea name="message" required />
      <button>Send</button>
      {ticket && <p>Thanks - ticket {ticket}</p>}
    </GioForm>
  );
}`} />
      <CodeBlock lang="ts" title="app/api/feedback/route.ts" code={`import type { GioRequest } from '@gio.js/core';

export async function POST(req: GioRequest) {
  const message = String((await req.formData()).get('message') ?? '');
  const ticket = await tickets.open(message);
  return Response.json({ ticket }, { status: 201 });
}`} />
      <p>
        Without JavaScript the browser posts the same form and shows the JSON. Give such forms a
        page action when they must work before hydration.
      </p>

      <h3 id="uploading-files">Uploading files</h3>
      <CodeBlock lang="tsx" code={`<GioForm encType="multipart/form-data">
  <input type="file" name="avatar" accept="image/png,image/jpeg" />
  <button>Upload</button>
</GioForm>`} />
      <p>
        The request body is limited by <code>[server] max_body_bytes</code> (2 MiB by default);
        see <a href="/docs/forms#file-uploads">File uploads</a>.
      </p>

      <h3 id="a-native-post-for-downloads">A native post for downloads</h3>
      <CodeBlock lang="tsx" code={`<GioForm action="/api/export" reloadDocument>
  <button>Export as CSV</button>
</GioForm>`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>In the root layout a <code>GioForm</code> is a plain form.</strong> The root
          layout never hydrates, so a form there always does a full-page post.
        </li>
        <li>
          <code>method</code> is fixed to <code>post</code>. For a search form that puts its
          fields in the URL, use a plain <code>&lt;form method=&quot;get&quot;&gt;</code>, or{' '}
          <code>router.push()</code> from an <code>onSubmit</code>.
        </li>
        <li>
          Without an <code>action</code> prop the form posts to the current URL, query string
          included.
        </li>
        <li>
          A submission is never sent twice once the action may have run. Only answers the
          server marks as refused before any handler ran (<code>x-gio-refused: unread</code>)
          and deployment skew are re-submitted. A <code>413</code> or <code>429</code> your own
          action or <code>route.ts</code> returns is not marked, so it is not re-sent.
        </li>
        <li>
          Cross-site posts are refused with <code>403</code> before the action runs (
          <a href="/docs/configuration/security-csrf">CSRF protection</a>, on by default). A{' '}
          <code>GioForm</code> on your own pages always passes.
        </li>
        <li>
          Action answers are never cached, also on a page that exports{' '}
          <code>revalidate</code>. Purge cached pages that show the changed data with{' '}
          <a href="/docs/functions/revalidate-path"><code>revalidatePath()</code></a> before
          redirecting.
        </li>
        <li>
          A <a href="/docs/static-export">static export</a> has no server to run actions: point
          the form at an external endpoint.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/forms">Forms and Mutations</a> - the guide: actions, validation, sessions, uploads, testing.</li>
        <li><a href="/docs/page-exports/action"><code>action</code></a> - the page export the form posts to.</li>
        <li><a href="/docs/hooks/use-gio-form-state"><code>useGioFormState</code></a> - the pending state in child components.</li>
        <li><a href="/docs/functions/redirect"><code>redirect</code></a> - Post/Redirect/Get.</li>
        <li><a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a> - which cross-site posts are refused.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
