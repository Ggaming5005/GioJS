import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'getServerSideProps',
  description:
    "Load a page's data on the server for each render, and answer with props, a redirect, a 404 or response headers.",
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>getServerSideProps</h1>
      <p className="page-subtitle">
        Load a page&apos;s data on the server for each render, and answer with props, a
        redirect, a 404 or response headers.
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import { notFound, type GetServerSideProps, type InferPageProps } from '@gio.js/core';
import { db, type Post } from '../../../lib/db.server.ts';

export const getServerSideProps: GetServerSideProps<{ post: Post }, '/posts/:id'> = async (ctx) => {
  const post = await db.posts.find(ctx.params.id);
  if (post === null) notFound();
  return { props: { post } };
};

export default function PostPage({ post }: InferPageProps<typeof getServerSideProps>) {
  return <article><h1>{post.title}</h1><p>{post.body}</p></article>;
}`} />
      <p>
        Export an async <code>getServerSideProps</code> from a <code>page.tsx</code>. The
        Node worker calls it before it renders the page, and the page component receives
        exactly the props it returned. It runs only on the server: the browser bundle imports
        the page&apos;s default export alone, so this function and the modules only it
        imports are left out. It is read from pages only; a layout cannot export one.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <p>
        <code>ctx</code> (<code>GsspContext</code>, also exported as{' '}
        <code>GetServerSidePropsContext</code>) describes the request:
      </p>
      <PropsTable kind="Field" rows={[
        { name: 'method', type: 'string', description: <><code>&apos;GET&apos;</code> or <code>&apos;HEAD&apos;</code>, or <code>&apos;POST&apos;</code> on the render that answers a page <a href="/docs/page-exports/action">action</a>.</> },
        { name: 'path', type: 'string', description: <>The routed path, without the query string or a locale prefix (after <code>[[rewrites]]</code>).</> },
        { name: 'params', type: 'ParamsOf<Route>', description: <>The dynamic segments: <code>[id]</code> gives <code>{'{ id: string }'}</code>. A catch-all is one <code>/</code>-joined string (<code>&apos;a/b&apos;</code>), and an optional catch-all that matched nothing is <code>&apos;&apos;</code>.</> },
        { name: 'query', type: 'Record<string, string>', description: 'The query string, one value per name: the last one when a name repeats.' },
        { name: 'headers', type: 'Record<string, string>', description: <>The request headers, names lowercase. A tracked view (a <code>Proxy</code>): see <a href="#personalized-renders">personalized renders</a>.</> },
        { name: 'cookies', type: 'Record<string, string>', description: <>The <code>Cookie</code> header, parsed. Reading it makes the render personal.</> },
        { name: 'locale', type: 'string | undefined', description: <>The request locale with <code>[i18n]</code> configured; absent without it.</> },
        { name: 'ip', type: 'string | undefined', description: <>The client&apos;s address, proxy-aware (<code>[server] trusted_proxies</code>). Reading it makes the render personal.</> },
        { name: 'scheme', type: 'string | undefined', description: <><code>&apos;https&apos;</code> or <code>&apos;http&apos;</code>, as the client used it. Reading it makes the render personal.</> },
        { name: 'host', type: 'string | undefined', description: <>The host the client addressed, which is whatever the client sent unless a proxy pins it. Reading it makes the render personal.</> },
        { name: 'requestId', type: 'string | undefined', description: <>This request&apos;s <code>X-Request-Id</code>, also on every log line. Reading it does not make the render personal.</> },
        { name: 'actionData', type: 'unknown', description: <>The page action&apos;s result, on the render that answers a <code>POST</code>; absent on every <code>GET</code>.</> },
      ]} />

      <h3 id="returns">Returns</h3>
      <p>Return (or resolve to) one of these:</p>
      <table>
        <thead><tr><th>Value</th><th>Answer</th></tr></thead>
        <tbody>
          <tr><td><code>{'{ props, headers?, tags? }'}</code></td><td><code>200</code> with the page rendered from <code>props</code>. <code>headers</code> are response headers; <code>tags</code> are <a href="/docs/page-exports/tags">cache tags</a> for this render.</td></tr>
          <tr><td>Any other object</td><td>Used as the props themselves (&quot;flat props&quot;). A <code>headers</code> or <code>tags</code> key in it is just a prop.</td></tr>
          <tr><td><code>{'{ redirect: { destination, permanent }, headers? }'}</code></td><td><code>301</code> when <code>permanent</code> is <code>true</code>, else <code>302</code>, with <code>Location: destination</code>. <code>headers</code> go with it. A <code>destination</code> that <code>redirect()</code> would refuse (not a string, empty, or holding a control character such as a newline) is a render error, answered <code>500</code>, never sent.</td></tr>
          <tr><td><code>redirect(url, init?)</code></td><td>A <code>303</code> by default, or the status you pass (<code>301</code>, <code>302</code>, <code>307</code>, <code>308</code>), with <code>init.headers</code>. See <a href="/docs/functions/redirect">redirect</a>.</td></tr>
          <tr><td><code>{'{ notFound: true }'}</code></td><td><code>404</code> with the nearest <code>not-found.tsx</code>, the same as calling <code>notFound()</code>.</td></tr>
        </tbody>
      </table>
      <p>
        Header values are strings or string arrays. Each <code>set-cookie</code> entry is sent
        as its own <code>Set-Cookie</code> header; an array for any other header is joined with{' '}
        <code>, </code>. Names are matched case-insensitively. An empty{' '}
        <code>{"'set-cookie': []"}</code> sends nothing and does not count as headers.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>When it runs.</strong> On every render of the page: each request to a page
          without <a href="/docs/page-exports/revalidate"><code>revalidate</code></a>, and each
          cache miss or background refresh of a cached page. A cache hit is served by the Rust
          server without calling it. On a <a href="/docs/page-exports/shell">PPR</a> shell hit
          it runs again for the holes, with the visitor&apos;s own cookies. Under{' '}
          <code>gio export</code> it runs once per exported page, at build time, with empty{' '}
          <code>headers</code>, <code>cookies</code> and <code>query</code>.
        </li>
        <li>
          <strong>Thrown answers.</strong> <code>notFound()</code> and <code>redirect()</code>{' '}
          may be thrown from <code>getServerSideProps</code> or anything it calls; they answer
          like the returned forms. Any other error answers <code>500</code> with the nearest{' '}
          <code>error.tsx</code>, its details in the server log under the response&apos;s
          digest.
        </li>
        <li>
          <strong>Bad results.</strong> A result that is not an object (<code>null</code>, a
          string, an array) is a render error:{' '}
          <code>getServerSideProps for route &quot;/x&quot; must return an object - {'{ props: {...} }'}, flat props, {'{ redirect: {...} }'} or {'{ notFound: true }'} - but returned null</code>.
          So is a redirect whose <code>destination</code> cannot be sent:{' '}
          <code>getServerSideProps for route &quot;/x&quot; returned {'{ redirect: { destination } }'} that cannot be sent: redirect() URL contains control characters</code>.
        </li>
        <li>
          <strong>Headers and caching.</strong> A page that returns response headers is never
          cached, even with <code>revalidate</code> set: they are per-request (a{' '}
          <code>set-cookie</code> above all). A warning is logged. A{' '}
          <code>Cache-Control</code> you return replaces the one GioJS would send.
        </li>
        <li>
          <strong>Props reach the browser.</strong> The props are serialized into the page as
          JSON for hydration, so never return secrets. The browser gets what{' '}
          <code>JSON.stringify</code> makes of them: a <code>Date</code> arrives as a string,
          and functions and <code>undefined</code> values are dropped. Props JSON cannot hold at
          all (a <code>BigInt</code>, a cycle) render the page without hydration, with a
          warning.
        </li>
        <li>
          <strong>Without it</strong>, a page component receives{' '}
          <code>{'{ params, searchParams }'}</code> (type it with{' '}
          <code>{"PageProps<'/posts/:id'>"}</code>).
        </li>
      </ul>

      <h3 id="personalized-renders">Personalized renders</h3>
      <p>
        A cached page is served to everyone, so GioJS watches what{' '}
        <code>getServerSideProps</code> reads. Reading <code>ctx.cookies</code>,{' '}
        <code>ctx.ip</code>, <code>ctx.host</code> or <code>ctx.scheme</code>, or the{' '}
        <code>cookie</code>, <code>authorization</code>, <code>x-forwarded-for</code>,{' '}
        <code>forwarded</code>, <code>x-real-ip</code>, <code>host</code>,{' '}
        <code>x-forwarded-host</code> or <code>x-forwarded-proto</code> header (or a header an{' '}
        <code>onRequest</code> plugin changed), or enumerating <code>ctx.headers</code>, marks
        the render personal: it is not stored, even with <code>revalidate</code>, and a warning
        names the route once. The access counts, not the value - checking for a cookie that is
        absent still decides the page. Other headers (<code>accept-language</code>,{' '}
        <code>user-agent</code>) and <code>ctx.requestId</code> do not count. See{' '}
        <a href="/docs/caching#personalized-pages-are-never-shared">Caching</a>.
      </p>

      <h3 id="types">Types</h3>
      <table>
        <thead><tr><th>Type</th><th>What it types</th></tr></thead>
        <tbody>
          <tr><td><code>GetServerSideProps</code></td><td><code>{'GetServerSideProps<Props, Route>'}</code> types the function: <code>ctx</code> and the result variants. <code>Route</code> is a pattern of your app (<code>{"'/posts/:id'"}</code>) or a params shape (<code>{'{ id: string }'}</code>).</td></tr>
          <tr><td><code>InferPageProps</code></td><td><code>{'InferPageProps<typeof getServerSideProps>'}</code>: the props the page renders with, read off the function.</td></tr>
          <tr><td><code>GetServerSidePropsContext</code>, <code>GsspContext</code></td><td><code>{'GetServerSidePropsContext<Route>'}</code> (or <code>{'GsspContext<Route>'}</code>, the same type): the context alone.</td></tr>
          <tr><td><code>GetServerSidePropsResult</code></td><td><code>{'GetServerSidePropsResult<Props>'}</code>: the result union. Flat props are left out of it: a typed result always uses <code>props</code>.</td></tr>
        </tbody>
      </table>

      <h2 id="examples">Examples</h2>
      <h3 id="guard-a-page-with-redirect">Guard a page with redirect()</h3>
      <p>
        A thrown <code>redirect()</code> lets one helper guard pages and actions alike:
      </p>
      <CodeBlock lang="tsx" title="app/dashboard/page.tsx" code={`import { redirect, type GetServerSideProps, type InferPageProps } from '@gio.js/core';
import { sessions } from '../../lib/session.server.ts';

function requireUser(ctx: { cookies: Record<string, string> }): string {
  const userId = sessions.getSession(ctx).get('userId');
  if (userId === undefined) throw redirect('/login?next=/dashboard');   // 303
  return userId;
}

export const getServerSideProps: GetServerSideProps<{ userId: string }> = async (ctx) => {
  return { props: { userId: requireUser(ctx) } };
};

export default function Dashboard({ userId }: InferPageProps<typeof getServerSideProps>) {
  return <h1>Signed in as {userId}</h1>;
}`} />

      <h3 id="set-cookies-and-other-headers">Set cookies and other headers</h3>
      <CodeBlock lang="tsx" title="app/logout/page.tsx" code={`export async function getServerSideProps() {
  return {
    redirect: { destination: '/', permanent: false },       // 302
    headers: {
      'set-cookie': ['session=; Path=/; Max-Age=0', 'csrf=; Path=/; Max-Age=0'],
    },
  };
}

export default function Logout() {
  return null;
}`} />

      <h3 id="tag-a-cached-render">Tag a cached render</h3>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import { notFound, type GetServerSideProps, type InferPageProps } from '@gio.js/core';
import { db, type Post } from '../../../lib/db.server.ts';

export const revalidate = 3600;
export const tags = ['posts'];

export const getServerSideProps: GetServerSideProps<{ post: Post }, '/posts/:id'> = async (ctx) => {
  const post = await db.posts.find(ctx.params.id);
  if (post === null) notFound();
  // revalidateTag(\`post:\${id}\`) purges exactly the pages that showed this post.
  return { props: { post }, tags: [\`post:\${post.id}\`, \`author:\${post.authorId}\`] };
};

export default function PostPage({ post }: InferPageProps<typeof getServerSideProps>) {
  return <article><h1>{post.title}</h1><p>{post.body}</p></article>;
}`} />

      <h3 id="keep-what-the-visitor-typed">Keep what the visitor typed</h3>
      <p>
        On the render that answers a page action, <code>ctx.actionData</code> holds the
        action&apos;s result, and <code>ctx.method</code> is <code>&apos;POST&apos;</code>:
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/edit/page.tsx" code={`import { notFound, redirect, type ActionArgs, type GetServerSideProps, type InferPageProps, type WithActionData } from '@gio.js/core';
import { GioForm } from '@gio.js/react';
import { db, type Post } from '../../../../lib/db.server.ts';

export async function action(req: ActionArgs<'/posts/:id/edit'>) {
  const draft = String((await req.formData()).get('body') ?? '');
  if (draft.length > 280) return { status: 422, data: { draft, error: 'At most 280 characters' } };
  await db.posts.update(req.params.id, { body: draft });
  return redirect(\`/posts/\${req.params.id}\`);
}

export const getServerSideProps: GetServerSideProps<{ post: Post; draft: string }, '/posts/:id/edit'> = async (ctx) => {
  const post = await db.posts.find(ctx.params.id);
  if (post === null) notFound();
  const failed = ctx.actionData as { draft: string } | undefined;   // only on the POST re-render
  return { props: { post, draft: failed?.draft ?? post.body } };
};

type Props = WithActionData<typeof action, InferPageProps<typeof getServerSideProps>>;

export default function EditPost({ post, draft, actionData }: Props) {
  return (
    <GioForm>
      <h1>{post.title}</h1>
      <textarea name="body" defaultValue={draft} aria-invalid={actionData ? true : undefined} />
      {actionData && <p role="alert">{actionData.error}</p>}
      <button>Save</button>
    </GioForm>
  );
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>notFound()</code> works by throwing, so a <code>try</code>/<code>catch</code>{' '}
          around it swallows it: call it outside the <code>try</code>, or rethrow.
        </li>
        <li>
          A 404, a redirect and an error page are never cached. A redirect also carries{' '}
          <code>Cache-Control: private, no-cache</code> unless its headers set one, so a
          CDN never stores it either.
        </li>
        <li>
          <code>redirect</code> counts only when it is an object with a{' '}
          <code>destination</code> key, and <code>notFound</code> only when it is exactly{' '}
          <code>true</code>; any other value under those keys is a prop. Nest props under{' '}
          <code>props</code> to avoid surprises.
        </li>
        <li>
          <code>ctx.headers</code> is a <code>Proxy</code>, so <code>structuredClone</code>,{' '}
          <code>postMessage</code> and worker threads reject it. Pass{' '}
          <code>{'{ ...ctx.headers }'}</code>, which counts as reading every header.
        </li>
        <li>
          <code>ctx.query</code> holds one value per name: of <code>?tag=a&amp;tag=b</code>{' '}
          only the last, <code>&apos;b&apos;</code>, arrives.
        </li>
        <li>
          A <code>getServerSideProps</code> built by a module-scope call (
          <code>export const getServerSideProps = withAuth(...)</code>) is not removed from the
          browser bundle. Put such helpers in a <code>*.server.ts</code> file or import{' '}
          <code>@gio.js/core/server-only</code> in them, so a leak fails the build.
        </li>
        <li>
          There is no <code>getStaticProps</code>: for data that changes rarely, add{' '}
          <a href="/docs/page-exports/revalidate"><code>revalidate</code></a> and the Rust
          cache serves the render until it is stale.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/fetching-data">Fetching Data</a> - the guide</li>
        <li><a href="/docs/caching">Caching &amp; Revalidating</a></li>
        <li><a href="/docs/page-exports/revalidate"><code>revalidate</code></a>, <a href="/docs/page-exports/tags"><code>tags</code></a>, <a href="/docs/page-exports/shell"><code>shell</code></a></li>
        <li><a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a> - receives the same context and the props</li>
        <li><a href="/docs/page-exports/action"><code>action</code></a></li>
        <li><a href="/docs/functions/redirect"><code>redirect</code></a>, <a href="/docs/functions/not-found"><code>notFound</code></a></li>
        <li><a href="/docs/functions/server-only"><code>server-only</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>notFound()</code> and <code>{'{ notFound: true }'}</code> answer <code>404</code>; returned or thrown <code>redirect()</code>; <code>set-cookie</code> arrays and <code>headers</code> on redirects; per-render <code>tags</code>; <code>ctx.ip</code>, <code>ctx.scheme</code>, <code>ctx.host</code>, <code>ctx.requestId</code> and <code>ctx.actionData</code>; renders that read credentials are no longer cached; typed with <code>GetServerSideProps</code> and <code>InferPageProps</code>.</> },
        { version: 'v0.1.0-beta.5', changes: <><code>ctx</code> carries <code>method</code>, <code>path</code>, <code>headers</code> and <code>cookies</code>; <code>{'{ props, headers }'}</code> sets response headers and makes the page uncacheable; removed from browser bundles.</> },
        { version: 'v0.1.0-beta.2', changes: <>Runs at build time under <code>gio export</code>.</> },
        { version: 'v0.1.0-beta.1', changes: 'Introduced, with props and redirects.' },
      ]} />
    </>
  );
}
