/**
 * docs-site/components/site-metadata.ts
 *
 * The site-wide head metadata: the root layout exports it, and the docs
 * layout reuses the share card per page (its own url). The framework fills
 * og:title and og:description from the page's own title and description
 * when the openGraph block leaves them out, and X falls back to those Open
 * Graph tags - so only the landing page and /releases carry the site-wide
 * strings below.
 */
import type { OpenGraphMetadata } from '@gio.js/core';

export const SITE_DESCRIPTION =
  'GioJS - the Rust-powered React framework. Self-hosted React at Vercel speed: HTTP/2, image ' +
  'optimization, ISR caching, and compression in compiled Rust.';

/** The share card without a title or description: each page brings its own. */
export const SHARE_CARD: OpenGraphMetadata = {
  type: 'website',
  siteName: 'GioJS',
  images: [{ url: '/public/og.png', width: 1200, height: 630, alt: 'GioJS - self-hosted React at Vercel speed' }],
};

export const SITE_OPEN_GRAPH: OpenGraphMetadata = {
  ...SHARE_CARD,
  url: '/',
  title: 'GioJS - the Rust-powered React framework',
  description:
    'Self-hosted React at Vercel speed. HTTP/2, image optimization, ISR caching, and compression in ' +
    'compiled Rust - deploy anywhere.',
};
