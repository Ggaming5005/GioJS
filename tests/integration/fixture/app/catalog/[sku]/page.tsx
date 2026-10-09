/**
 * tests/integration/fixture/app/catalog/[sku]/page.tsx
 *
 * notFound() fixture: `gone` returns `{ notFound: true }` from
 * getServerSideProps and `missing` calls notFound() while rendering; both
 * must answer 404 with app/catalog/not-found.tsx inside the catalog layout.
 * `revalidate` makes the found pages cacheable - the 404s must never be.
 */
import React from 'react';
import { notFound } from '../../../../../../packages/giojs-core/src/public.ts';

export const revalidate = 60;

interface ItemProps { sku: string; }

export default function Item({ sku }: ItemProps): React.JSX.Element {
  if (sku === 'missing') notFound();
  return <p>{`FIXTURE_CATALOG_ITEM sku=[${sku}]`}</p>;
}

export async function getServerSideProps(
  ctx: { params: Record<string, string> },
): Promise<{ props: ItemProps } | { notFound: true }> {
  const sku = ctx.params['sku'] ?? '';
  if (sku === 'gone') return { notFound: true };
  return { props: { sku } };
}
