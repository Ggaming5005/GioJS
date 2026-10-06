/**
 * tests/integration/fixture/app/retired/page.tsx
 *
 * A cached page that later answers notFound(): POST /retired (the route.ts
 * beside it) retires it. The 1s revalidate puts the cached copy in the
 * stale-while-revalidate window quickly; the background refresh then gets
 * the 404, and the stale copy must be evicted instead of being served for
 * the rest of the window.
 */
import React from 'react';

export const revalidate = 1;

interface RetiredProps { renderedAt: number; }

export async function getServerSideProps(): Promise<{ props: RetiredProps } | { notFound: true }> {
  if ((globalThis as { __gioFixtureRetired?: boolean }).__gioFixtureRetired === true) {
    return { notFound: true };
  }
  return { props: { renderedAt: Date.now() } };
}

export default function Retired({ renderedAt }: RetiredProps): React.JSX.Element {
  return <p>{`FIXTURE_RETIRED_PAGE rendered_at=${renderedAt}`}</p>;
}
