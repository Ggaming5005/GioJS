import type { GetStaticProps, InferGetStaticPropsType } from 'next';
import Link from 'next/link';
import styles from './Post.module.css';
import '../styles/post.css';

export default function Post({ post }: InferGetStaticPropsType<typeof getStaticProps>) {
  return <Link href="/">{post.title}</Link>;
}

export const getStaticProps: GetStaticProps = async ({ params }) => {
  const post = await fetch(`https://api.example.com/posts/${params?.id}`).then((r) => r.json());
  if (!post) {
    return { notFound: true, revalidate: 10 };
  }
  return {
    props: { post },
    revalidate: 60,
  };
};

export async function getStaticPaths() {
  return { paths: [{ params: { id: '1' } }], fallback: 'blocking' };
}

Post.getInitialProps = async () => ({});
