import React from 'react';

interface Props {
  params: Record<string, string>;
}

export default function AdminDashboard({ params: _params }: Props): React.JSX.Element {
  return (
    <html>
      <head><title>Admin Dashboard</title></head>
      <body>
        <h1>Admin Dashboard</h1>
        <p>You are authenticated. Only requests with <code>session=valid</code> cookie reach here.</p>
        <p><a href="/">← Back to home</a></p>
      </body>
    </html>
  );
}
