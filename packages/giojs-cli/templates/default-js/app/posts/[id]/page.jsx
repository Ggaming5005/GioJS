import React from 'react';
import { GioLink } from '@gio.js/react';

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
            })}
          </time>
        </header>

        <div className="gio-article__body">
          <p>{post.body}</p>
          <p>
            This page is rendered server-side via <code>getServerSideProps</code>. The post
            ID comes from the URL parameter — try changing it in the address bar.
          </p>
        </div>
      </article>
    </section>
  );
}

export async function getServerSideProps(ctx) {
  const { id } = ctx.params;
  // Replace with your actual data source
  const post = {
    id,
    title: `Post #${id}`,
    body: `This is the body of post ${id}. Replace getServerSideProps with your database query or API call.`,
    publishedAt: new Date().toISOString(),
  };
  return { props: { post } };
}
