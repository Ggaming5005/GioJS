/**
 * tests/integration/fixture/app/slow/page.tsx
 *
 * Streaming-SSR fixture: uncacheable (no revalidate export) so the render
 * streams, with a Suspense boundary whose content resolves after ~800ms.
 * React flushes the shell immediately and the late chunk afterwards, which
 * the integration harness uses to measure time-to-first-byte vs total time.
 * The gate map is keyed by a per-request nonce so every request suspends.
 */
import React, { Suspense } from 'react';

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

function Late({ nonce }: { nonce: string }): React.JSX.Element {
  const gate = gateFor(nonce);
  if (!gate.done) throw gate.promise;
  return <p>SLOW_FIXTURE_LATE_CONTENT</p>;
}

interface SlowProps { nonce: string; }

export default function Slow({ nonce }: SlowProps): React.JSX.Element {
  return (
    <main>
      <h1>SLOW_FIXTURE_SHELL</h1>
      <Suspense fallback={<p>SLOW_FIXTURE_FALLBACK</p>}>
        <Late nonce={nonce} />
      </Suspense>
    </main>
  );
}

export async function getServerSideProps(): Promise<{ props: SlowProps }> {
  return { props: { nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}` } };
}
