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
      <div className="callout">Never fetch data inside the component body — it runs during SSR and inflates time-to-first-byte. Use getServerSideProps.</div>
    </>
  );
}
