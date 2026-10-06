/**
 * tests/integration/fixture/app/feed/page.tsx
 *
 * loading.tsx fixture: the page itself suspends for ~800ms (it has no
 * Suspense boundary of its own), so app/feed/loading.tsx is what streams in
 * the first bytes. Uncacheable (no revalidate), so the render streams. The
 * gate map is keyed by a per-request nonce so every request suspends.
 */
import React from 'react';

const LATE_DELAY_MS = 800;

interface Gate { done: boolean; promise: Promise<void>; }
const gates = new Map<string, Gate>();

function gateFor(nonce: string): Gate {
  const existing = gates.get(nonce);
  if (existing !== undefined) return existing;
  const gate: Gate = { done: false, promise: Promise.resolve() };
  gate.promise = new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      gate.done = true;
      resolve();
      const cleanup = setTimeout(() => gates.delete(nonce), 10_000);
      cleanup.unref?.();
    }, LATE_DELAY_MS);
    timer.unref?.();
  });
  gates.set(nonce, gate);
  return gate;
}

interface FeedProps { nonce: string; }

export default function Feed({ nonce }: FeedProps): React.JSX.Element {
  const gate = gateFor(nonce);
  if (!gate.done) throw gate.promise;
  return <p>FIXTURE_FEED_CONTENT</p>;
}

export async function getServerSideProps(): Promise<{ props: FeedProps }> {
  return { props: { nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}` } };
}
