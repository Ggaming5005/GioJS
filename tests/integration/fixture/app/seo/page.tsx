/**
 * tests/integration/fixture/app/seo/page.tsx
 *
 * Static metadata (templated by the layout) plus JSON-LD whose data tries
 * to break out of its script element.
 */
import React from 'react';
import type { Metadata } from '../../../../../packages/giojs-core/src/public.ts';
import { JsonLd } from '../../../../../packages/giojs-react/src/JsonLd.tsx';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Metadata Page',
  alternates: { canonical: '/seo' },
  openGraph: { title: 'SEO_FIXTURE_OG_TITLE', images: [{ url: '/og.png', width: 1200, height: 630 }] },
  twitter: { card: 'summary_large_image' },
};

export default function SeoPage(): React.JSX.Element {
  return (
    <main>
      <h1>SEO_FIXTURE_PAGE</h1>
      <JsonLd data={{ '@context': 'https://schema.org', '@type': 'WebPage', name: '</script><b>SEO_LD</b>' }} />
    </main>
  );
}
