/**
 * tests/integration/fixture/app/dashboard/page.tsx
 *
 * Behind a middleware.ts requireSession guard. Exports `revalidate` on
 * purpose: reading the session goes through ctx.cookies, which marks the
 * render personal, so one user's dashboard is never cached for the next.
 */
import React from 'react';
import { sessions } from '../../lib/session.server.ts';

export const revalidate = 60;

interface DashboardProps { user: string; }

export async function getServerSideProps(
  ctx: { cookies: Record<string, string> },
): Promise<{ props: DashboardProps }> {
  return { props: { user: sessions.getSession(ctx).get('userId') ?? 'anonymous' } };
}

export default function Dashboard({ user }: DashboardProps): React.JSX.Element {
  return <p>{`INTEGRATION_FIXTURE_DASHBOARD user=${user}`}</p>;
}
