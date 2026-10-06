/**
 * tests/integration/fixture/app/dashboard/error.tsx
 *
 * Nested error file: answers (status 500) for failures below app/dashboard,
 * inside the dashboard layout, and is the client error boundary of the
 * dashboard pages' hydrated tree.
 */
import React from 'react';

interface DashboardErrorProps {
  error: { message: string; digest?: string };
  reset?: () => void;
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  return (
    <section>
      <h1>FIXTURE_DASHBOARD_ERROR</h1>
      <p>{`message=${error.message}`}</p>
      {error.digest !== undefined && <p>{`ref=${error.digest}`}</p>}
      {reset !== undefined && <button onClick={reset}>Try again</button>}
    </section>
  );
}
