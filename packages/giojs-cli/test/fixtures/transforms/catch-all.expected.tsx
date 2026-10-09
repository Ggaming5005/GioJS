import { useMemo } from 'react';
import { useSearchParams, useParams, useRouter } from '@gio.js/react';

// TODO(gio-migrate): catch-all route: the "slug" param is a '/'-joined string in GioJS ('a/b'), not an array as in Next.js - use slug.split('/') where the code expects the array
export default function Docs({ params, toc }: { params: { slug: string[] }; toc: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // TODO(gio-migrate): catch-all route: the "slug" param is a '/'-joined string in GioJS ('a/b'), not an array as in Next.js - use slug.split('/') where the code expects the array
  const routeParams = useParams();
  const routerQuery = useMemo(() => ({ ...Object.fromEntries(searchParams), ...routeParams }), [searchParams, routeParams]);
  const path = params.slug.join('/');
  return (
    <h1 onClick={() => router.push('/docs')}>
      {path} {toc.length} {routerQuery.slug}
    </h1>
  );
}

// TODO(gio-migrate): catch-all route: the "slug" param is a '/'-joined string in GioJS ('a/b'), not an array as in Next.js - use slug.split('/') where the code expects the array
export async function getServerSideProps({ params }: { params: { slug: string[] } }) {
  return { props: { params, toc: params.slug } };
}

// Cached in Rust after the first render and refreshed every 60s (stale-while-revalidate).
export const revalidate = 60;

export async function getStaticPaths() {
  return { paths: [{ params: { slug: ['a', 'b'] } }], fallback: false };
}
