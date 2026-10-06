/**
 * tests/integration/fixture/app/articles/[id]/page.tsx
 *
 * On-demand revalidation fixture: cached for 5 minutes, tagged statically
 * (`articles`, every article) and per render from getServerSideProps
 * (`article:<id>`). POST /api/articles/<id> (the route.ts under app/api)
 * publishes a new version and purges by tag or path, so the next request
 * must render it instead of serving the cached one.
 */
import React from 'react';

export const revalidate = 300;
export const tags = ['articles'];

interface ArticleProps { id: string; version: number; }

/** Shared through globalThis with the route.ts that publishes versions. */
function versions(): Map<string, number> {
  const holder = globalThis as { __gioFixtureArticles?: Map<string, number> };
  holder.__gioFixtureArticles ??= new Map();
  return holder.__gioFixtureArticles;
}

export async function getServerSideProps(
  ctx: { params: Record<string, string> },
): Promise<{ props: ArticleProps; tags: string[] }> {
  const id = ctx.params['id'] ?? '';
  return { props: { id, version: versions().get(id) ?? 0 }, tags: [`article:${id}`] };
}

export default function Article({ id, version }: ArticleProps): React.JSX.Element {
  return <p>{`FIXTURE_ARTICLE id=[${id}] version=[${version}]`}</p>;
}
