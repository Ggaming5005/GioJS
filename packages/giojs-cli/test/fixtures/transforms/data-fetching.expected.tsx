// TODO(gio-migrate): types from 'next' (GetStaticProps, InferGetStaticPropsType) don't exist in GioJS: getServerSideProps receives { params, query, headers, cookies, locale }, route handlers a GioRequest (@gio.js/core), pages plain props
import type { GetStaticProps, InferGetStaticPropsType } from 'next';
import { GioLink } from '@gio.js/react';
// TODO(gio-migrate): CSS Modules import './Post.module.css': GioJS doesn't bundle CSS imports - switch these classes to a global stylesheet linked from the root layout
import styles from './Post.module.css';
// TODO(gio-migrate): GioJS doesn't bundle CSS imports: link this stylesheet from the root layout's <head>: <link rel="stylesheet" href="/..." /> (move the file under app/ - app/x.css is served at /x.css - or public/)
// import '../styles/post.css';

export default function Post({ post }: InferGetStaticPropsType<typeof getServerSideProps>) {
  return <GioLink href="/">{post.title}</GioLink>;
}

// TODO(gio-migrate): getStaticProps returned revalidate 10 / 60: GioJS takes one export const revalidate per page
export const getServerSideProps: GetStaticProps = async ({ params }) => {
  const post = await fetch(`https://api.example.com/posts/${params?.id}`).then((r) => r.json());
  if (!post) {
    return { notFound: true };
  }
  return {
    props: { post },
  };
};

// Cached in Rust after the first render and refreshed every 10s (stale-while-revalidate).
export const revalidate = 10;

export async function getStaticPaths() {
  return { paths: [{ params: { id: '1' } }], fallback: 'blocking' };
}

// TODO(gio-migrate): getInitialProps is not supported: move the data loading into export async function getServerSideProps(ctx)
Post.getInitialProps = async () => ({});
