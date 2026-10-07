import React from 'react';
import { GioLink } from '@gio.js/react';

/**
 * @typedef {{ id: string, title: string, body: string, publishedAt: string }} Post
 */

// The page renders with exactly what getServerSideProps returns.
/** @param {import('@gio.js/core').InferPageProps<typeof getServerSideProps>} props */
export default function PostPage({ post }) {
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

// '/posts/:id' types ctx.params as { id: string } in your editor.
/** @type {import('@gio.js/core').GetServerSideProps<{ post: Post }, '/posts/:id'>} */
export const getServerSideProps = async (ctx) => {
  const { id } = ctx.params;
  // Replace with your actual data source
  /** @type {Post} */
  const post = {
    id,
    title: `Post #${id}`,
    body: `This is the body of post ${id}. Replace getServerSideProps with your database query or API call.`,
    publishedAt: new Date().toISOString(),
  };
  return { props: { post } };
};

// Fills the root layout's title template: 'Post #1 | {{PROJECT_NAME}}'.
/** @type {import('@gio.js/core').GenerateMetadata<'/posts/:id'>} */
export const generateMetadata = (ctx) => ({
  title: `Post #${ctx.params.id}`,
});

// `gio export` (static sites) pre-renders one page per entry: dynamic routes
// need the list up front. The server ignores it and renders any id on demand.
/** @type {import('@gio.js/core').GetStaticPaths<'/posts/:id'>} */
export const getStaticPaths = () => {
  return { paths: ['1', '2', '3'].map((id) => ({ params: { id } })) };
};
