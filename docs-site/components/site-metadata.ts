/**
 * docs-site/components/site-metadata.ts
 *
 * The site-wide head metadata: the root layout exports it, and the docs
 * layout extends the Open Graph block per page (its own url and title).
 */
import type { OpenGraphMetadata } from '@gio.js/core';

export const SITE_DESCRIPTION =
  'GioJS - the Rust-powered React framework. Self-hosted React at Vercel speed: HTTP/2, image ' +
  'optimization, ISR caching, and compression in compiled Rust.';

export const SITE_OPEN_GRAPH: OpenGraphMetadata = {
  type: 'website',
  siteName: 'GioJS',
  url: '/',
  title: 'GioJS - the Rust-powered React framework',
  description:
    'Self-hosted React at Vercel speed. HTTP/2, image optimization, ISR caching, and compression in ' +
    'compiled Rust - deploy anywhere.',
  images: [{ url: '/public/og.png', width: 1200, height: 630, alt: 'GioJS - self-hosted React at Vercel speed' }],
};
