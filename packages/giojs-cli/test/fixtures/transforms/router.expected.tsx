import { useEffect } from 'react';
import { navigate, useSearchParams, useParams, usePathname, useRouter, type GioRouter } from '@gio.js/react';

export function Search({ fallback }: { fallback: GioRouter | null }) {
  const router = useRouter();
  const routerQuery = { ...Object.fromEntries(useSearchParams()), ...useParams() };
  const routerPathname = usePathname();
  const { id, tab = 'all' } = routerQuery;

  useEffect(() => {
    // TODO(gio-migrate): router.events has no GioJS equivalent
    router.events.on('routeChangeStart', () => {});
  }, [router]);

  if (false) return null;

  // TODO(gio-migrate): router.pathname → usePathname(): GioJS returns the real path ('/posts/1'), never the route pattern ('/posts/[id]')
  // TODO(gio-migrate): router.push(url, as, options): GioJS takes the real URL and { scroll } only - drop the `as` argument
  return (
    <div>
      <p>{routerPathname}</p>
      <button onClick={() => router.push('/posts/[id]', `/posts/${id}`)}>Open</button>
      <button onClick={() => router.replace(`/search?tab=${tab}`)}>Tab</button>
      <button onClick={() => window.location.reload()}>Reload</button>
      <button onClick={() => navigate('/')}>Home</button>
      <button onClick={() => window.history.back()}>Back</button>
    </div>
  );
}

export function Breadcrumb() {
  // TODO(gio-migrate): asPath → usePathname(): it has no query string or hash (read those from useSearchParams() / location.hash)
  const { push } = useRouter();
  const query = { ...Object.fromEntries(useSearchParams()), ...useParams() };
  const asPath = usePathname();
  return <a onClick={() => push('/')}>{asPath} {String(query.slug)}</a>;
}

export function Title() {
  const routerQuery = { ...Object.fromEntries(useSearchParams()), ...useParams() };
  return <h1>{routerQuery.title}</h1>;
}
