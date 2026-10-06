/**
 * tests/integration/fixture/app/boom/page.tsx
 *
 * Always fails in getServerSideProps with a message that must never reach a
 * production response (the fixture has no app/error.*, so Rust renders the
 * error page). The harness asserts the page shows only an error reference
 * and that the server log carries the real message under that reference.
 */
import React from 'react';

export async function getServerSideProps(): Promise<never> {
  throw new Error('FIXTURE_SECRET_FAILURE postgres://admin:hunter2@db');
}

export default function Boom(): React.JSX.Element {
  return <p>unreachable</p>;
}
