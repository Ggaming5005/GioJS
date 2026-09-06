/**
 * tests/integration/fixture/app/ppr/page.tsx
 *
 * PPR fixture: `revalidate` + `shell = 'cache'` makes the pre-Suspense shell
 * cacheable while the hole resolves after ~600ms and renders the per-request
 * `who` cookie. The shell markup is identical for every visitor (the PPR
 * contract); the hole is personalized because skipShell renders rerun
 * getServerSideProps with the requester's cookies. The gate map is keyed by
 * a per-request nonce so every render suspends.
 */
import React, { Suspense } from 'react';

export const revalidate = 60;
export const shell = 'cache';

const HOLE_DELAY_MS = 600;

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
    }, HOLE_DELAY_MS);
    timer.unref?.();
  });
  gates.set(nonce, gate);
  return gate;
}

interface PprProps { nonce: string; who: string; }

function Hole({ nonce, who }: PprProps): React.JSX.Element {
  const gate = gateFor(nonce);
  if (!gate.done) throw gate.promise;
  return <p>{`PPR_FIXTURE_HOLE who=${who}`}</p>;
}

export default function Ppr({ nonce, who }: PprProps): React.JSX.Element {
  return (
    <main>
      <h1>PPR_FIXTURE_SHELL</h1>
      <Suspense fallback={<p>PPR_FIXTURE_FALLBACK</p>}>
        <Hole nonce={nonce} who={who} />
      </Suspense>
    </main>
  );
}

interface PprGsspContext { cookies: Record<string, string>; }

export async function getServerSideProps(ctx: PprGsspContext): Promise<{ props: PprProps }> {
  return {
    props: {
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      who: ctx.cookies['who'] ?? 'anon',
    },
  };
}
