import React from 'react';
import { GioLink } from '@gio.js/react';
import type { GenerateMetadata, GetServerSideProps, GetStaticPaths, InferPageProps } from '@gio.js/core';

interface Post {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
}

// The page renders with exactly what getServerSideProps returns.
export default function PostPage({ post }: InferPageProps<typeof getServerSideProps>): React.JSX.Element {
  return (
    <section className="gio-container">
      <article className="gio-article">
        <GioLink href="/" className="gio-link">← All posts</GioLink>

        <header className="gio-article__head">
          <h1 className="gio-article__title">{post.title}</h1>
          <time className="gio-article__time" dateTime={post.publishedAt}>
            {new Date(post.publishedAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              // Fixed zone: the browser re-renders this when it hydrates.
              timeZone: 'UTC',
            })}
          </time>
        </header>

        <div className="gio-article__body">
          <p>{post.body}</p>
          <p>
            The post ID comes from the URL. On the GioJS server,{' '}
            <code>getServerSideProps</code> renders any ID on demand - try changing it in
            the address bar. A static export (<code>gio export</code>) pre-renders only the
            IDs <code>getStaticPaths</code> lists (1-3), with their data as of the export.
          </p>
        </div>
      </article>
    </section>
  );
}

// '/posts/:id' types ctx.params as { id: string } - and is checked against
// the routes the server found (.gio/routes.d.ts), so a typo fails tsc.
export const getServerSideProps: GetServerSideProps<{ post: Post }, '/posts/:id'> = async (ctx) => {
  const { id } = ctx.params;
  // Replace with your actual data source
  const post: Post = {
    id,
    title: `Post #${id}`,
    body: `This is the body of post ${id}. Replace getServerSideProps with your database query or API call.`,
    publishedAt: new Date().toISOString(),
  };
  return { props: { post } };
};

// Fills the root layout's title template: 'Post #1 | {{PROJECT_NAME}}'.
export const generateMetadata: GenerateMetadata<'/posts/:id'> = (ctx) => ({
  title: `Post #${ctx.params.id}`,
});

// `gio export` (static sites) pre-renders one page per entry: dynamic routes
// need the list up front. The server ignores it and renders any id on demand.
export const getStaticPaths: GetStaticPaths<'/posts/:id'> = () => {
  return { paths: ['1', '2', '3'].map((id) => ({ params: { id } })) };
};
