import { useEffect } from 'react';
import Router, { useRouter } from 'next/router';
import type { NextRouter } from 'next/router';

export function Search({ fallback }: { fallback: NextRouter | null }) {
  const router = useRouter();
  const { id, tab = 'all' } = router.query;

  useEffect(() => {
    router.events.on('routeChangeStart', () => {});
  }, [router]);

  if (!router.isReady) return null;

  return (
    <div>
      <p>{router.pathname}</p>
      <button onClick={() => router.push('/posts/[id]', `/posts/${id}`)}>Open</button>
      <button onClick={() => router.replace(`/search?tab=${tab}`)}>Tab</button>
      <button onClick={() => router.reload()}>Reload</button>
      <button onClick={() => Router.push('/')}>Home</button>
      <button onClick={() => Router.back()}>Back</button>
    </div>
  );
}

export function Breadcrumb() {
  const { query, asPath, push } = useRouter();
  return <a onClick={() => push('/')}>{asPath} {String(query.slug)}</a>;
}

export function Title() {
  const router = useRouter();
  return <h1>{router.query.title}</h1>;
}
