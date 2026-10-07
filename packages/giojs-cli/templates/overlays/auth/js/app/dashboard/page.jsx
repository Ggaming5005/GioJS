import React from 'react';
import { redirect } from '@gio.js/core';
import { GioForm } from '@gio.js/react';
import { sessions } from '../../lib/session.server';

/** @type {import('@gio.js/core').Metadata} */
export const metadata = { title: 'Dashboard' };

// The require_session guard in gio.toml checks the cookie in Rust and sends
// everyone without a valid session to /login before Node runs. The page
// checks too, so it stays protected if the guard is removed or the project
// has none. Reading the session (ctx.cookies) also marks this render
// personal, so it is never cached and shown to someone else.
/** @type {import('@gio.js/core').GetServerSideProps<{ email: string }>} */
export const getServerSideProps = async (ctx) => {
  const email = sessions.getSession(ctx).get('email');
  if (email === undefined) return redirect('/login');
  return { props: { email } };
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
