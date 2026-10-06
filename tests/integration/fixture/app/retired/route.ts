/**
 * tests/integration/fixture/app/retired/route.ts
 *
 * POST retires the page beside it: its getServerSideProps answers
 * `{ notFound: true }` from then on. GET falls through to the page.
 */
export function POST(): unknown {
  (globalThis as { __gioFixtureRetired?: boolean }).__gioFixtureRetired = true;
  return { retired: true };
}
