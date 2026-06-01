export default function Home(): React.JSX.Element {
  return (
    <html>
      <head><title>Auth Demo</title></head>
      <body>
        <h1>Auth Demo</h1>
        <p>
          <a href="/admin/dashboard">Go to admin dashboard (requires session cookie)</a>
        </p>
        <p>
          To log in, set cookie: <code>session=valid</code>
        </p>
      </body>
    </html>
  );
}

import React from 'react';
