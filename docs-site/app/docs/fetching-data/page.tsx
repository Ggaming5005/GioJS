import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Fetching Data',
  description: 'Load data on the server with getServerSideProps.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Fetching Data</h1>
      <p className="page-subtitle">Load data on the server with getServerSideProps.</p>
      <p>Export an async getServerSideProps from a page to fetch data on the server before render. The returned props are passed to your component.</p>
      <CodeBlock lang="tsx" code={`export default function Post({ post }) {
  return <article><h1>{post.title}</h1></article>;
}

export async function getServerSideProps(ctx) {
  const post = await db.posts.find(ctx.params.id);
  return { props: { post } };
}`} />
      <h2 id="types">Types</h2>
      <p>
        Type the loader with <code>GetServerSideProps</code> from <code>@gio.js/core</code>:
        the first type argument is the page&apos;s props, the second the route pattern, which
        types <code>ctx.params</code>. The pattern is checked against the routes the server
        discovered (the generated <code>.gio/routes.d.ts</code>), so a typo fails{' '}
        <code>tsc</code>; a params shape (<code>{'{ id: string }'}</code>) works too. The
        result must be one the server accepts: <code>{'{ props }'}</code> (optionally with{' '}
        <code>headers</code> and <code>tags</code>), a <code>redirect</code>,{' '}
        <code>{'{ notFound: true }'}</code> or <a href="/docs/functions/redirect"><code>redirect()</code></a>.
      </p>
      <CodeBlock lang="tsx" code={`import type { GetServerSideProps } from '@gio.js/core';

interface Props {
  post: Post;
}

export const getServerSideProps: GetServerSideProps<Props, '/posts/:id'> = async (ctx) => {
  const post = await db.posts.find(ctx.params.id);   // ctx.params: { id: string }
  if (!post) return { notFound: true };
  return { props: { post } };
};

export default function PostPage({ post }: Props) {
  return <article><h1>{post.title}</h1></article>;
}`} />
      <p>
        The component receives exactly the returned props - not the params.{' '}
        <code>{'InferPageProps<typeof getServerSideProps>'}</code> reads them off an
        unannotated loader. A page <em>without</em> <a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a> receives{' '}
        <code>{'{ params, searchParams }'}</code> instead: type it as{' '}
        <code>{"PageProps<'/posts/:id'>"}</code>. In JavaScript the same types work through
        JSDoc, as in the <code>default-js</code> starter:{' '}
        <code>{"/** @type {import('@gio.js/core').GetServerSideProps<{ post: Post }, '/posts/:id'>} */"}</code>.
        All types are listed under <a href="/docs/functions#types">Functions</a>.
      </p>
      <h2 id="redirects">Redirects</h2>
      <p>Return a redirect instead of props to send the visitor elsewhere.</p>
      <CodeBlock lang="tsx" code={`return { redirect: { destination: '/login', permanent: false } };`} />
      <p>
        The <code>redirect()</code> helper from <code>@gio.js/core</code> - the one page actions
        use - works here too: return it, or throw it from anything{' '}
        <code>getServerSideProps</code> calls, so one guard serves pages and actions alike. It
        answers <code>303 See Other</code> unless you pass another status, and is never cached.
      </p>
      <CodeBlock lang="tsx" code={`import { redirect } from '@gio.js/core';

// lib/auth.server.ts - shared by getServerSideProps and actions
export function requireUser(cookies: Record<string, string>) {
  const user = readSession(cookies);
  if (user === null) throw redirect('/login');
  return user;
}

export async function getServerSideProps(ctx) {
  const user = requireUser(ctx.cookies);
  return { props: { user } };
}`} />
      <h2 id="after-a-form-post">After a form post</h2>
      <p>
        When a page&apos;s <code>action</code> re-renders it (a validation error, say),{' '}
        <code>getServerSideProps</code> runs for that POST too, with the action&apos;s result in{' '}
        <code>ctx.actionData</code>; the page component gets it as the <code>actionData</code>{' '}
        prop. Neither render is ever cached. Headers the action returned (a cookie) are sent
        whatever answers in the end - the page, or a redirect or 404 from{' '}
        <code>getServerSideProps</code>. See <a href="/docs/forms">Forms and Mutations</a>.
      </p>
      <CodeBlock lang="tsx" code={`export async function getServerSideProps(ctx) {
  const post = await db.posts.find(ctx.params.id);
  // Keep the comment the visitor typed when the action rejected it.
  const draft = ctx.actionData?.draft ?? '';
  return { props: { post, draft } };
}`} />
      <h2 id="not-found">Not found</h2>
      <p>
        When the data does not exist, call <a href="/docs/functions/not-found"><code>notFound()</code></a> - or return{' '}
        <code>{'{ notFound: true }'}</code>. The page answers 404 with the nearest{' '}
        <a href="/docs/file-conventions/not-found"><code>not-found.tsx</code></a> at or above its folder (see{' '}
        <a href="/docs/error-handling">Error Handling</a>).
      </p>
      <CodeBlock lang="tsx" code={`import { notFound } from '@gio.js/core';

export async function getServerSideProps(ctx) {
  const post = await db.posts.find(ctx.params.id);
  if (!post) notFound();             // or: return { notFound: true };
  return { props: { post } };
}`} />
      <p>
        <code>notFound()</code> works by throwing, so a <code>try</code>/<code>catch</code>{' '}
        around it swallows it - call it outside the <code>try</code>, or rethrow. It works
        while rendering too, and in <a href="/docs/file-conventions/route"><code>route.ts</code></a> handlers (a JSON 404). A 404 is
        never cached, even with <code>revalidate</code> set.
      </p>
      <h2 id="response-headers-and-cookies">Response headers and cookies</h2>
      <p>
        Return <code>headers</code> next to <code>props</code> (or a <code>redirect</code>) to
        set response headers. Pass an array to <code>set-cookie</code> to set several cookies -
        each becomes its own <code>Set-Cookie</code> header. An array for any other header is
        joined with <code>, </code>.
      </p>
      <CodeBlock lang="tsx" code={`export async function getServerSideProps(ctx) {
  const session = await refreshSession(ctx.cookies['session']);
  return {
    props: { user: session.user },
    headers: {
      'set-cookie': [
        \`session=\${session.id}; Path=/; HttpOnly; Secure; SameSite=Lax\`,
        \`csrf=\${session.csrf}; Path=/; Secure; SameSite=Strict\`,
      ],
    },
  };
}

// app/logout/page.tsx - clear both cookies on the way out
export async function getServerSideProps() {
  return {
    redirect: { destination: '/', permanent: false },
    headers: { 'set-cookie': ['session=; Path=/; Max-Age=0', 'csrf=; Path=/; Max-Age=0'] },
  };
}`} />
      <p>
        A page that returns headers is never cached, even with <code>revalidate</code> set -
        caching a per-request cookie would hand one visitor&apos;s session to everyone.
      </p>
      <h2 id="cache-tags">Cache tags</h2>
      <p>
        On a cached page, return <code>tags</code> next to <code>props</code> to name the data
        this render used; <a href="/docs/functions/revalidate-tag"><code>revalidateTag()</code></a> then purges exactly the pages that
        showed it - see <a href="/docs/caching">Caching</a>.
      </p>
      <CodeBlock lang="tsx" code={`export const revalidate = 3600;

export async function getServerSideProps(ctx) {
  const post = await db.posts.find(ctx.params.id);
  return { props: { post }, tags: [\`post:\${post.id}\`] };
}`} />
      <div className="callout">Never fetch data inside the component body - it runs during SSR and inflates time-to-first-byte. Use getServerSideProps.</div>
      <h2 id="cookies-and-caching">Cookies and caching</h2>
      <p>
        <code>ctx.cookies</code> and <code>ctx.headers</code> carry the visitor&apos;s request.
        Reading <code>ctx.cookies</code> or the <code>cookie</code>/<code>authorization</code>{' '}
        headers marks the render as personalized, so a page that also exports{' '}
        <code>revalidate</code> is not cached for that request - see{' '}
        <a href="/docs/caching">Caching</a>.
      </p>
      <p>
        <code>ctx.ip</code> is the visitor&apos;s IP address (proxy-aware: behind a reverse
        proxy it needs <a href="/docs/configuration/server"><code>[server] trusted_proxies</code></a>, see{' '}
        <a href="/docs/configuration">Configuration</a>). Reading it marks the render as
        personalized exactly like reading a cookie - a page that varies by IP (geo, an
        allowlist) must never be cached and served to everyone - and so does reading the raw{' '}
        <code>x-forwarded-for</code>, <code>forwarded</code> or <code>x-real-ip</code>{' '}
        headers.
      </p>
      <p>
        <code>ctx.host</code> and <code>ctx.scheme</code> (the host and scheme the client
        used) mark the render too, as do the raw <code>host</code>,{' '}
        <code>x-forwarded-host</code> and <code>x-forwarded-proto</code> headers. The host is
        whatever the client sent unless your proxy pins it: a cached page that printed it -
        an absolute link, a canonical URL - would hand one request&apos;s{' '}
        <code>Host: evil.example</code> to every later visitor. For absolute URLs on cached
        pages, use an origin you configure (an environment variable) instead. Only{' '}
        <code>ctx.requestId</code> (the response&apos;s <code>X-Request-Id</code>, for logs
        and downstream calls) does not mark the render: it never shapes the page.
      </p>
      <p>
        The same goes for the context{' '}
        <a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a>{' '}
        gets: reading its cookies, credential headers, IP, host or scheme marks the render as
        personalized too, because the tags it returns are part of the page. With{' '}
        <a href="/docs/caching-layers#partial-prerendering-ppr">PPR</a> that includes metadata
        built from the props of a <code>getServerSideProps</code> that read them: the{' '}
        <code>&lt;head&gt;</code> is in the cached shell.
      </p>
      <CodeBlock lang="tsx" code={`export const revalidate = 60;

export async function getServerSideProps(ctx) {
  const posts = await db.posts.latest({ requestId: ctx.requestId }); // still cached
  const canonical = \`\${process.env.SITE_URL}/posts\`;              // not ctx.host
  return { props: { posts, canonical } };
}`} />
      <p>
        <code>ctx.headers</code> is a tracked view of the request headers (a Proxy), so{' '}
        <code>structuredClone</code>, <code>postMessage</code> and worker threads reject it.
        Pass a plain copy instead - <code>{'{ ...ctx.headers }'}</code> - which, like any
        enumeration of the headers, counts as reading them.
      </p>
    </>
  );
}
