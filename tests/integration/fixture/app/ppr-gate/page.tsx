/**
 * tests/integration/fixture/app/ppr-gate/page.tsx
 *
 * A PPR page whose getServerSideProps answers some visitors with something
 * other than holes: anonymous visitors are redirect()ed to /login, and
 * `who=ghost` gets notFound(). The shell is stored from a signed-in render;
 * on a later shell hit those answers arrive after the shell's 200, and the
 * page must still take the visitor to them.
 */
import React, { Suspense } from 'react';
import { notFound, redirect } from '../../../../../packages/giojs-core/src/public.ts';

export const revalidate = 60;
export const shell = 'cache';

const HOLE_DELAY_MS = 300;

// Keyed by a per-render nonce so every render suspends once.
const resolved = new Set<string>();
const gates = new Map<string, Promise<void>>();

function Hole({ nonce, who }: GateProps): React.JSX.Element {
  if (!resolved.has(nonce)) {
    let gate = gates.get(nonce);
    if (gate === undefined) {
      gate = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolved.add(nonce);
          gates.delete(nonce);
          setTimeout(() => resolved.delete(nonce), 10_000).unref?.();
          resolve();
        }, HOLE_DELAY_MS).unref?.();
      });
      gates.set(nonce, gate);
    }
    throw gate;
  }
  return <p>{`PPR_GATE_HOLE who=${who}`}</p>;
}

interface GateProps { nonce: string; who: string; }

export default function PprGate({ nonce, who }: GateProps): React.JSX.Element {
  return (
    <main>
      <h1>PPR_GATE_SHELL</h1>
      <Suspense fallback={<p>PPR_GATE_FALLBACK</p>}>
        <Hole nonce={nonce} who={who} />
      </Suspense>
    </main>
  );
}

export async function getServerSideProps(
  ctx: { cookies: Record<string, string> },
): Promise<unknown> {
  const who = ctx.cookies['who'];
  if (who === undefined) return redirect('/login?next=/ppr-gate', 303);
  if (who === 'ghost') notFound();
  return { props: { nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`, who } };
}
