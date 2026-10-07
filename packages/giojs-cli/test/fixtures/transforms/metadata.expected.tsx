import { notFound, type MetadataContext, type Metadata } from '@gio.js/core';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ ref?: string }> };

// TODO(gio-migrate): metadata fields GioJS doesn't render: applicationName → other: { 'application-name': ... }; verification → other: { 'google-site-verification': '...' } (yandex → 'yandex-verification', yahoo → 'y_key'); alternates.types → <link rel="alternate" type="application/rss+xml" href="..."> in the root layout's <head>; icons.other → icon descriptors with a rel, e.g. icons: { icon: [{ url, rel: 'mask-icon' }] }; openGraph.publishedTime, robots.notranslate (no GioJS equivalent: render those tags in the root layout's <head>, or drop them)
export const metadata: Metadata = {
  metadataBase: new URL('https://example.com'),
  title: { template: '%s | Blog', default: 'Blog' },
  applicationName: 'Blog',
  verification: { google: 'abc' },
  openGraph: { siteName: 'Blog', publishedTime: '2024-01-01', images: ['/og.png'] },
  alternates: { canonical: '/blog', types: { 'application/rss+xml': '/feed.xml' } },
  icons: { icon: '/icon.png', other: [{ rel: 'mask-icon', url: '/mask.svg' }] },
  robots: { index: true, notranslate: true },
};

export async function generateMetadata({ params, query: searchParams }: MetadataContext): Promise<Metadata> {
  const { slug } = await params;
  const { ref } = await searchParams;
  const post = await getPost(slug);
  if (!post) notFound();
  // TODO(gio-migrate): metadata field GioJS doesn't render: appleWebApp (no GioJS equivalent: render those tags in the root layout's <head>, or drop them)
  return {
    title: post.title,
    description: ref ? `${post.excerpt} (via ${ref})` : post.excerpt,
    appleWebApp: { capable: true },
  };
}

export const revalidate = false;

export default function Post() {
  return <article />;
}

declare function getPost(slug: string): Promise<{ title: string; excerpt: string } | null>;
