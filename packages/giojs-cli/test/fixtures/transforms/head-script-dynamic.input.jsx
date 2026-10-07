import React from 'react';
import Head from 'next/head';
import Script from 'next/script';
import dynamic from 'next/dynamic';
import { usePathname as usePath, useSearchParams, notFound, redirect } from 'next/navigation';

const Chart = dynamic(() => import('../components/Chart'), { ssr: false, loading: () => <p>Loading…</p> });
const Map = dynamic(() => import('../components/Map').then((mod) => mod.Map));

export default function Dashboard({ user, title }) {
  const pathname = usePath();
  const params = useSearchParams();
  if (!user) notFound();
  if (user.banned) redirect('/banned');
  return (
    <>
      <Head>
        <title>{title} | Dashboard</title>
        <meta name="description" content="Your dashboard" />
        <style>{`body { margin: 0 }`}</style>
      </Head>
      <Script src="https://example.com/analytics.js" strategy="afterInteractive" />
      <Script src="https://example.com/widget.js" strategy="lazyOnload" onLoad={() => console.log('ok')} />
      <Script id="inline-config">{`window.CONFIG = { path: "${pathname}" };`}</Script>
      <Chart data={params.get('range')} />
      <Map />
    </>
  );
}
