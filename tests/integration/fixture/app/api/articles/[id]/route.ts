/**
 * tests/integration/fixture/app/api/articles/[id]/route.ts
 *
 * Publishes a new version of an article, then purges the cached page the
 * way the `by` query names: `tag` (revalidateTag('article:<id>')), `path`
 * (revalidatePath('/articles/<id>')), `decoded` (the same with the id
 * percent-decoded, as a CMS would know the slug), `all`
 * (revalidateTag('articles'), the page's static tag) or `prefix`
 * (revalidatePath('/articles', prefix)).
 * Answers with the RevalidateResult, so the test sees the purge count.
 */
import type { GioRequest } from '../../../../../../../packages/giojs-core/src/context.ts';
import {
  revalidatePath,
  revalidateTag,
} from '../../../../../../../packages/giojs-core/src/public.ts';

function versions(): Map<string, number> {
  const holder = globalThis as { __gioFixtureArticles?: Map<string, number> };
  holder.__gioFixtureArticles ??= new Map();
  return holder.__gioFixtureArticles;
}

export async function POST(req: GioRequest): Promise<unknown> {
  const id = req.params['id'] ?? '';
  versions().set(id, (versions().get(id) ?? 0) + 1);
  switch (req.query['by']) {
    case 'path':
      return revalidatePath(`/articles/${id}`);
    case 'decoded':
      return revalidatePath(`/articles/${decodeURIComponent(id)}`);
    case 'prefix':
      return revalidatePath('/articles', { type: 'prefix' });
    case 'all':
      return revalidateTag('articles');
    default:
      return revalidateTag(`article:${id}`);
  }
}
