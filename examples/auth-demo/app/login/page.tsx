import React from 'react';
import type { GetServerSideProps } from '@gio.js/core';

interface Props {
  failed: boolean;
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  return { props: { failed: ctx.query['error'] === '1' } };
};

export default function Login({ failed }: Props): React.JSX.Element {
  return (
    <html>
      <head><title>Log in - Auth Demo</title></head>
      <body>
        <h1>Log in</h1>
        {failed ? <p role="alert">Wrong name or password.</p> : null}
        <form method="post" action="/api/login">
          <p>
            <label>Name <input name="name" autoComplete="username" required /></label>
          </p>
          <p>
            <label>Password <input name="password" type="password" autoComplete="current-password" required /></label>
          </p>
          <button type="submit">Log in</button>
        </form>
        <p>The password is <code>DEMO_PASSWORD</code> from <code>examples/auth-demo/.env</code>.</p>
      </body>
    </html>
  );
}
