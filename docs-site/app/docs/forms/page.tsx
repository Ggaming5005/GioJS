import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Forms and Mutations',
  description:
    'Page actions and <GioForm>: forms that work without JavaScript and feel instant with it.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Forms and Mutations</h1>
      <p className="page-subtitle">Page actions and &lt;GioForm&gt;: forms that work without JavaScript and feel instant with it.</p>

      <p>
        A page can handle its own form posts. Export an async <code>action</code> from{' '}
        <code>page.tsx</code>: a <code>POST</code> to the page&apos;s URL runs it. Render the form
        with <code>&lt;GioForm&gt;</code> from <code>@gio.js/react</code> - a real{' '}
        <code>&lt;form method=&quot;post&quot;&gt;</code>, so it works before (or without) any
        JavaScript, and submits through the client router once the page has hydrated.
      </p>
      <CodeBlock lang="tsx" title="app/contact/page.tsx" code={`import { redirect, type ActionArgs, type WithActionData } from '@gio.js/core';
import { GioForm, useGioFormState } from '@gio.js/react';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim();
  const message = String(form.get('message') ?? '');
  if (!email.includes('@')) {
    return { status: 422, data: { errors: { email: 'Enter a valid email' }, values: { email, message } } };
  }
  await db.messages.insert({ email, message });
  return redirect('/contact/thanks');           // 303 See Other
}

function SubmitButton() {
  const { pending } = useGioFormState();
  return <button type="submit" disabled={pending}>{pending ? 'Sending...' : 'Send'}</button>;
}

export default function Contact({ actionData }: WithActionData<typeof action>) {
  const errors = actionData?.errors;
  return (
    <main>
      <h1>Contact us</h1>
      <GioForm>
        <input name="email" defaultValue={actionData?.values.email} aria-invalid={errors?.email ? true : undefined} />
        {errors?.email && <p role="alert">{errors.email}</p>}
        <textarea name="message" defaultValue={actionData?.values.message} />
        <SubmitButton />
      </GioForm>
    </main>
  );
}`} />

      <h2 id="progressive-enhancement">Progressive enhancement</h2>
      <p>
        <code>&lt;GioForm&gt;</code> renders <code>method=&quot;post&quot;</code> and no{' '}
        <code>action</code> attribute (unless you pass one), so the browser posts to the
        page&apos;s own URL. What happens next depends on whether the page has hydrated:
      </p>
      <ul>
        <li>
          <strong>Without JavaScript</strong> (or before the bundle loads): a normal form post.
          The browser follows the action&apos;s redirect, or shows the re-rendered page.
        </li>
        <li>
          <strong>Hydrated</strong>: <code>GioForm</code> sends the same fields with{' '}
          <code>fetch</code> - the clicked button&apos;s <code>name</code>/<code>value</code>{' '}
          included, <code>formAction</code> / <code>formEncType</code> honored - and renders the
          answer like a soft navigation. A redirect&apos;s target is shown under its own URL; a
          re-render replaces the current history entry and keeps the scroll position. Layouts,
          the form itself and whatever the user typed survive, because the page is reconciled in
          the persistent React root instead of reloaded.
        </li>
      </ul>
      <p>
        Plain <code>&lt;form method=&quot;post&quot;&gt;</code> elements post to actions too - they
        just always do a full page load.
      </p>

      <h2 id="writing-an-action">Writing an action</h2>
      <p>
        <code>action(req)</code> receives the same request object as a{' '}
        <a href="/docs/route-handlers">route handler</a> - <code>params</code>,{' '}
        <code>query</code>, <code>headers</code>, <code>cookies</code>, <code>ip</code>, ... -
        plus <code>formData()</code>, which parses <code>application/x-www-form-urlencoded</code>{' '}
        and <code>multipart/form-data</code> bodies into a web-standard <code>FormData</code>{' '}
        (file fields are <code>File</code> objects). A body sent as anything else answers{' '}
        <code>415</code> unless you catch the error; a malformed one answers <code>400</code>.
        Type the params with <code>ActionArgs&lt;{'{ id: string }'}&gt;</code>.
      </p>
      <p>What the action returns decides the answer:</p>
      <ul>
        <li>
          <code>redirect(url)</code> - a <code>303 See Other</code>. Pass a status (301, 302,
          303, 307, 308) or <code>{'{ status, headers }'}</code> as the second argument.{' '}
          <code>redirect()</code> may also be thrown, from the action or anything it calls.
        </li>
        <li>
          <code>{'{ status, data, headers }'}</code> - an object whose keys are <code>data</code>{' '}
          and optionally <code>status</code> / <code>headers</code> - re-renders the page with{' '}
          <code>data</code> as its <code>actionData</code> prop, answering with{' '}
          <code>status</code> (default 200; 2xx or 4xx/5xx).
        </li>
        <li>
          Any other value - re-renders the page with that value as <code>actionData</code>, status
          200. Returning nothing gives <code>actionData: null</code>.
        </li>
        <li>
          A web <code>Response</code> - sent as is (status, headers, body; binary bodies work).
        </li>
      </ul>
      <p>
        <code>notFound()</code> answers 404 with the nearest <code>not-found.tsx</code>, and a
        thrown error answers 500 with the nearest <code>error.tsx</code>, exactly as during a
        render. <code>getServerSideProps</code> still runs for a re-render and sees the result
        as <code>ctx.actionData</code> (<code>ctx.method</code> is <code>&apos;POST&apos;</code>);
        if it returns an <code>actionData</code> prop itself, that one wins.
      </p>
      <p>
        Only <code>POST</code> runs an action - it is all an HTML form sends besides{' '}
        <code>GET</code>. <code>PUT</code>/<code>PATCH</code>/<code>DELETE</code> to a page answer{' '}
        <code>405</code> (with <code>Allow: GET, HEAD, POST</code>); give those their own{' '}
        <code>route.ts</code>. A page without an <code>action</code> answers every mutation with{' '}
        <code>405</code>. A <code>route.ts</code> in the same folder that exports{' '}
        <code>POST</code> takes the POST; one that does not passes it on to the action (and a
        405 from that folder lists both files&apos; methods).
      </p>
      <p>
        Headers the action returns with its data are sent whatever answers in the end: the
        re-rendered page, or a redirect, 404 or error page that replaces it.{' '}
        <code>redirect()</code> works in <code>getServerSideProps</code> too, returned or
        thrown - see <a href="/docs/fetching-data">Data Fetching</a>.
      </p>

      <h2 id="redirect-after-a-change-postredirectget">Redirect after a change (Post/Redirect/Get)</h2>
      <p>
        After an action changes something, answer with <code>redirect()</code>. The 303 makes the
        browser <code>GET</code> the target, so reloading it never asks to resubmit the form and
        the back button behaves. Redirect to the same page to show the new state there:
      </p>
      <CodeBlock lang="tsx" code={`export async function action(req: ActionArgs<{ id: string }>) {
  const form = await req.formData();
  if (form.get('intent') === 'delete') {
    await db.todos.delete(String(form.get('todoId')));
  } else {
    await db.todos.insert({ list: req.params.id, title: String(form.get('title')) });
  }
  return redirect(\`/lists/\${req.params.id}\`);
}

// Two buttons, one form: the clicked one's name/value is sent.
<GioForm>
  <input type="hidden" name="todoId" value={todo.id} />
  <button name="intent" value="delete">Delete</button>
</GioForm>`} />
      <p>
        A URL from user input (a <code>?next=</code> parameter) must be checked before you
        redirect to it - otherwise the action is an open redirect.
      </p>
      <p>
        Redirects to other sites - a payment page, an identity provider - work from{' '}
        <code>GioForm</code> as well. Its requests carry <code>x-gio-form: 1</code>, and the
        server answers their 301/302/303 redirects with a <code>204</code> naming the target in{' '}
        <code>x-gio-redirect</code> (cookies included) instead: <code>fetch</code> would
        otherwise follow the redirect itself and fail the cross-origin check after the action
        had already run. <code>GioForm</code> then fetches a same-origin target (revalidating
        the HTTP cache) and hands any other to the browser. A 307/308, which repeats the POST,
        is still followed by <code>fetch</code>. Plain form posts always get the real redirect.
      </p>

      <h2 id="validation-errors">Validation errors</h2>
      <p>
        Return <code>{'{ status: 422, data }'}</code> to show the form again with errors. The
        page re-renders with <code>actionData</code> - on the server for a plain post, swapped
        in place for <code>GioForm</code> - and the hydrated page receives the same prop. Send
        back the submitted values too and use them as <code>defaultValue</code>s: without
        JavaScript the browser shows a fresh form.
      </p>
      <p>
        <code>WithActionData&lt;typeof action, Props&gt;</code> adds an optional, typed{' '}
        <code>actionData</code> to your props; <code>ActionData&lt;typeof action&gt;</code> is
        the type alone. Both leave out the <code>Response</code> and <code>redirect()</code>{' '}
        branches, which never re-render. After a failed submission <code>GioForm</code> moves
        focus to the first field marked <code>aria-invalid=&quot;true&quot;</code> (unless the
        page moved it); put error text in a <code>role=&quot;alert&quot;</code> element so
        screen readers announce it.
      </p>

      <h2 id="gioform">GioForm</h2>
      <p>
        Every <code>&lt;form&gt;</code> prop passes through (<code>className</code>,{' '}
        <code>encType</code>, <code>id</code>, ...), plus:
      </p>
      <ul>
        <li><code>action</code> - where to post; default the current page.</li>
        <li><code>onSuccess(result)</code> - after a 2xx answer, a redirect&apos;s target included.</li>
        <li><code>onError(result)</code> - after any other answer (a 422 re-render too) or a failed request.</li>
        <li><code>resetOnSuccess</code> - clear the fields after a successful submission that kept the form on screen.</li>
        <li><code>reloadDocument</code> - never intercept: always a native, full page post (file downloads, for one).</li>
        <li>children may be a function of the state: <code>{'{({ pending }) => ...}'}</code>.</li>
      </ul>
      <p>
        <code>useGioFormState()</code>, called anywhere inside the form, returns{' '}
        <code>{'{ pending, lastResult }'}</code>. <code>lastResult</code> (also what the
        callbacks receive) has <code>ok</code>, <code>status</code>, <code>url</code>,{' '}
        <code>redirected</code>, the rendered page&apos;s <code>data</code> (its{' '}
        <code>actionData</code>), and <code>response</code> or <code>error</code> where they
        apply. While a submission is pending, further submits are ignored and the form has{' '}
        <code>aria-busy=&quot;true&quot;</code> (style it with{' '}
        <code>form[aria-busy=&quot;true&quot;]</code>).
      </p>
      <p>
        Answers the router cannot render fall back to what the browser would do - but a
        submission is never sent twice when the action may already have run:
      </p>
      <ul>
        <li>
          A redirect to another site, or to something that is not a GioJS page (a file, JSON) -
          loaded as a full page (a <code>GET</code>). The form stays pending while the page
          unloads, unless the target is a download (<code>Content-Disposition: attachment</code>)
          or the back/forward cache brings the page back.
        </li>
        <li>
          A refusal that comes before the action runs - the server&apos;s 413 for a too-large
          upload, a 429 from its rate limiter (both marked{' '}
          <code>x-gio-refused: unread</code>), a deployment change - <code>onError</code> runs
          (for the 413 and 429), then the form is submitted natively so the browser shows the
          real response.
        </li>
        <li>
          Any other error that is not a GioJS page - a 500 when the action threw (and no{' '}
          <code>error.tsx</code> rendered it), a 502/504 from a proxy or a timeout while the
          action may still be running, an error <code>Response</code> the action returned (a
          413 or 429 of its own included) -
          goes to <code>onError</code> with <code>result.response</code>. Nothing changes on
          screen and nothing is re-sent: show the failure from <code>lastResult</code>.
        </li>
        <li>
          A 2xx that is not a page (an action returning <code>Response.json(...)</code>) - goes to{' '}
          <code>onSuccess</code> as <code>result.response</code>; nothing changes on screen and
          nothing is sent twice.
        </li>
        <li>A network failure - <code>onError</code> with <code>status: 0</code>; the form stays as it is.</li>
      </ul>

      <h2 id="file-uploads">File uploads</h2>
      <p>
        Set <code>encType=&quot;multipart/form-data&quot;</code> - the browser needs it to send
        file contents, with or without JavaScript - and read the files from{' '}
        <code>formData()</code>:
      </p>
      <CodeBlock lang="tsx" code={`export async function action(req: ActionArgs) {
  const file = (await req.formData()).get('avatar');
  if (!(file instanceof File) || file.size === 0) {
    return { status: 422, data: { error: 'Choose an image' } };
  }
  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    return { status: 422, data: { error: 'PNG or JPEG only' } };
  }
  await storage.put(\`avatars/\${crypto.randomUUID()}\`, Buffer.from(await file.arrayBuffer()));
  return redirect('/settings');
}

<GioForm encType="multipart/form-data">
  <input type="file" name="avatar" accept="image/png,image/jpeg" />
  <button>Upload</button>
</GioForm>`} />
      <p>
        The whole request body is limited by <code>max_body_bytes</code> in{' '}
        <code>gio.toml</code>&apos;s <code>[server]</code> section (default 2 MiB): the Rust
        server answers <code>413 Payload Too Large</code> before the action runs. Raise it for
        larger uploads - the body is buffered in memory and handed to the worker in one piece
        (binary bodies base64-encoded, so above roughly 48 MiB a body is a 413 whatever the
        setting says). Send large media straight to object storage (a presigned URL)
        instead. Never trust{' '}
        <code>file.name</code> or <code>file.type</code>: they are whatever the client sent.
      </p>

      <h2 id="security">Security</h2>
      <ul>
        <li>
          Cross-site form posts are refused with <code>403</code> in the Rust server before the
          action runs (CSRF protection, on by default - see{' '}
          <a href="/docs/security">Security</a>). Same-origin posts, with or without JavaScript,
          pass. An endpoint other sites post to on purpose (an OAuth <code>form_post</code>{' '}
          callback) goes in <code>[security.csrf] exempt</code>.
        </li>
        <li>
          Action answers and the pages they re-render are never cached, even on a page that
          exports <code>revalidate</code>, and never replace the page&apos;s cached entry.
        </li>
        <li>
          <code>action</code> and everything only it imports are left out of the client bundle,
          like <code>getServerSideProps</code>. Still validate every field on the server: the
          action is a public endpoint anyone can post to.
        </li>
      </ul>

      <h2 id="sessions-and-cookies">Sessions and cookies</h2>
      <p>
        Read the session with <code>getSession(req)</code> and send cookies through the
        redirect&apos;s (or re-render&apos;s) <code>headers</code> - see{' '}
        <a href="/docs/authentication">Authentication</a>:
      </p>
      <CodeBlock lang="tsx" title="app/login/page.tsx" code={`import { redirect, type ActionArgs, type WithActionData } from '@gio.js/core';
import { GioForm } from '@gio.js/react';
import { sessions } from '../../lib/session.server.ts';

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
      {actionData?.error && <p role="alert">{actionData.error}</p>}
      <input name="email" type="email" autoComplete="username" />
      <input name="password" type="password" autoComplete="current-password" />
      <button>Log in</button>
    </GioForm>
  );
}`} />

      <h2 id="fresh-data-after-a-mutation">Fresh data after a mutation</h2>
      <p>
        <code>GioForm</code> drops the router&apos;s prefetched pages when it posts, and the page
        it shows next is fetched fresh. Pages cached in the Rust server (<code>revalidate</code>)
        keep serving their cached copy until it expires: purge them from the action with{' '}
        <code>revalidatePath()</code> / <code>revalidateTag()</code> from{' '}
        <code>@gio.js/core</code> (on-demand revalidation - see{' '}
        <a href="/docs/caching">Caching</a>) before redirecting.
      </p>
      <CodeBlock lang="tsx" code={`import { redirect, revalidatePath, type ActionArgs } from '@gio.js/core';

export async function action(req: ActionArgs) {
  await db.posts.publish(String((await req.formData()).get('postId')));
  revalidatePath('/blog');                    // the cached blog index shows it now
  return redirect('/blog');
}`} />

      <h2 id="static-export">Static export</h2>
      <p>
        Actions run in the server. A site deployed with <code>gio export</code> to a static host
        has no server to post to - point such forms at an external endpoint instead.
      </p>

      <h2 id="testing">Testing</h2>
      <p>
        <code>callRoute</code> from <code>@gio.js/core/testing</code> posts to pages too: a{' '}
        <code>URLSearchParams</code> body is sent as a form.
      </p>
      <CodeBlock lang="ts" code={`import { callRoute } from '@gio.js/core/testing';

it('rejects an invalid email with 422', async () => {
  const res = await callRoute('/contact', {
    method: 'POST',
    body: new URLSearchParams({ email: 'nope', message: 'hi' }),
  });
  expect(res.status).toBe(422);
  expect(await res.text()).toContain('Enter a valid email');
});

it('redirects after sending', async () => {
  const res = await callRoute('/contact', {
    method: 'POST',
    body: new URLSearchParams({ email: 'ada@example.com', message: 'hi' }),
  });
  expect(res.status).toBe(303);
  expect(res.headers['location']).toBe('/contact/thanks');
});`} />
    </>
  );
}
