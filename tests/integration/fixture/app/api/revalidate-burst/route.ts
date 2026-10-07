/**
 * tests/integration/fixture/app/api/revalidate-burst/route.ts
 *
 * Purges a batch the natural way: revalidateTag takes one tag, so `?n=`
 * parallel calls under Promise.all - more than the 64 purges Rust queues
 * per worker. All but one purge tags nothing; the last is
 * `article:<?id=>`, so the test sees a real purge among them. Answers with
 * how many calls the server confirmed.
 */
import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';
import { revalidateTag } from '../../../../../../packages/giojs-core/src/public.ts';

export async function POST(req: GioRequest): Promise<unknown> {
  const n = Math.min(Math.max(Number(req.query['n']) || 300, 1), 2_000);
  const tags = Array.from({ length: n - 1 }, (_, i) => `burst:${i}`);
  tags.push(`article:${req.query['id'] ?? ''}`);
  const results = await Promise.all(tags.map(tag => revalidateTag(tag)));
  const failed = results.filter(result => !result.ok);
  return {
    ok: results.length - failed.length,
    failed: failed.length,
    errors: [...new Set(failed.map(result => result.error))],
    purged: results.reduce((sum, result) => sum + result.purged, 0),
  };
}
