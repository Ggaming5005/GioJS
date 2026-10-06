/**
 * tests/integration/fixture/app/seo/streamed/page.tsx
 *
 * A streamed (uncacheable, Suspense) page with metadata: the tags must be
 * in the head of the first flush, before the suspended content arrives.
 */
import React, { Suspense } from 'react';
import type { Metadata } from '../../../../../../packages/giojs-core/src/public.ts';

export const metadata: Metadata = { title: 'Streamed', robots: { index: false } };

let pending: Promise<void> | null = null;
let ready = false;

function Late(): React.JSX.Element {
  if (!ready) {
    pending ??= new Promise<void>(resolve =>
      setTimeout(() => {
        ready = true;
        resolve();
      }, 150),
    );
    throw pending;
  }
  // Reset for the next request so every render suspends again.
  ready = false;
  pending = null;
  return <p>SEO_STREAMED_LATE</p>;
}

export default function Streamed(): React.JSX.Element {
  return (
    <main>
      <Suspense fallback={<p>SEO_STREAMED_FALLBACK</p>}>
        <Late />
      </Suspense>
    </main>
  );
}
