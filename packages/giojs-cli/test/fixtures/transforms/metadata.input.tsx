import type { Metadata, ResolvingMetadata } from 'next';
import { notFound } from 'next/navigation';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ ref?: string }> };

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

export async function generateMetadata({ params, searchParams }: Props, parent: ResolvingMetadata): Promise<Metadata> {
  const { slug } = await params;
  const { ref } = await searchParams;
  const post = await getPost(slug);
  if (!post) notFound();
  return {
    title: post.title,
    description: ref ? `${post.excerpt} (via ${ref})` : post.excerpt,
    appleWebApp: { capable: true },
  };
}

export const dynamic = 'force-static';

export default function Post() {
  return <article />;
}

declare function getPost(slug: string): Promise<{ title: string; excerpt: string } | null>;
