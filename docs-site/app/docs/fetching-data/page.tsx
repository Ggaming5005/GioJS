import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
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
      <h2>Redirects</h2>
      <p>Return a redirect instead of props to send the visitor elsewhere.</p>
      <CodeBlock lang="tsx" code={`return { redirect: { destination: '/login', permanent: false } };`} />
      <h2>Response headers and cookies</h2>
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
      <div className="callout">Never fetch data inside the component body - it runs during SSR and inflates time-to-first-byte. Use getServerSideProps.</div>
      <h2>Cookies and caching</h2>
      <p>
        <code>ctx.cookies</code> and <code>ctx.headers</code> carry the visitor&apos;s request.
        Reading <code>ctx.cookies</code> or the <code>cookie</code>/<code>authorization</code>{' '}
        headers marks the render as personalized, so a page that also exports{' '}
        <code>revalidate</code> is not cached for that request - see{' '}
        <a href="/docs/caching">Caching</a>.
      </p>
      <p>
        <code>ctx.ip</code> is the visitor&apos;s IP address (proxy-aware: behind a reverse
        proxy it needs <code>[server] trusted_proxies</code>, see{' '}
        <a href="/docs/configuration">Configuration</a>). Reading it marks the render as
        personalized exactly like reading a cookie - a page that varies by IP (geo, an
        allowlist) must never be cached and served to everyone - and so does reading the raw{' '}
        <code>x-forwarded-for</code>, <code>forwarded</code> or <code>x-real-ip</code>{' '}
        headers. <code>ctx.requestId</code> (the response&apos;s <code>X-Request-Id</code>,
        for logs and downstream calls), <code>ctx.scheme</code> and <code>ctx.host</code>{' '}
        do not mark the render: they never single out the visitor.
      </p>
      <CodeBlock lang="tsx" code={`export const revalidate = 60;

export async function getServerSideProps(ctx) {
  const posts = await db.posts.latest({ requestId: ctx.requestId }); // still cached
  return { props: { posts } };
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
