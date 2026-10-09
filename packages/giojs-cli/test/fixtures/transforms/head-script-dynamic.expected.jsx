import React, { lazy } from 'react';
import { usePathname, useSearchParams } from '@gio.js/react';
import { notFound, redirect } from '@gio.js/core';

// TODO(gio-migrate): next/dynamic ssr: false - React.lazy also renders on the server; if the component touches browser APIs, render it only after mount (useEffect flag)
// TODO(gio-migrate): next/dynamic loading option: render this component inside <Suspense fallback={...}> (from 'react'); it was () => <p>Loading…</p>
const Chart = lazy(() => import('../components/Chart'));
const Map = lazy(() => import('../components/Map').then((mod) => ({ default: mod.Map })));

export default function Dashboard({ user, title }) {
  const pathname = usePathname();
  const params = useSearchParams();
  if (!user) notFound();
  // TODO(gio-migrate): redirect() while rendering a component: GioJS redirects before the render - move this check into getServerSideProps (throw or return redirect(url)), or call navigate(url, { replace: true }) from @gio.js/react in the browser
  if (user.banned) throw redirect('/banned');
  // TODO(gio-migrate): React 19 needs <title> children to be a single string: use a template literal, e.g. <title>{`${name} | Site`}</title>
  // TODO(gio-migrate): React 19 hoists <title>, <meta> and <link> into <head>, not <style>: move it into the root layout's <head>
  // TODO(gio-migrate): next/script onLoad: a server-rendered <script> runs before React hydrates, so the callback never fires - load the script from a useEffect if you need it
  // TODO(gio-migrate): strategy="lazyOnload" has no native equivalent: the script now loads with async; inject it from a useEffect if it must wait until the page is idle
  return (
    <>
      <>
        <title>{title} | Dashboard</title>
        <meta name="description" content="Your dashboard" />
        <style>{`body { margin: 0 }`}</style>
      </>
      <script src="https://example.com/analytics.js" async />
      <script src="https://example.com/widget.js" async />
      <script id="inline-config" dangerouslySetInnerHTML={{ __html: `window.CONFIG = { path: "${pathname}" };` }} />
      <Chart data={params.get('range')} />
      <Map />
    </>
  );
}
