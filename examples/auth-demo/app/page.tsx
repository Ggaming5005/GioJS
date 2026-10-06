import React from 'react';

export default function Home(): React.JSX.Element {
  return (
    <html>
      <head><title>Auth Demo</title></head>
      <body>
        <h1>Auth Demo</h1>
        <p>
          <a href="/admin/dashboard">Go to the admin dashboard</a> (requires a session -
          without one you are sent to the login page)
        </p>
        <p>
          <a href="/login">Log in</a>
        </p>
      </body>
    </html>
  );
}
