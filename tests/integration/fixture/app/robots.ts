/**
 * tests/integration/fixture/app/robots.ts
 *
 * Shadowed on purpose: public/robots.txt is served before any request
 * reaches the worker, so this module never runs and the server warns about
 * it at startup.
 */
import type { MetadataRoute } from '../../../../packages/giojs-core/src/public.ts';

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
