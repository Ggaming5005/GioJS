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
    </>
  );
}
