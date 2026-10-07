import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'redirect',
  description:
    'Answer a page action or getServerSideProps with a redirect to another URL - 303 See Other by default, optionally with cookies.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>redirect</h1>
      <p className="page-subtitle">
        Answer a page action or <code>getServerSideProps</code> with a redirect to another
        URL - <code>303 See Other</code> by default, optionally with cookies.
      </p>
      <CodeBlock lang="tsx" title="app/contact/page.tsx" code={`import { redirect, type ActionArgs } from '@gio.js/core';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  await saveMessage(String(form.get('message')));
  return redirect('/contact/thanks');
}`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'url',
          type: 'string',
          required: true,
          description: (
            <>
              Where the browser goes: a path (<code>/thanks</code>,{' '}
              <code>/login?next=%2Fcart</code>) or an absolute URL. It is sent as the{' '}
              <code>Location</code> header exactly as written.
            </>
          ),
        },
        {
          name: 'init',
          type: 'number | RedirectInit',
          default: '303',
          description: (
            <>
              A status code, or an object with <code>status</code> and{' '}
              <code>headers</code> (below).
            </>
          ),
        },
      ]} />
      <h3 id="redirectinit">RedirectInit</h3>
      <PropsTable kind="Field" rows={[
        {
          name: 'status',
          type: 'number',
          default: '303',
          description: (
            <>
              <code>301</code>, <code>302</code>, <code>303</code>, <code>307</code> or{' '}
              <code>308</code>. Anything else throws.
            </>
          ),
        },
        {
          name: 'headers',
          type: 'Record<string, string | string[]>',
          description: (
            <>
              Extra response headers, for example a <code>set-cookie</code> from{' '}
              <code>commitSession()</code>. Each <code>set-cookie</code> array entry is sent as
              its own header; other arrays are joined with <code>, </code>.
            </>
          ),
        },
      ]} />

      <h3 id="returns">Returns</h3>
      <p>
        An <code>ActionRedirect</code> object. It does nothing by itself: the renderer acts on
        it when an <code>action</code> or <code>getServerSideProps</code> returns it or
        throws it. Throwing is what makes it useful in shared helpers - a{' '}
        <code>requireUser()</code> deep inside a loader can end the request.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The response has the chosen status, the <code>Location</code> header, any headers
          you passed and an empty body. It is never cached.
        </li>
        <li>
          The default <code>303</code> makes the browser follow with a <code>GET</code>, so
          reloading the target never re-submits the form (the Post/Redirect/Get pattern).
          Use <code>307</code> or <code>308</code> only when the browser must repeat the
          original method and body.
        </li>
        <li>
          A <code>{'<GioForm>'}</code> submission (it sends <code>x-gio-form: 1</code>) gets a{' '}
          <code>301</code>, <code>302</code> or <code>303</code> as a <code>204</code> with
          the target in <code>x-gio-redirect</code> instead, cookies included. The form
          then shows the target through the client router, or hands an off-site target to
          the browser. A plain HTML form post always receives the real redirect.
        </li>
        <li>
          When a page <code>action</code> ran first and returned headers (a flash cookie),
          they are sent along with a redirect that <code>getServerSideProps</code> answers
          afterwards.
        </li>
      </ul>

      <h3 id="errors">Errors</h3>
      <p>
        <code>redirect()</code> throws a <code>TypeError</code> when it is called, not when the
        response is sent:
      </p>
      <table>
        <thead><tr><th>Cause</th><th>Message</th></tr></thead>
        <tbody>
          <tr><td>Empty or non-string <code>url</code></td><td><code>redirect() needs a non-empty URL</code></td></tr>
          <tr><td>A control character (CR, LF, ...) in <code>url</code></td><td><code>redirect() URL contains control characters</code></td></tr>
          <tr><td>A status outside 301, 302, 303, 307, 308</td><td><code>redirect() status must be 301, 302, 303, 307 or 308 (got 304)</code></td></tr>
        </tbody>
      </table>

      <h2 id="isactionredirect">isActionRedirect</h2>
      <CodeBlock lang="ts" code={`isActionRedirect(value: unknown): value is ActionRedirect`} />
      <p>
        <code>isActionRedirect()</code> tells whether a value came from{' '}
        <code>redirect()</code>. Use it in a <code>catch</code> that must let redirects
        through - a thrown redirect is not an error. It checks a brand on the object rather
        than <code>instanceof</code>, because app modules load in their own module namespace
        and their copy of <code>@gio.js/core</code> may not be the renderer&apos;s.
      </p>
      <CodeBlock lang="ts" code={`import { isActionRedirect } from '@gio.js/core';

try {
  await checkout(cart);           // may throw redirect('/login')
} catch (err) {
  if (isActionRedirect(err)) throw err;
  return { status: 422, data: { error: 'Payment failed - try again.' } };
}`} />

      <h2 id="examples">Examples</h2>
      <h3 id="redirect-after-a-form-post">Redirect after a form post, with a cookie</h3>
      <CodeBlock lang="tsx" title="app/contact/page.tsx" code={`import { redirect, type ActionArgs, type WithActionData } from '@gio.js/core';
import { GioForm } from '@gio.js/react';
import { sessions } from '../../lib/session.server.ts';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const email = String(form.get('email') ?? '');
  if (!email.includes('@')) {
    return { status: 422, data: { error: 'Enter a valid email address.' } };
  }
  const session = sessions.getSession(req);
  session.set('flash', 'Thanks - we will get back to you.');
  return redirect('/contact/thanks', {
    headers: { 'set-cookie': sessions.commitSession(session) },
  });
}

export default function Contact({ actionData }: WithActionData<typeof action>) {
  return (
    <GioForm>
      <input name="email" type="email" />
      {actionData?.error && <p role="alert">{actionData.error}</p>}
      <button>Send</button>
    </GioForm>
  );
}`} />
      <h3 id="a-guard-shared-by-pages-and-actions">A guard shared by pages and actions</h3>
      <p>
        Throw the redirect from a helper. It works the same from{' '}
        <code>getServerSideProps</code> and from an <code>action</code>:
      </p>
      <CodeBlock lang="ts" title="lib/auth.server.ts" code={`import { redirect, type GetServerSidePropsContext } from '@gio.js/core';
import { sessions } from './session.server.ts';

export function requireUserId(ctx: Pick<GetServerSidePropsContext, 'cookies' | 'path'>): string {
  const userId = sessions.getSession(ctx).get('userId');
  if (userId === undefined) {
    throw redirect(\`/login?next=\${encodeURIComponent(ctx.path)}\`, 302);
  }
  return userId;
}`} />
      <CodeBlock lang="tsx" title="app/dashboard/page.tsx" code={`import type { GetServerSideProps, InferPageProps } from '@gio.js/core';
import { requireUserId } from '../../lib/auth.server.ts';

export const getServerSideProps = (async (ctx) => {
  const userId = requireUserId(ctx);
  return { props: { userId } };
}) satisfies GetServerSideProps;

export default function Dashboard({ userId }: InferPageProps<typeof getServerSideProps>) {
  return <h1>Hello {userId}</h1>;
}`} />
      <p>
        <code>GET /dashboard</code> without a session answers{' '}
        <code>302</code> with <code>Location: /login?next=%2Fdashboard</code>.
      </p>
      <h3 id="a-permanent-redirect">A permanent redirect</h3>
      <CodeBlock lang="ts" title="app/old-pricing/page.tsx" code={`import { redirect } from '@gio.js/core';

export function getServerSideProps() {
  return redirect('/pricing', 308);
}

export default function OldPricing() {
  return null;
}`} />
      <p>
        For a redirect that needs no code - a moved section, a renamed slug - prefer a{' '}
        <code>[[redirects]]</code> rule in <code>gio.toml</code> or a{' '}
        <code>redirects</code> entry in <a href="/docs/functions/define-middleware">middleware.ts</a>:
        the Rust server answers it before any Node code runs.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Only actions and <code>getServerSideProps</code>.</strong> A{' '}
          <code>route.ts</code> handler that returns <code>redirect()</code> answers{' '}
          <code>200</code> with the object as JSON, and one that throws it answers{' '}
          <code>500</code>. In a route handler, return a <code>Response</code>:{' '}
          <code>{"new Response(null, { status: 303, headers: { location: '/done' } })"}</code>.
        </li>
        <li>
          <strong>Open redirects.</strong> The URL is used as given. Check a target that comes
          from the request (a <code>?next=</code> parameter) before redirecting to it - for
          example, accept only paths that start with <code>/</code> and not <code>//</code>.
        </li>
        <li>
          <strong>Do not swallow it.</strong> A <code>try</code>/<code>catch</code> around code
          that throws a redirect must rethrow it - see{' '}
          <a href="#isactionredirect"><code>isActionRedirect</code></a>.
        </li>
        <li>
          <strong>The older object form still works.</strong>{' '}
          <code>{"return { redirect: { destination: '/login', permanent: false } }"}</code>{' '}
          from <code>getServerSideProps</code> answers <code>302</code> (<code>301</code> when{' '}
          <code>permanent</code>). <code>redirect()</code> adds the status choice, the
          headers, and throwing.
        </li>
        <li>
          <strong>Partial prerendering.</strong> On a cached PPR shell the <code>200</code> is
          already sent when <code>getServerSideProps</code> redirects, so the page finishes
          the redirect in the browser: a nonced <code>location.replace()</code>, or one reload
          that bypasses the shell when the redirect sets cookies.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/forms#redirect-after-a-change-postredirectget">Forms and Mutations: Post/Redirect/Get</a></li>
        <li><a href="/docs/fetching-data#redirects">Fetching Data: Redirects</a></li>
        <li><a href="/docs/guides/redirecting">Redirecting</a> - every way to redirect, compared</li>
        <li><a href="/docs/page-exports/action">action</a> and <a href="/docs/page-exports/get-server-side-props">getServerSideProps</a></li>
        <li><a href="/docs/functions/not-found">notFound</a></li>
        <li><a href="/docs/components/gio-form">GioForm</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Introduced <code>redirect()</code> and <code>isActionRedirect()</code>, for page
              actions and <code>getServerSideProps</code> (returned or thrown).
            </>
          ),
        },
      ]} />
    </>
  );
}
