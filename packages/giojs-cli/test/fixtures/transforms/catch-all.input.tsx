import { useRouter } from 'next/router';

export default function Docs({ params, toc }: { params: { slug: string[] }; toc: string[] }) {
  const router = useRouter();
  const path = params.slug.join('/');
  return (
    <h1 onClick={() => router.push('/docs')}>
      {path} {toc.length} {router.query.slug}
    </h1>
  );
}

export async function getStaticProps({ params }: { params: { slug: string[] } }) {
  return { props: { params, toc: params.slug }, revalidate: 60 };
}

export async function getStaticPaths() {
  return { paths: [{ params: { slug: ['a', 'b'] } }], fallback: false };
}
