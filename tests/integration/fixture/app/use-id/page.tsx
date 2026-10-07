/**
 * tests/integration/fixture/app/use-id/page.tsx
 *
 * useId across the hydration boundary: labelled fields under the fixture's
 * root layout (which never hydrates and puts #__gio deep in the document),
 * one of them inside a Suspense boundary that streams in after the shell.
 * Each field shows the id the browser computed once it mounted, next to the
 * one the server put on its <input> - hydrate-page.mjs compares them.
 * Uncacheable, so the render streams; the gate is per request (a nonce from
 * getServerSideProps) so every request suspends.
 */
import React, { Suspense } from 'react';

const LATE_DELAY_MS = 150;

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

function Field({ name }: { name: string }): React.JSX.Element {
  const id = React.useId();
  const hint = React.useId();
  const [clientId, setClientId] = React.useState('');
  React.useEffect(() => setClientId(`${id} ${hint}`), [id, hint]);
  return (
    <p>
      <label htmlFor={id}>{name}</label>
      <input id={id} name={name} aria-describedby={hint} />
      <small id={hint}>USE_ID_HINT_{name}</small>
      <output data-field={name}>{clientId}</output>
    </p>
  );
}

function LateField({ nonce }: { nonce: string }): React.JSX.Element {
  // Server only: the browser hydrates the content the stream delivered.
  if (typeof window === 'undefined') {
    const gate = gateFor(nonce);
    if (!gate.done) throw gate.promise;
  }
  return <Field name="late" />;
}

interface UseIdProps { nonce: string; }

export default function UseIdPage({ nonce }: UseIdProps): React.JSX.Element {
  return (
    <main>
      <h1>USE_ID_FIXTURE</h1>
      <form>
        <Field name="email" />
        {['first', 'second'].map(name => <Field key={name} name={name} />)}
        <Suspense fallback={<p>USE_ID_FALLBACK</p>}>
          <LateField nonce={nonce} />
        </Suspense>
      </form>
    </main>
  );
}

export async function getServerSideProps(): Promise<{ props: UseIdProps }> {
  return { props: { nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}` } };
}
