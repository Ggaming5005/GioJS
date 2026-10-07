import React from 'react';
import { redirect, type ActionArgs, type GetServerSideProps, type Metadata, type WithActionData } from '@gio.js/core';
import { GioForm, useGioFormState } from '@gio.js/react';
import { verifyCredentials } from '@/lib/auth.server';
import { sessions } from '@/lib/session.server';
import '../../components/forms.css';

export const metadata: Metadata = { title: 'Log in' };

// Already logged in: go straight to the dashboard.
export const getServerSideProps: GetServerSideProps = async ctx => {
  if (sessions.getSession(ctx).has('email')) return redirect('/dashboard');
  return { props: {} };
};

// The form posts here. No CSRF token needed: the GioJS server refuses
// cross-site POSTs (403) before an action runs, and the session cookie is
// SameSite=Lax. gio.toml rate-limits /login against password guessing.
export async function action(req: ActionArgs) {
  const form = await req.formData();
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const email = field('email').trim();
  if (!verifyCredentials(email, field('password'))) {
    return { status: 422, data: { error: 'Wrong email or password.', email } };
  }
  const session = sessions.getSession(req);
  session.set('email', email);
  return redirect('/dashboard', { headers: { 'set-cookie': sessions.commitSession(session) } });
}

function SubmitButton(): React.JSX.Element {
  const { pending } = useGioFormState();
  return (
    <button type="submit" className="gio-btn gio-btn--primary" disabled={pending}>
      {pending ? 'Logging in…' : 'Log in'}
    </button>
  );
}

export default function LoginPage({ actionData }: WithActionData<typeof action>): React.JSX.Element {
  return (
    <section className="gio-container">
      <div className="gio-prose">
        <span className="gio-kicker">Authentication</span>
        <h1>Log in</h1>
        <p>
          The demo user is <code>DEMO_EMAIL</code> / <code>DEMO_PASSWORD</code> from{' '}
          <code>.env.development</code>.
        </p>
        <GioForm className="gio-form">
          {actionData ? <p className="gio-form__error" role="alert">{actionData.error}</p> : null}
          <label className="gio-field">
            Email
            <input name="email" type="email" autoComplete="username" defaultValue={actionData?.email} required />
          </label>
          <label className="gio-field">
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <SubmitButton />
        </GioForm>
      </div>
    </section>
  );
}
