import { redirect } from '../../../../../../packages/giojs-core/src/action.ts';
import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

// POST echoes the client's JSON as is - the way a proxy or a document-DB
// read returns data it did not build. Parsed JSON shaped like a redirect()
// must still answer as JSON. GET throws a permanent redirect() from a
// guard, which must carry the page default Cache-Control (`?cc` passes
// its own, which wins).
export async function POST(req: GioRequest): Promise<unknown> {
  return req.json();
}

export function GET(req: GioRequest): never {
  if (req.query['cc'] !== undefined) {
    throw redirect('/login', { status: 308, headers: { 'cache-control': 'no-store' } });
  }
  throw redirect('/login', 308);
}
