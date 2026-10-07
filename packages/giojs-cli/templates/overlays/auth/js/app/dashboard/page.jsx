import React from 'react';
import { GioForm } from '@gio.js/react';
import { sessions } from '../../lib/session.server';

/** @type {import('@gio.js/core').Metadata} */
export const metadata = { title: 'Dashboard' };

// Only reached with a valid session: the require_session guard in gio.toml
// checks the cookie in Rust and sends everyone else to /login. Reading the
// session (ctx.cookies) also marks this render personal, so it is never
// cached and shown to someone else.
/** @type {import('@gio.js/core').GetServerSideProps<{ email: string }>} */
export const getServerSideProps = async (ctx) => {
  const session = sessions.getSession(ctx);
  return { props: { email: session.get('email') ?? 'unknown' } };
};

/** @param {{ email: string }} props */
export default function DashboardPage({ email }) {
  return (
    <section className="gio-container">
      <div className="gio-prose">
        <span className="gio-kicker">Protected</span>
        <h1>Dashboard</h1>
        <p>
          Signed in as <strong>{email}</strong>. Everything under <code>/dashboard</code> needs a
          session - see <code>[[guards]]</code> in <code>gio.toml</code>.
        </p>
        <GioForm action="/logout">
          <button type="submit" className="gio-btn gio-btn--secondary">Log out</button>
        </GioForm>
      </div>
    </section>
  );
}
