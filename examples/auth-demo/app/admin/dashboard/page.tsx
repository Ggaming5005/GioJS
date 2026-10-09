import React from 'react';
import type { GetServerSideProps } from '@gio.js/core';
import { sessions } from '../../../lib/session.server.ts';

interface Props {
  name: string;
}

// Reached only with a valid session: the require_session guard in gio.toml
// checks it in Rust first. Reading it through ctx.cookies marks this render
// personal, so one user's dashboard is never cached for another.
export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const session = sessions.getSession(ctx);
  return { props: { name: session.get('name') ?? 'unknown' } };
};

export default function AdminDashboard({ name }: Props): React.JSX.Element {
  return (
    <html>
      <head><title>Admin Dashboard</title></head>
      <body>
        <h1>Admin Dashboard</h1>
        <p>Signed in as <strong>{name}</strong>.</p>
        <form method="post" action="/api/logout">
          <button type="submit">Log out</button>
        </form>
        <p><a href="/">← Back to home</a></p>
      </body>
    </html>
  );
}
