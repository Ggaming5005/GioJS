import React from 'react';
import { GioLink } from '@gio.js/react';

interface Post {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
}

interface PostPageProps {
  post: Post;
}

export default function PostPage({ post }: PostPageProps): React.JSX.Element {
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

export async function getServerSideProps(
  ctx: { params: { id: string } },
): Promise<{ props: PostPageProps }> {
  const { id } = ctx.params;
  // Replace with your actual data source
  const post: Post = {
    id,
    title: `Post #${id}`,
    body: `This is the body of post ${id}. Replace getServerSideProps with your database query or API call.`,
    publishedAt: new Date().toISOString(),
  };
  return { props: { post } };
}

// `gio export` (static sites) pre-renders one page per entry: dynamic routes
// need the list up front. The server ignores it and renders any id on demand.
export function getStaticPaths(): { paths: { params: { id: string } }[] } {
  return { paths: ['1', '2', '3'].map((id) => ({ params: { id } })) };
}
