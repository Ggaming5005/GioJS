/**
 * tests/integration/fixture/app/sitemap.ts
 *
 * Served at /sitemap.xml by the worker (no public/sitemap.xml exists).
 * No revalidate export: cached for the default hour.
 */
import type { MetadataRoute } from '../../../../packages/giojs-core/src/public.ts';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return [
    { url: 'https://fixture.example/', changeFrequency: 'daily', priority: 1 },
    { url: 'https://fixture.example/seo?a=1&b=2', lastModified: '2026-01-01' },
  ];
}
